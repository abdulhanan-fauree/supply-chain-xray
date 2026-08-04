import neo4j, { Driver, Session, RecordShape } from "neo4j-driver";
import { readEnv, requireEnv, type Env } from "./env";

/**
 * Single shared driver for the whole process.
 *
 * The Neo4j driver holds a connection pool and is designed to be created once
 * and reused; creating one per request would exhaust the free tier's 200
 * connection limit. In development Next.js re-evaluates modules on every edit,
 * so the instance is parked on globalThis to survive hot reloads.
 */

const globalForDb = globalThis as unknown as { __cognodbDriver?: Driver };

export type DbErrorKind =
  /** Environment variables missing or malformed. */
  | "unconfigured"
  /** Could not reach the instance: DNS, TLS, network, or the instance is paused. */
  | "unreachable"
  /** Reached the instance but credentials were rejected. */
  | "unauthorized"
  /** Connected fine, but the query itself failed. */
  | "query"
  /** The query took longer than we are willing to wait. */
  | "timeout";

export class DbError extends Error {
  readonly kind: DbErrorKind;
  readonly detail?: string;

  constructor(kind: DbErrorKind, message: string, detail?: string) {
    super(message);
    this.name = "DbError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** Human-readable copy for each failure mode, surfaced directly in the UI. */
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

function classify(error: unknown): DbError {
  if (error instanceof DbError) return error;

  const raw = error as { code?: string; message?: string; name?: string } | undefined;
  const code = raw?.code ?? "";
  const message = raw?.message ?? String(error);

  if (code.includes("Unauthorized") || code.includes("AuthenticationRateLimit")) {
    return new DbError("unauthorized", DB_ERROR_COPY.unauthorized.title, message);
  }
  if (
    raw?.name === "Neo4jError" &&
    (code === "ServiceUnavailable" || code === "SessionExpired")
  ) {
    return new DbError("unreachable", DB_ERROR_COPY.unreachable.title, message);
  }
  // DNS/TLS/socket failures arrive as plain Node errors before Bolt handshakes.
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|certificate|ServiceUnavailable/i.test(message)) {
    return new DbError("unreachable", DB_ERROR_COPY.unreachable.title, message);
  }
  return new DbError("query", DB_ERROR_COPY.query.title, message);
}

function createDriver(env: Env): Driver {
  return neo4j.driver(
    env.COGNODB_URI,
    neo4j.auth.basic(env.COGNODB_USER, env.COGNODB_PASSWORD),
    {
      // Counts and depths come back as plain JS numbers instead of Integer
      // objects. Safe here: nothing in this data model approaches 2^53.
      disableLosslessIntegers: true,
      // The free c0 instance allows 200 connections; a web app needs very few,
      // and keeping the pool small avoids starving the seed script.
      maxConnectionPoolSize: 12,
      // Tuned for how long a person will stare at a loading skeleton before
      // concluding the page is broken. Measured against an unreachable host:
      // the defaults took ~10s to surface the error card, these bring it to
      // ~4.8s. Still generous next to the ~250ms a healthy query needs, but
      // two connection attempts have to fail before we can honestly say the
      // instance is unreachable rather than briefly slow.
      connectionAcquisitionTimeout: 6_000,
      connectionTimeout: 4_000,
      maxTransactionRetryTime: 4_000,
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

  const driver = createDriver(result.env);
  globalForDb.__cognodbDriver = driver;
  return driver;
}

/** For scripts: a driver that fails loudly and is closed by the caller. */
export function createStandaloneDriver(): Driver {
  return createDriver(requireEnv());
}

async function withSession<T>(
  mode: "READ" | "WRITE",
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const driver = getDriver();
  const { COGNODB_DATABASE } = requireEnv();
  const session = driver.session({
    database: COGNODB_DATABASE,
    defaultAccessMode: mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE,
  });
  try {
    return await fn(session);
  } catch (error) {
    throw classify(error);
  } finally {
    await session.close();
  }
}

/**
 * Run a read query and map each record to a typed row.
 *
 * `cypher` is always a static string and every value travels in `params` — the
 * driver sends parameters separately from the query text, so there is no string
 * concatenation and no injection surface anywhere in this codebase.
 */
export async function read<Row>(
  cypher: string,
  params: Record<string, unknown>,
  map: (record: RecordShape) => Row,
  options: { timeoutMs?: number } = {},
): Promise<Row[]> {
  return withSession("READ", async (session) => {
    const result = await session.executeRead((tx) => tx.run(cypher, params), {
      // Server-side ceiling: a runaway traversal is cancelled by the database
      // rather than holding a connection open until the request times out.
      timeout: options.timeoutMs ?? 20_000,
    });
    return result.records.map((record) => map(record.toObject()));
  });
}

/** Convenience for queries that return exactly one row (or none). */
export async function readOne<Row>(
  cypher: string,
  params: Record<string, unknown>,
  map: (record: RecordShape) => Row,
): Promise<Row | null> {
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
  | { ok: true; address: string; version: string }
  | { ok: false; kind: DbErrorKind; title: string; hint: string; detail?: string };

/** Used by the health endpoint and by pages that need to degrade gracefully. */
export async function checkHealth(): Promise<Health> {
  try {
    const driver = getDriver();
    const info = await driver.getServerInfo({ database: requireEnv().COGNODB_DATABASE });
    return {
      ok: true,
      address: info.address ?? "unknown",
      version: info.protocolVersion ? `Bolt ${info.protocolVersion}` : "unknown",
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
