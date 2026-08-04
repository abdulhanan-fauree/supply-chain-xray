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
  run: (session: Session) => Promise<string>;
};

const PROBE_LABEL = "__Probe";

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
         SET r.range = '^1.0.0', r.dev = (i % 5 = 0)
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
    why: "Dev-only dependencies must be excluded partway through a walk, not after it.",
    run: async (session) => {
      const result = await session.run(
        `MATCH (start:${PROBE_LABEL} {key: $startKey})
         MATCH (start)-[rels:PROBE_DEPENDS_ON*1..8]->(reached)
         WHERE none(r IN rels WHERE r.dev)
         RETURN count(DISTINCT reached) AS reached`,
        { startKey: "probe-0" },
      );
      return `reached ${result.records[0].get("reached")} nodes excluding dev edges`;
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
  const results: { name: string; why: string; ok: boolean; note: string; ms: number }[] = [];

  try {
    for (const check of checks) {
      const session = driver.session({ database: env.COGNODB_DATABASE });
      const started = Date.now();
      try {
        const note = await check.run(session);
        const ms = Date.now() - started;
        results.push({ name: check.name, why: check.why, ok: true, note, ms });
        console.log(`  PASS  ${check.name} — ${note} (${ms}ms)`);
      } catch (error) {
        const ms = Date.now() - started;
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        results.push({ name: check.name, why: check.why, ok: false, note: message, ms });
        console.log(`  FAIL  ${check.name} — ${message}`);
      } finally {
        await session.close();
      }
    }
  } finally {
    await cleanup(driver, env.COGNODB_DATABASE);
    await driver.close();
  }

  const reportPath = resolve(process.cwd(), "docs/cognodb-capabilities.md");
  writeFileSync(reportPath, renderReport(results));
  console.log(`\nReport written to ${reportPath}\n`);

  const failed = results.filter((r) => !r.ok && r.name !== "APOC availability");
  if (failed.length) {
    console.log(`${failed.length} capability check(s) failed — see report before building on them.\n`);
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

function renderReport(
  results: { name: string; why: string; ok: boolean; note: string; ms: number }[],
): string {
  const lines = [
    "# CognoDB capability report",
    "",
    "Generated by `npm run probe`. CognoDB is openCypher-over-Bolt but is not Neo4j,",
    "so every feature this application depends on is verified against a live instance",
    "before the data model or query layer relies on it.",
    "",
    "| Capability | Result | Detail | Why it matters |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.ok ? "supported" : "**not supported**"} | ${r.note.replace(
          /\|/g,
          "\\|",
        )} | ${r.why} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
