/**
 * Times every query against the live instance.
 *
 * The free c0 instance is burstable 0.5 vCPU with 256 MB of RAM. A traversal
 * that is instant on a laptop can be unusable there, and the only way to know
 * is to measure on the real thing. Anything slower than roughly 1.5s needs
 * rethinking before a page is built on top of it.
 *
 * Run:  npm run bench
 */

import { getGraphTotals, getPortfolio } from "../src/lib/queries/portfolio";
import {
  getAppHeader,
  getBlastRadius,
  getDepthHistogram,
  getLicenseObligations,
  type AppHeader,
  type BlastRadiusEntry,
} from "../src/lib/queries/app-detail";
import { closeDriver, DbError } from "../src/lib/db";
import { describeConnection, requireEnv } from "../src/lib/env";

type Case = { name: string; run: () => Promise<unknown>; summarise: (result: unknown) => string };

const cases: Case[] = [
  {
    name: "Graph totals",
    run: getGraphTotals,
    summarise: (r) => {
      const t = r as Awaited<ReturnType<typeof getGraphTotals>>;
      return `${t.packages} packages, ${t.versions} versions, ${t.dependencies} deps`;
    },
  },
  {
    name: "Portfolio dashboard",
    run: getPortfolio,
    summarise: (r) => {
      const rows = r as Awaited<ReturnType<typeof getPortfolio>>;
      return rows
        .map(
          (row) =>
            `${row.slug}(${row.totalDeps}d/${row.nestingDepth}deep/${row.longestChain}chain/${row.advisories}v)`,
        )
        .join(" ");
    },
  },
  {
    // legacy-admin is the worst case by a wide margin: 207 dependencies, 29 of
    // them vulnerable, 102 advisories. If the detail page is fast for this app
    // it is fast for all of them.
    name: "App header (legacy-admin)",
    run: () => getAppHeader("legacy-admin"),
    summarise: (r) => {
      const h = r as AppHeader | null;
      return h ? `${h.directDeps} direct, ${h.totalDeps} total, ${h.nestingDepth} deep` : "not found";
    },
  },
  {
    name: "Blast radius (legacy-admin)",
    run: () => getBlastRadius("legacy-admin"),
    summarise: (r) => {
      const rows = r as BlastRadiusEntry[];
      const deepest = rows.reduce<BlastRadiusEntry | null>(
        (worst, row) => (!worst || row.depth > worst.depth ? row : worst),
        null,
      );
      return `${rows.length} findings; deepest ${deepest?.depth ?? 0} hops: ${
        deepest?.chain.join(" -> ") ?? "none"
      }`;
    },
  },
  {
    name: "Blast radius (storefront)",
    run: () => getBlastRadius("storefront-web"),
    summarise: (r) => `${(r as BlastRadiusEntry[]).length} findings`,
  },
  {
    name: "Depth histogram",
    run: () => getDepthHistogram("mobile-companion"),
    summarise: (r) =>
      (r as Awaited<ReturnType<typeof getDepthHistogram>>)
        .map((b) => `L${b.depth}:${b.count}`)
        .join(" "),
  },
  {
    name: "License obligations",
    run: () => getLicenseObligations("mobile-companion"),
    summarise: (r) => {
      const rows = r as Awaited<ReturnType<typeof getLicenseObligations>>;
      return rows.length
        ? rows.map((f) => `${f.packageName}(${f.spdxId}@${f.depth})`).slice(0, 4).join(" ")
        : "clean";
    },
  },
];

const RUNS = 5;

async function main() {
  process.stdout.write(`\nBenchmarking ${describeConnection(requireEnv())}\n`);

  // Warm the pool before timing anything. The first query of a process pays for
  // a TLS handshake and a Bolt handshake, which was showing up as ~1s of
  // "query cost" on whichever case happened to run first — a measurement
  // artefact, not something a user of the running app ever pays repeatedly.
  const warmupStarted = Date.now();
  await getGraphTotals();
  process.stdout.write(
    `Connection warmup (TLS + Bolt handshake): ${Date.now() - warmupStarted}ms\n\n`,
  );

  let slowest = 0;
  for (const testCase of cases) {
    const timings: number[] = [];
    let summary = "";
    try {
      for (let run = 0; run < RUNS; run += 1) {
        const started = Date.now();
        const result = await testCase.run();
        timings.push(Date.now() - started);
        if (run === 0) summary = testCase.summarise(result);
      }
    } catch (error) {
      // DbError deliberately carries user-facing copy in `message` and the raw
      // database text in `detail`. A benchmark wants the latter.
      const detail = error instanceof DbError ? error.detail : undefined;
      process.stdout.write(
        `  FAIL  ${testCase.name} — ${error instanceof Error ? error.message : error}\n` +
          (detail ? `        ${detail}\n` : ""),
      );
      continue;
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const best = sorted[0];
    const median = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted[sorted.length - 1];
    slowest = Math.max(slowest, median);
    // Judged on the median: the c0 instance is burstable, so an occasional
    // outlier is CPU credit exhaustion rather than a property of the query.
    const verdict = median > 1500 ? "SLOW" : "ok";
    process.stdout.write(
      `  ${verdict.padEnd(5)} ${testCase.name.padEnd(24)} med ${String(median).padStart(
        5,
      )}ms  (${best}-${worst}ms over ${RUNS})   ${summary}\n`,
    );
  }

  process.stdout.write(
    `\nSlowest median: ${slowest}ms${slowest > 1500 ? " — needs rethinking" : ""}\n\n`,
  );
  await closeDriver();
}

main().catch(async (error) => {
  process.stderr.write(`\nBenchmark failed: ${error instanceof Error ? error.stack : error}\n\n`);
  await closeDriver().catch(() => {});
  process.exit(1);
});
