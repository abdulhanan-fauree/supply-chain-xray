/**
 * Cached, rate-limited, retrying JSON fetch.
 *
 * Every upstream response is written to data/cache/ keyed by URL, for two
 * reasons: the crawl becomes resumable and cheap to re-run, re-reading from disk
 * rather than re-fetching several thousand documents after a crash or a change to
 * the traversal; and it keeps request volume against registry.npmjs.org and
 * api.osv.dev low, neither being a paid service.
 *
 * The cache is gitignored, running to roughly 190 MB. The committed artifact is
 * data/graph.json, which is what the loader reads, so reproducing the database
 * needs no network access even though rebuilding the dataset does.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CACHE_ROOT = resolve(process.cwd(), "data/cache");

export type FetchStats = {
  hits: number;
  misses: number;
  failures: number;
};

export const stats: FetchStats = { hits: 0, misses: 0, failures: 0 };

function cachePath(namespace: string, key: string): string {
  // Package names contain / and @ and can exceed filesystem limits once
  // encoded, so long keys are hashed with a readable prefix kept for grepping.
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  const name =
    safe.length <= 80 ? safe : `${safe.slice(0, 60)}-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
  return resolve(CACHE_ROOT, namespace, `${name}.json`);
}

function readCache<T>(namespace: string, key: string): T | null {
  const path = cachePath(namespace, key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // Corrupt cache entry: treat as a miss and overwrite.
  }
}

function writeCache(namespace: string, key: string, value: unknown): void {
  const path = cachePath(namespace, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type JsonRequest = {
  url: string;
  /** Cache namespace, i.e. the subdirectory under data/cache/. */
  namespace: string;
  /** Cache key. Defaults to the URL. */
  key?: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: unknown;
  /** 404 is a normal outcome for some registry lookups. */
  treat404AsNull?: boolean;
  retries?: number;
};

/**
 * Returns parsed JSON, or null when the resource is genuinely absent.
 * Throws only after exhausting retries on a retryable failure.
 */
export async function fetchJson<T>(request: JsonRequest): Promise<T | null> {
  const key = request.key ?? request.url;
  const cached = readCache<{ found: boolean; data: T }>(request.namespace, key);
  if (cached) {
    stats.hits += 1;
    return cached.found ? cached.data : null;
  }

  const retries = request.retries ?? 4;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      // Exponential backoff with a jittered start, so a burst of parallel
      // workers hitting a 429 does not retry in lockstep.
      await sleep(Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250));
    }
    try {
      const response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers: {
          "user-agent": "supply-chain-xray (take-home project; contact via repo)",
          accept: "application/json",
          ...(request.body ? { "content-type": "application/json" } : {}),
          ...request.headers,
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(45_000),
      });

      if (response.status === 404 && request.treat404AsNull) {
        writeCache(request.namespace, key, { found: false, data: null });
        stats.misses += 1;
        return null;
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`${response.status} ${response.statusText} for ${request.url}`);
        continue; // Retryable.
      }
      if (!response.ok) {
        // 4xx other than 404: retrying will not help.
        throw new Error(`${response.status} ${response.statusText} for ${request.url}`);
      }

      const data = (await response.json()) as T;
      writeCache(request.namespace, key, { found: true, data });
      stats.misses += 1;
      return data;
    } catch (error) {
      lastError = error;
      // Aborts and socket errors are retryable; the loop handles the backoff.
    }
  }

  stats.failures += 1;
  throw new Error(
    `Gave up after ${retries + 1} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Run tasks with bounded concurrency, preserving input order in the output.
 * Small enough to not warrant a dependency, and it keeps the failure semantics
 * explicit: a rejected task rejects the whole batch.
 */
export async function mapLimit<In, Out>(
  items: readonly In[],
  limit: number,
  worker: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
