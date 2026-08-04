/**
 * CognoDB capability probe.
 *
 * CognoDB speaks openCypher over Bolt and works with the official Neo4j driver,
 * but it is not Neo4j — so before committing the data model and query layer to a
 * feature, we check that the feature actually exists. Every capability this app
 * relies on is listed below; the report is pasted into the README so a reviewer
 * can see exactly which ground we stand on.
 *
 * Run:  npm run probe
 *
 * Safe to run against a live instance: everything it writes is labelled
 * :__Probe and deleted in the final step, even if earlier checks fail.
 */

import { createStandaloneDriver } from "../src/lib/db";
import { describeConnection, requireEnv } from "../src/lib/env";
import type { Session } from "neo4j-driver";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Check = {
  name: string;
  /** Why the application cares. Appears in the report. */
  why: string;
  /**
   * Set when the *expected* outcome is a failure — a documented divergence or a
   * feature we want to prove is absent. These do not count against the run, but
   * if one starts passing that is news worth seeing.
   */
  expectFailure?: boolean;
  run: (session: Session) => Promise<string>;
};

const PROBE_LABEL = "__Probe";

/**
 * PASS/FAIL mean what you expect. AS-EXPECTED is a check that was *supposed* to
 * fail — a documented divergence or an absent feature we rely on being absent.
 * SURPRISE is one of those starting to pass, which is worth reading about.
 */
type Status = "PASS" | "FAIL" | "AS-EXPECTED" | "SURPRISE";

type Result = {
  name: string;
  why: string;
  status: Status;
  note: string;
  ms: number;
};

function toResult(check: Check, ok: boolean, note: string, ms: number): Result {
  const status: Status = check.expectFailure
    ? ok
      ? "SURPRISE"
      : "AS-EXPECTED"
    : ok
      ? "PASS"
      : "FAIL";
  return { name: check.name, why: check.why, status, note, ms };
}

