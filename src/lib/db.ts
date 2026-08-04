import neo4j, { type Driver, type Session } from "neo4j-driver";

import { DRIVER } from "./config";
import { Row } from "./records";
import { readEnv, requireEnv, type Env } from "./env";

/**
 * CognoDB access: one shared driver, typed reads, and a failure taxonomy.
 *
 * The driver owns a connection pool and is designed to be created once per
 * process; one per request would exhaust the instance's connection limit. In
 * development Next.js re-evaluates modules on every edit, so the instance is
 * held on globalThis to survive hot reloads.
 */

const globalForDb = globalThis as unknown as { __cognodbDriver?: Driver };

export type DbErrorKind =
  /** Environment variables missing or malformed. */
  | "unconfigured"
  /** Could not reach the instance: DNS, TLS, network, or a paused instance. */
  | "unreachable"
  /** Reached the instance, but the credentials were rejected. */
  | "unauthorized"
  /** Connected, but the query itself failed. */
  | "query"
  /** The query exceeded its time budget. */
  | "timeout";

export class DbError extends Error {
  readonly kind: DbErrorKind;
  /** Raw text from the database, for diagnostics rather than for users. */
  readonly detail?: string;

  constructor(kind: DbErrorKind, message: string, detail?: string) {
    super(message);
    this.name = "DbError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * User-facing copy per failure mode.
 *
 * Written alongside the taxonomy rather than at the call site, so every surface
 * that hits a given failure explains it the same way — and so the explanation is
 * about what to do next rather than what the protocol reported.
 */
export const DB_ERROR_COPY: Record<DbErrorKind, { title: string; hint: string }> = {
  unconfigured: {
    title: "Database not configured",
    hint: "Copy .env.example to .env.local and fill in your CognoDB URI, user and password.",
  },
  unreachable: {
    title: "Can't reach the database",
    hint: "The CognoDB instance may be paused, still provisioning, or blocked by the network. Check the instance status in the CognoDB console.",
  },
  unauthorized: {
    title: "Database rejected the credentials",
    hint: "Confirm COGNODB_USER and COGNODB_PASSWORD match the values from the CognoDB console. The password is only shown at creation time.",
  },
  query: {
    title: "The query failed",
    hint: "This is a bug in the application, not your setup. The details below are what the database reported.",
  },
  timeout: {
    title: "The query took too long",
    hint: "The free tier is a small instance. Try a narrower search, or a smaller traversal depth.",
  },
};

const UNREACHABLE_PATTERN = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|certificate|ServiceUnavailable/i;
const TIMEOUT_PATTERN = /context deadline exceeded|transaction has been terminated|timed out/i;

function classify(error: unknown): DbError {
  if (error instanceof DbError) return error;

  const raw = error as { code?: string; message?: string; name?: string } | undefined;
  const code = raw?.code ?? "";
  const message = raw?.message ?? String(error);

  if (code.includes("Unauthorized") || code.includes("AuthenticationRateLimit")) {
    return new DbError("unauthorized", DB_ERROR_COPY.unauthorized.title, message);
  }
  if (TIMEOUT_PATTERN.test(message)) {
    return new DbError("timeout", DB_ERROR_COPY.timeout.title, message);
  }
  if (code === "ServiceUnavailable" || code === "SessionExpired" || UNREACHABLE_PATTERN.test(message)) {
    // Socket, DNS and TLS failures arrive as plain Node errors, before Bolt.
    return new DbError("unreachable", DB_ERROR_COPY.unreachable.title, message);
  }
  return new DbError("query", DB_ERROR_COPY.query.title, message);
}

function createDriver(env: Env): Driver {
  return neo4j.driver(
    env.COGNODB_URI,
    neo4j.auth.basic(env.COGNODB_USER, env.COGNODB_PASSWORD),
    {
      // Counts and depths arrive as plain JS numbers rather than Integer
      // objects. See Row.number in records.ts.
      disableLosslessIntegers: true,
      maxConnectionPoolSize: DRIVER.maxConnectionPoolSize,
      connectionAcquisitionTimeout: DRIVER.connectionAcquisitionTimeout,
      connectionTimeout: DRIVER.connectionTimeout,
      maxTransactionRetryTime: DRIVER.maxTransactionRetryTime,
    },
  );
}

export function getDriver(): Driver {
  if (globalForDb.__cognodbDriver) return globalForDb.__cognodbDriver;

  const result = readEnv();
  if (!result.ok) {
    throw new DbError(
      "unconfigured",
      DB_ERROR_COPY.unconfigured.title,
      result.problems.join("; "),
    );
  }

  globalForDb.__cognodbDriver = createDriver(result.env);
  return globalForDb.__cognodbDriver;
}

/** A driver for scripts: fails loudly on bad config, closed by the caller. */
export function createStandaloneDriver(): Driver {
  return createDriver(requireEnv());
}

async function withSession<T>(
  mode: "READ" | "WRITE",
  work: (session: Session) => Promise<T>,
): Promise<T> {
  const { COGNODB_DATABASE } = requireEnv();
  const session = getDriver().session({
    database: COGNODB_DATABASE,
    defaultAccessMode: mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE,
  });
  try {
    return await work(session);
  } catch (error) {
    throw classify(error);
  } finally {
    await session.close();
  }
}

/**
 * Run a read query and map each record to a typed row.
 *
 * `cypher` is always a static string and every value travels in `params`. The
 * driver sends parameters separately from the query text, so there is no string
 * concatenation and no injection surface anywhere in this codebase.
 */
export async function read<T>(
  cypher: string,
  params: Record<string, unknown>,
  map: (row: Row) => T,
  options: { timeoutMs?: number } = {},
): Promise<T[]> {
  return withSession("READ", async (session) => {
    const result = await session.executeRead((tx) => tx.run(cypher, params), {
      timeout: options.timeoutMs ?? DRIVER.queryTimeout,
    });
    return result.records.map((record) => map(new Row(record.toObject())));
  });
}

/** For queries that return at most one row. */
export async function readOne<T>(
  cypher: string,
  params: Record<string, unknown>,
  map: (row: Row) => T,
): Promise<T | null> {
  const rows = await read(cypher, params, map);
  return rows[0] ?? null;
}

export async function write(
  cypher: string,
  params: Record<string, unknown>,
): Promise<void> {
  await withSession("WRITE", async (session) => {
    await session.executeWrite((tx) => tx.run(cypher, params));
  });
}

export type Health =
  | { ok: true; address: string; protocol: string }
  | { ok: false; kind: DbErrorKind; title: string; hint: string; detail?: string };

export async function checkHealth(): Promise<Health> {
  try {
    const info = await getDriver().getServerInfo({
      database: requireEnv().COGNODB_DATABASE,
    });
    return {
      ok: true,
      address: info.address ?? "unknown",
      protocol: info.protocolVersion ? `Bolt ${info.protocolVersion}` : "unknown",
    };
  } catch (error) {
    const dbError = classify(error);
    return {
      ok: false,
      kind: dbError.kind,
      title: DB_ERROR_COPY[dbError.kind].title,
      hint: DB_ERROR_COPY[dbError.kind].hint,
      detail: dbError.detail,
    };
  }
}

export async function closeDriver(): Promise<void> {
  if (globalForDb.__cognodbDriver) {
    await globalForDb.__cognodbDriver.close();
    globalForDb.__cognodbDriver = undefined;
  }
}

export type { Row };
