/**
 * Loads data/graph.json into CognoDB.
 *
 * Run:  npm run seed            (idempotent — safe to re-run)
 *       npm run seed -- --reset (wipe the graph first)
 *
 * Design notes:
 *
 *   - Reads the committed dataset, never the network. Building the dataset and
 *     loading it are separate steps so a registry outage cannot leave a
 *     half-written graph, and a reviewer with no network can still seed.
 *
 *   - Everything is MERGE, so re-running converges rather than duplicating. The
 *     uniqueness constraints in schema.ts are what make that both correct and
 *     fast; they are created before any data is written.
 *
 *   - Every statement is a static string with an $rows parameter carrying a
 *     batch of plain objects. No Cypher is ever assembled from data. Batches are
 *     500 rows because the free c0 instance has 256 MB of RAM and a large UNWIND
 *     builds its whole intermediate result in memory.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Driver, Session } from "neo4j-driver";

import { createStandaloneDriver } from "../src/lib/db";
import { describeConnection, requireEnv } from "../src/lib/env";
import { CONSTRAINTS, INDEXES, OWNED_LABELS } from "./lib/schema";
import type { GraphDataset } from "../src/lib/model";

const BATCH_SIZE = 500;

type Step = {
  label: string;
  rows: Record<string, unknown>[];
  cypher: string;
};

function buildSteps(data: GraphDataset): Step[] {
  return [
    {
      label: "App",
      rows: data.apps as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MERGE (a:App {slug: row.slug})
        SET a.name = row.name, a.description = row.description, a.kind = row.kind`,
    },
    {
      label: "Package",
      rows: data.packages as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MERGE (p:Package {name: row.name})
        SET p.description = row.description,
            p.latestVersion = row.latestVersion,
            p.weeklyDownloads = row.weeklyDownloads,
            p.deprecated = row.deprecated,
            p.repoUrl = row.repoUrl,
            p.homepage = row.homepage`,
    },
    {
      label: "Version",
      rows: data.versions as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MERGE (v:Version {id: row.id})
        SET v.packageName = row.packageName,
            v.version = row.version,
            v.releasesBehind = row.releasesBehind,
            v.isLatest = row.isLatest,
            v.deprecated = row.deprecated`,
    },
    {
      label: "Maintainer",
      rows: data.maintainers as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MERGE (m:Maintainer {npmUser: row.npmUser})`,
    },
    {
      label: "License",
      rows: data.licenses as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MERGE (l:License {spdxId: row.spdxId})
        SET l.category = row.category`,
    },
    {
      label: "Repo",
      rows: data.repos as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MERGE (r:Repo {id: row.id})
        SET r.host = row.host, r.owner = row.owner, r.name = row.name`,
    },
    {
      label: "Vulnerability",
      rows: data.vulnerabilities as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MERGE (v:Vulnerability {osvId: row.osvId})
        SET v.aliases = row.aliases,
            v.severity = row.severity,
            v.cvssVector = row.cvssVector,
            v.summary = row.summary,
            v.details = row.details,
            v.publishedAt = row.publishedAt,
            v.referenceUrl = row.referenceUrl`,
    },
    {
      label: "HAS_VERSION",
      rows: data.hasVersion as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MATCH (p:Package {name: row.packageName})
        MATCH (v:Version {id: row.versionId})
        MERGE (p)-[:HAS_VERSION]->(v)`,
    },
    {
      label: "USES",
      rows: data.uses as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MATCH (a:App {slug: row.appSlug})
        MATCH (v:Version {id: row.versionId})
        MERGE (a)-[u:USES]->(v)
        SET u.range = row.range, u.dev = row.dev`,
    },
    {
      // The materialised closure. See ReachesEdge in model.ts for why it exists:
      // asked live, one shortestPath per (app, dependency) pair times out at 20s
      // on the free instance; one BFS sweep in the crawler is microseconds.
      label: "REACHES",
      rows: data.reaches as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MATCH (a:App {slug: row.appSlug})
        MATCH (v:Version {id: row.versionId})
        MERGE (a)-[r:REACHES]->(v)
        SET r.depth = row.depth`,
    },
    {
      label: "DEPENDS_ON",
      rows: data.dependsOn as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MATCH (from:Version {id: row.fromVersionId})
        MATCH (to:Version {id: row.toVersionId})
        MERGE (from)-[d:DEPENDS_ON]->(to)
        SET d.range = row.range, d.optional = row.optional`,
    },
    {
      label: "LICENSED_UNDER",
      rows: data.licensedUnder as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MATCH (v:Version {id: row.versionId})
        MATCH (l:License {spdxId: row.spdxId})
        MERGE (v)-[:LICENSED_UNDER]->(l)`,
    },
    {
      label: "MAINTAINS",
      rows: data.maintains as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MATCH (m:Maintainer {npmUser: row.npmUser})
        MATCH (p:Package {name: row.packageName})
        MERGE (m)-[:MAINTAINS]->(p)`,
    },
    {
      label: "HOSTED_IN",
      rows: data.hostedIn as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MATCH (p:Package {name: row.packageName})
        MATCH (r:Repo {id: row.repoId})
        MERGE (p)-[:HOSTED_IN]->(r)`,
    },
    {
      label: "AFFECTS",
      rows: data.affects as unknown as Record<string, unknown>[],
      cypher: `
        UNWIND $rows AS row
        MATCH (vuln:Vulnerability {osvId: row.osvId})
        MATCH (v:Version {id: row.versionId})
        MERGE (vuln)-[a:AFFECTS]->(v)
        SET a.vulnerableRange = row.vulnerableRange, a.fixedIn = row.fixedIn`,
    },
  ];
}

async function applySchema(session: Session): Promise<void> {
  process.stdout.write("Schema\n");
  for (const { name, cypher } of [...CONSTRAINTS, ...INDEXES]) {
    await session.run(cypher);
    process.stdout.write(`  ${name}\n`);
  }
}

async function wipe(session: Session): Promise<void> {
  process.stdout.write("Reset\n");
  for (const label of OWNED_LABELS) {
    let total = 0;
    // Batched so the delete itself cannot exhaust 256 MB of instance memory.
    for (;;) {
      const result = await session.run(
        `MATCH (n:${label}) WITH n LIMIT $limit DETACH DELETE n RETURN count(n) AS deleted`,
        { limit: BATCH_SIZE },
      );
      const deleted = (result.records[0]?.get("deleted") as number) ?? 0;
      total += deleted;
      if (deleted === 0) break;
    }
    process.stdout.write(`  ${label}: deleted ${total}\n`);
  }
}

async function runStep(driver: Driver, database: string, step: Step): Promise<void> {
  if (!step.rows.length) {
    process.stdout.write(`  ${step.label.padEnd(16)} 0 rows (skipped)\n`);
    return;
  }

  const started = Date.now();
  let created = 0;

  for (let offset = 0; offset < step.rows.length; offset += BATCH_SIZE) {
    const batch = step.rows.slice(offset, offset + BATCH_SIZE);
    const session = driver.session({ database });
    try {
      const result = await session.executeWrite((tx) => tx.run(step.cypher, { rows: batch }));
      const counters = result.summary.counters.updates();
      created += counters.nodesCreated + counters.relationshipsCreated;
    } finally {
      await session.close();
    }
  }

  const ms = Date.now() - started;
  process.stdout.write(
    `  ${step.label.padEnd(16)} ${String(step.rows.length).padStart(5)} rows -> ${String(
      created,
    ).padStart(5)} created  ${ms}ms\n`,
  );
}

async function verify(session: Session, data: GraphDataset): Promise<boolean> {
  process.stdout.write("\nVerification\n");
  const checks: Array<[string, string, number]> = [
    ["App", "MATCH (n:App) RETURN count(n) AS c", data.apps.length],
    ["Package", "MATCH (n:Package) RETURN count(n) AS c", data.packages.length],
    ["Version", "MATCH (n:Version) RETURN count(n) AS c", data.versions.length],
    ["Maintainer", "MATCH (n:Maintainer) RETURN count(n) AS c", data.maintainers.length],
    ["Vulnerability", "MATCH (n:Vulnerability) RETURN count(n) AS c", data.vulnerabilities.length],
    ["USES", "MATCH ()-[r:USES]->() RETURN count(r) AS c", data.uses.length],
    ["DEPENDS_ON", "MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS c", data.dependsOn.length],
    ["REACHES", "MATCH ()-[r:REACHES]->() RETURN count(r) AS c", data.reaches.length],
    ["AFFECTS", "MATCH ()-[r:AFFECTS]->() RETURN count(r) AS c", data.affects.length],
    ["MAINTAINS", "MATCH ()-[r:MAINTAINS]->() RETURN count(r) AS c", data.maintains.length],
  ];

  let allMatched = true;
  for (const [label, cypher, expected] of checks) {
    const actual = (await session.run(cypher)).records[0]?.get("c") as number;
    const matched = actual === expected;
    if (!matched) allMatched = false;
    process.stdout.write(
      `  ${matched ? "ok  " : "MISMATCH"} ${label.padEnd(16)} ${String(actual).padStart(
        5,
      )} in graph, ${String(expected).padStart(5)} in dataset\n`,
    );
  }
  return allMatched;
}

async function main() {
  const reset = process.argv.includes("--reset");
  const env = requireEnv();

  const datasetPath = resolve(process.cwd(), "data/graph.json");
  let data: GraphDataset;
  try {
    data = JSON.parse(readFileSync(datasetPath, "utf8")) as GraphDataset;
  } catch {
    throw new Error(
      `Could not read ${datasetPath}. Run \`npm run crawl\` first, or check out the committed dataset.`,
    );
  }

  process.stdout.write(
    `\nSeeding ${describeConnection(env)}\n` +
      `Dataset built ${data.generatedAt}: ${data.stats.packages} packages, ` +
      `${data.stats.versions} versions, ${data.stats.dependsOn} dependency edges, ` +
      `${data.stats.vulnerabilities} advisories\n\n`,
  );

  const started = Date.now();
  const driver = createStandaloneDriver();

  try {
    const session = driver.session({ database: env.COGNODB_DATABASE });
    try {
      if (reset) await wipe(session);
      await applySchema(session);
    } finally {
      await session.close();
    }

    process.stdout.write("\nLoad\n");
    // Sequential by design: relationship steps MATCH nodes that earlier steps
    // create, and the instance has half a core. Parallel batches would only
    // contend for it.
    for (const step of buildSteps(data)) {
      await runStep(driver, env.COGNODB_DATABASE, step);
    }

    const verifySession = driver.session({ database: env.COGNODB_DATABASE });
    let matched: boolean;
    try {
      matched = await verify(verifySession, data);
    } finally {
      await verifySession.close();
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (matched) {
      process.stdout.write(`\nGraph loaded and verified in ${seconds}s.\n\n`);
    } else {
      process.stdout.write(
        `\nLoaded in ${seconds}s, but counts do not match the dataset. ` +
          `Re-run with --reset for a clean load.\n\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await driver.close();
  }
}

main().catch((error) => {
  process.stderr.write(`\nSeed failed: ${error instanceof Error ? error.message : error}\n\n`);
  process.exit(1);
});