const checks: Check[] = [
  {
    name: "Basic round trip",
    why: "Confirms Bolt handshake, TLS and auth all work.",
    run: async (session) => {
      const result = await session.run("RETURN $greeting AS greeting, 1 + 1 AS sum", {
        greeting: "hello",
      });
      const row = result.records[0];
      return `returned ${row.get("greeting")}/${row.get("sum")}`;
    },
  },
  {
    name: "Server identity",
    why: "Records the Bolt protocol version we are actually negotiating.",
    run: async (session) => {
      const summary = (await session.run("RETURN 1")).summary;
      const agent = summary.server.agent ?? "unknown agent";
      const protocol = summary.server.protocolVersion ?? "unknown";
      return `${agent}, Bolt ${protocol}`;
    },
  },
  {
    name: "Uniqueness constraint",
    why: "The seed script MERGEs packages and versions by key; without a unique constraint, concurrent batches create duplicates.",
    run: async (session) => {
      await session.run(
        `CREATE CONSTRAINT probe_unique IF NOT EXISTS
         FOR (n:${PROBE_LABEL}) REQUIRE n.key IS UNIQUE`,
      );
      return "created (IF NOT EXISTS accepted)";
    },
  },
  {
    name: "Secondary index",
    why: "Package name and vulnerability id lookups must not be full scans on a 0.5 vCPU instance.",
    run: async (session) => {
      await session.run(
        `CREATE INDEX probe_index IF NOT EXISTS FOR (n:${PROBE_LABEL}) ON (n.name)`,
      );
      return "created";
    },
  },
  {
    name: "Schema introspection",
    why: "Lets the reset script drop exactly what the seed script created.",
    run: async (session) => {
      const result = await session.run("SHOW CONSTRAINTS");
      return `SHOW CONSTRAINTS returned ${result.records.length} row(s)`;
    },
  },
  {
    name: "Batched write via UNWIND",
    why: "The whole seeding strategy is UNWIND over batches of rows; row-at-a-time writes would take hours.",
    run: async (session) => {
      const rows = Array.from({ length: 500 }, (_, i) => ({
        key: `probe-${i}`,
        name: `package-${i % 50}`,
        depth: i % 7,
      }));
      const result = await session.run(
        `UNWIND $rows AS row
         MERGE (n:${PROBE_LABEL} {key: row.key})
         SET n.name = row.name, n.depth = row.depth`,
        { rows },
      );
      const { nodesCreated, propertiesSet } = result.summary.counters.updates();
      return `500 rows: ${nodesCreated} nodes created, ${propertiesSet} properties set`;
    },
  },
  {
    name: "Relationship properties",
    why: "DEPENDS_ON carries range/dev/optional, and traversals filter on those mid-walk.",
    run: async (session) => {
      const result = await session.run(
        `UNWIND range(0, 98) AS i
         MATCH (a:${PROBE_LABEL} {key: 'probe-' + toString(i)})
         MATCH (b:${PROBE_LABEL} {key: 'probe-' + toString(i + 1)})
         MERGE (a)-[r:PROBE_DEPENDS_ON]->(b)
         SET r.range = '^1.0.0', r.dev = (i = 3)
         RETURN count(r) AS created`,
        {},
      );
      return `${result.records[0].get("created")} relationships with properties`;
    },
  },
  {
    name: "Variable-length traversal",
    why: "Blast radius is a *1..8 pattern. This is the single most important capability in the app.",
    run: async (session) => {
      const result = await session.run(
        `MATCH (start:${PROBE_LABEL} {key: $startKey})
         MATCH (start)-[:PROBE_DEPENDS_ON*1..8]->(reached)
         RETURN count(DISTINCT reached) AS reached`,
        { startKey: "probe-0" },
      );
      return `reached ${result.records[0].get("reached")} nodes within 8 hops`;
    },
  },
  {
    name: "Edge-property filter inside a traversal",
    why: "Optional dependencies must be excluded partway through a walk, not after it, so 'what if optional deps are not installed' is answerable.",
    run: async (session) => {
      // Note the named path and relationships(p). See the next check for why
      // the more familiar Neo4j spelling is not used anywhere in this codebase.
      //
      // The probe chain flags exactly one edge, probe-3 -> probe-4, so a working
      // filter reaches probe-1..probe-3 and stops: 3 nodes, against 8 unfiltered.
      // Asserting the number matters — a filter that silently matched nothing
      // would also "succeed" if we only checked that the query ran.
      const expected = 3;
      const result = await session.run(
        `MATCH p = (start:${PROBE_LABEL} {key: $startKey})-[:PROBE_DEPENDS_ON*1..8]->(reached)
         WHERE none(r IN relationships(p) WHERE r.dev)
         RETURN count(DISTINCT reached) AS reached`,
        { startKey: "probe-0" },
      );
      const reached = result.records[0].get("reached") as number;
      if (reached !== expected) {
        throw new Error(`filter reached ${reached} nodes, expected exactly ${expected}`);
      }
      return `reached exactly ${reached} of 8 nodes, stopping at the flagged edge`;
    },
  },
  {
    name: "Bare list variable on a variable-length pattern",
    why: "Expected to FAIL. This is a real divergence from Neo4j and the reason every traversal in this codebase names its path.",
    expectFailure: true,
    run: async (session) => {
      // In Neo4j, `-[rels:TYPE*1..8]->` binds rels to a list of relationships.
      // CognoDB binds it to a Path, so none()/size()/any() over it error with
      // "requires list, got *types.Path". The fix is to name the path and call
      // relationships(p) — verified working in the check above. This check is
      // kept deliberately failing so the divergence stays documented and a
      // future CognoDB release that fixes it shows up as a passing row.
      await session.run(
        `MATCH (start:${PROBE_LABEL} {key: $startKey})-[rels:PROBE_DEPENDS_ON*1..8]->(reached)
         WHERE none(r IN rels WHERE r.dev)
         RETURN count(DISTINCT reached) AS reached`,
        { startKey: "probe-0" },
      );
      return "bare list variable IS supported (Neo4j-compatible)";
    },
  },
  {
    name: "shortestPath()",
    why: "Every 'how does A reach B' answer in the UI is a shortest path, rendered as a chain.",
    run: async (session) => {
      const result = await session.run(
        `MATCH (a:${PROBE_LABEL} {key: $from}), (b:${PROBE_LABEL} {key: $to})
         MATCH p = shortestPath((a)-[:PROBE_DEPENDS_ON*1..15]->(b))
         RETURN length(p) AS hops, [n IN nodes(p) | n.key] AS chain`,
        { from: "probe-0", to: "probe-9" },
      );
      if (!result.records.length) return "query ran but found no path";
      const row = result.records[0];
      return `${row.get("hops")} hops: ${(row.get("chain") as string[]).join(" -> ")}`;
    },
  },
  {
    name: "Multi-type variable-length pattern",
    why: "Traversals start on :USES from an App and continue on :DEPENDS_ON, in one pattern.",
    run: async (session) => {
      const result = await session.run(
        `MATCH (start:${PROBE_LABEL} {key: $startKey})
         MATCH (start)-[:PROBE_DEPENDS_ON|PROBE_USES*1..5]->(reached)
         RETURN count(DISTINCT reached) AS reached`,
        { startKey: "probe-0" },
      );
      return `reached ${result.records[0].get("reached")} nodes across two relationship types`;
    },
  },
  {
    name: "CALL {} subquery",
    why: "Per-row aggregation (deps per app, vulns per package) is cleanest as a subquery.",
    run: async (session) => {
      const result = await session.run(
        `MATCH (n:${PROBE_LABEL})
         WHERE n.depth = 0
         CALL {
           WITH n
           MATCH (n)-[:PROBE_DEPENDS_ON]->(m)
           RETURN count(m) AS downstream
         }
         RETURN count(n) AS roots, sum(downstream) AS edges`,
      );
      const row = result.records[0];
      return `${row.get("roots")} roots, ${row.get("edges")} edges via subquery`;
    },
  },
  {
    name: "List/map projection helpers",
    why: "Paths are projected to plain JSON for the UI using list comprehensions and collect().",
    run: async (session) => {
      const result = await session.run(
        `MATCH (n:${PROBE_LABEL})
         WITH n ORDER BY n.key LIMIT 5
         RETURN collect({key: n.key, upper: toUpper(n.name)}) AS items,
                reduce(acc = 0, x IN collect(n.depth) | acc + x) AS depthSum`,
      );
      const row = result.records[0];
      return `collect+reduce ok (depthSum=${row.get("depthSum")}, ${
        (row.get("items") as unknown[]).length
      } items)`;
    },
  },
  {
    name: "Query plan (EXPLAIN)",
    why: "Needed to confirm traversals use indexes rather than scanning, given 256 MB of RAM.",
    run: async (session) => {
      const result = await session.run(
        `EXPLAIN MATCH (n:${PROBE_LABEL} {name: $name}) RETURN n`,
        { name: "package-1" },
      );
      const plan = result.summary.plan;
      return plan ? `plan root: ${plan.operatorType}` : "EXPLAIN accepted but returned no plan";
    },
  },
  {
    name: "APOC availability",
    why: "Expected to be absent. Confirming it lets us guarantee the app is pure openCypher.",
    expectFailure: true,
    run: async (session) => {
      await session.run("RETURN apoc.version() AS version");
      return "APOC IS available (the app still avoids it)";
    },
  },
];

async function main() {
  const env = requireEnv();
  console.log(`\nProbing ${describeConnection(env)}\n`);

  const driver = createStandaloneDriver();
  const results: Result[] = [];

  try {
    for (const check of checks) {
      const session = driver.session({ database: env.COGNODB_DATABASE });
      const started = Date.now();
      try {
        const note = await check.run(session);
        const ms = Date.now() - started;
        results.push({ ...toResult(check, true, note, ms) });
      } catch (error) {
        const ms = Date.now() - started;
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        results.push({ ...toResult(check, false, message, ms) });
      } finally {
        await session.close();
      }
      const last = results[results.length - 1];
      console.log(`  ${last.status.padEnd(11)} ${last.name} — ${last.note}`);
    }
  } finally {
    await cleanup(driver, env.COGNODB_DATABASE);
    await driver.close();
  }

  const reportPath = resolve(process.cwd(), "docs/cognodb-capabilities.md");
  writeFileSync(reportPath, renderReport(results));
  console.log(`\nReport written to ${reportPath}\n`);

  const failed = results.filter((r) => r.status === "FAIL");
  const surprises = results.filter((r) => r.status === "SURPRISE");
  if (failed.length) {
    console.log(
      `${failed.length} capability check(s) failed — do not build on them:\n` +
        failed.map((r) => `  - ${r.name}: ${r.note}`).join("\n") +
        "\n",
    );
  }
  if (surprises.length) {
    console.log(
      `${surprises.length} check(s) expected to fail now pass — the workaround they justify may no longer be needed:\n` +
        surprises.map((r) => `  - ${r.name}`).join("\n") +
        "\n",
    );
  }
  if (!failed.length && !surprises.length) {
    console.log("Every capability this application relies on is present.\n");
  }
}

async function cleanup(driver: ReturnType<typeof createStandaloneDriver>, database: string) {
  const session = driver.session({ database });
  try {
    // Delete in batches so cleanup itself cannot exhaust the instance's memory.
    let deleted = 0;
    for (;;) {
      const result = await session.run(
        `MATCH (n:${PROBE_LABEL}) WITH n LIMIT 1000 DETACH DELETE n RETURN count(n) AS n`,
      );
      const batch = (result.records[0]?.get("n") as number) ?? 0;
      deleted += batch;
      if (batch === 0) break;
    }
    for (const statement of [
      "DROP CONSTRAINT probe_unique IF EXISTS",
      "DROP INDEX probe_index IF EXISTS",
    ]) {
      await session.run(statement).catch(() => {});
    }
    console.log(`\n  Cleaned up ${deleted} probe node(s), dropped probe constraint and index.`);
  } catch (error) {
    console.log(
      `\n  Cleanup failed — remove :${PROBE_LABEL} nodes manually. ${
        error instanceof Error ? error.message : error
      }`,
    );
  } finally {
    await session.close();
  }
}

const STATUS_LABEL: Record<Status, string> = {
  PASS: "supported",
  FAIL: "**NOT supported**",
  "AS-EXPECTED": "absent, as expected",
  SURPRISE: "**now supported** (was not)",
};

function renderReport(results: Result[]): string {
  const escape = (text: string) => text.replace(/\|/g, "\\|");
  return [
    "# CognoDB capability report",
    "",
    "Generated by `npm run probe`. CognoDB speaks openCypher over Bolt and works",
    "with the official Neo4j driver, but it is a reimplementation rather than Neo4j —",
    "it reports itself as `Neo4j/5.26.0` while surfacing Go type names in errors. Every",
    "feature this application depends on is therefore verified against a live instance",
    "before the data model or query layer relies on it.",
    "",
    "| Capability | Result | Detail | Why it matters |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (r) => `| ${escape(r.name)} | ${STATUS_LABEL[r.status]} | ${escape(r.note)} | ${escape(r.why)} |`,
    ),
    "",
    "## The one divergence that shaped the code",
    "",
    "In Neo4j, `MATCH (a)-[rels:TYPE*1..8]->(b)` binds `rels` to a **list of",
    "relationships**, so `none(r IN rels WHERE r.optional)` is the natural way to filter",
    "an edge property partway through a traversal. CognoDB binds that variable to a",
    "**Path**, and list functions reject it:",
    "",
    "```",
    "none() requires list, got *types.Path",
    "size() requires string or list, got *types.Path",
    "```",
    "",
    "The fix is to name the path and go through `relationships()`, which is verified",
    "working above:",
    "",
    "```cypher",
    "MATCH p = (a)-[:DEPENDS_ON*1..8]->(b)",
    "WHERE none(r IN relationships(p) WHERE r.optional)",
    "```",
    "",
    "Every traversal in this codebase names its path for that reason. `nodes(p)`,",
    "`relationships(p)`, `length(p)`, `size()`, `all()`, `any()`, `none()` and `reduce()`",
    "all behave normally once the path is named.",
    "",
  ].join("\n");
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
