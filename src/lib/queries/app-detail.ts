import { read, readOne } from "../db";
import {
  compareSeverity,
  emptySeverityCounts,
  worstSeverity,
  type SeverityCounts,
} from "../severity";
import { highestVersion, packageNameOf } from "../version-id";
import type { LicenseCategory, Severity } from "../model";
import { SHORTEST_CHAIN_FROM_DECLARED, VULNERABILITY_FIELDS } from "./fragments";

/**
 * Reads for one application's install tree.
 *
 * Three of the queries here return a *path* — the chain of packages connecting
 * something the application declared to something it did not. That is the shape a
 * relational result set cannot represent without reassembly in application code,
 * and it is the reason this project uses a graph.
 */

export type AppHeader = {
  slug: string;
  name: string;
  kind: string;
  description: string;
  directDeps: number;
  devDeps: number;
  totalDeps: number;
  nestingDepth: number;
};

const APP_HEADER = `
MATCH (app:App {slug: $slug})
CALL {
  WITH app
  MATCH (app)-[u:USES]->(:Version)
  RETURN count(CASE WHEN NOT u.dev THEN 1 END) AS directDeps,
         count(CASE WHEN u.dev THEN 1 END)     AS devDeps
}
CALL {
  WITH app
  MATCH (app)-[r:REACHES]->(:Version)
  RETURN count(r) AS totalDeps, max(r.depth) AS nestingDepth
}
RETURN app.slug        AS slug,
       app.name        AS name,
       app.kind        AS kind,
       app.description AS description,
       directDeps, devDeps, totalDeps, nestingDepth
`;

export async function getAppHeader(slug: string): Promise<AppHeader | null> {
  return readOne(APP_HEADER, { slug }, (row) => ({
    slug: row.string("slug"),
    name: row.string("name"),
    kind: row.string("kind"),
    description: row.string("description"),
    directDeps: row.count("directDeps"),
    devDeps: row.count("devDeps"),
    totalDeps: row.count("totalDeps"),
    nestingDepth: row.count("nestingDepth"),
  }));
}

export type BlastRadiusEntry = {
  osvId: string;
  aliases: string[];
  severity: Severity;
  summary: string;
  referenceUrl: string | null;
  /** The vulnerable version in this tree, e.g. `"minimist@0.0.10"`. */
  affectedVersionId: string;
  affectedPackage: string;
  affectedVersion: string;
  vulnerableRange: string;
  fixedIn: string | null;
  /** Hops from the application; 1 means it was declared directly. */
  depth: number;
  /** Shortest chain of version ids from a declared dependency to the target. */
  chain: string[];
  /** Head of that chain — the dependency the application can change. */
  entryPoint: string;
  /** The range the application declares for that dependency. */
  entryRange: string;
};

/**
 * Blast radius, as two queries joined in application code.
 *
 * Findings outnumber affected versions several times over — one version commonly
 * carries a dozen advisories — and every advisory on a version shares the same
 * path. Asking for the path per finding therefore recomputes it repeatedly, which
 * dominated the cost of this page. Paths are fetched once per distinct version
 * and joined against the advisory rows through a map; the two queries run
 * concurrently, so the page waits for the slower rather than the sum.
 *
 * Scoping is what makes path finding affordable at all: the outer match narrows
 * to vulnerable versions over the materialised closure before any traversal
 * begins.
 */
const VULNERABLE_PATHS = `
MATCH (app:App {slug: $slug})-[reach:REACHES]->(dep:Version)<-[:AFFECTS]-(:Vulnerability)
WITH DISTINCT app, dep, reach.depth AS depth
CALL {
${SHORTEST_CHAIN_FROM_DECLARED}
}
RETURN dep.id AS versionId, depth, chain, entryRange
`;

const VULNERABLE_VERSIONS = `
MATCH (app:App {slug: $slug})-[:REACHES]->(dep:Version)
MATCH (vuln:Vulnerability)-[affects:AFFECTS]->(dep)
RETURN ${VULNERABILITY_FIELDS},
       dep.id          AS affectedVersionId,
       dep.packageName AS affectedPackage,
       dep.version     AS affectedVersion,
       affects.vulnerableRange AS vulnerableRange,
       affects.fixedIn AS fixedIn
`;

type ChainInfo = { depth: number; chain: string[]; entryRange: string };

export async function getBlastRadius(slug: string): Promise<BlastRadiusEntry[]> {
  const [paths, findings] = await Promise.all([
    read(VULNERABLE_PATHS, { slug }, (row) => ({
      versionId: row.string("versionId"),
      depth: row.count("depth"),
      chain: row.strings("chain"),
      entryRange: row.stringOrNull("entryRange") ?? "",
    })),
    read(VULNERABLE_VERSIONS, { slug }, (row) => ({
      osvId: row.string("osvId"),
      aliases: row.strings("aliases"),
      severity: row.string("severity") as Severity,
      summary: row.string("summary"),
      referenceUrl: row.stringOrNull("referenceUrl"),
      affectedVersionId: row.string("affectedVersionId"),
      affectedPackage: row.string("affectedPackage"),
      affectedVersion: row.string("affectedVersion"),
      vulnerableRange: row.string("vulnerableRange"),
      fixedIn: row.stringOrNull("fixedIn"),
    })),
  ]);

  const chainByVersion = new Map<string, ChainInfo>(
    paths.map(({ versionId, ...info }) => [versionId, info]),
  );

  const entries = findings.map((finding): BlastRadiusEntry => {
    const info = chainByVersion.get(finding.affectedVersionId);
    const chain = info?.chain ?? [finding.affectedVersionId];
    return {
      ...finding,
      depth: info?.depth ?? chain.length,
      chain,
      entryPoint: chain[0] ?? finding.affectedVersionId,
      entryRange: info?.entryRange ?? "",
    };
  });

  // Sorted here rather than in Cypher: severity is a label, so ordering by it in
  // the query would need a CASE ladder kept in sync with the Severity type.
  return entries.sort(
    (a, b) =>
      compareSeverity(a.severity, b.severity) ||
      a.depth - b.depth ||
      a.affectedVersionId.localeCompare(b.affectedVersionId),
  );
}

/**
 * Findings grouped by the version carrying them.
 *
 * Every advisory on a version shares one path, so a row per advisory repeats the
 * same chain many times over. Grouping presents each version once, with its
 * advisories beneath.
 */
export type AffectedVersionGroup = {
  versionId: string;
  packageName: string;
  version: string;
  depth: number;
  chain: string[];
  entryPoint: string;
  worstSeverity: Severity;
  /** Highest fix across the group — the version that clears all of them. */
  clearedBy: string | null;
  advisories: BlastRadiusEntry[];
};

export function groupByAffectedVersion(entries: BlastRadiusEntry[]): AffectedVersionGroup[] {
  const groups = new Map<string, AffectedVersionGroup>();

  for (const entry of entries) {
    const existing = groups.get(entry.affectedVersionId);
    if (existing) {
      existing.advisories.push(entry);
      if (compareSeverity(entry.severity, existing.worstSeverity) < 0) {
        existing.worstSeverity = entry.severity;
      }
      continue;
    }
    groups.set(entry.affectedVersionId, {
      versionId: entry.affectedVersionId,
      packageName: entry.affectedPackage,
      version: entry.affectedVersion,
      depth: entry.depth,
      chain: entry.chain,
      entryPoint: entry.entryPoint,
      worstSeverity: entry.severity,
      clearedBy: null,
      advisories: [entry],
    });
  }

  for (const group of groups.values()) {
    group.clearedBy = highestVersion(group.advisories.map((advisory) => advisory.fixedIn));
    group.advisories.sort(
      (a, b) => compareSeverity(a.severity, b.severity) || a.osvId.localeCompare(b.osvId),
    );
  }

  return [...groups.values()].sort(
    (a, b) =>
      compareSeverity(a.worstSeverity, b.worstSeverity) ||
      b.advisories.length - a.advisories.length ||
      a.versionId.localeCompare(b.versionId),
  );
}

/**
 * Findings grouped by the declared dependency responsible for them.
 *
 * The actionable view: a list of advisories is paralysing, a list of upgrades is
 * a morning's work. Derived from the blast radius rather than re-queried, since
 * it is the same result grouped differently.
 */
export type FixPoint = {
  entryPoint: string;
  entryPackage: string;
  entryRange: string;
  /** True when the vulnerable package is itself the declared dependency. */
  isDirect: boolean;
  advisories: number;
  worstSeverity: Severity;
  severityCounts: SeverityCounts;
  affectedVersions: string[];
};

export function deriveFixPoints(entries: BlastRadiusEntry[]): FixPoint[] {
  const byEntryPoint = new Map<string, FixPoint>();

  for (const entry of entries) {
    let fix = byEntryPoint.get(entry.entryPoint);
    if (!fix) {
      fix = {
        entryPoint: entry.entryPoint,
        entryPackage: packageNameOf(entry.entryPoint),
        entryRange: entry.entryRange,
        isDirect: entry.chain.length <= 1,
        advisories: 0,
        worstSeverity: entry.severity,
        severityCounts: emptySeverityCounts(),
        affectedVersions: [],
      };
      byEntryPoint.set(entry.entryPoint, fix);
    }

    fix.advisories += 1;
    fix.severityCounts[entry.severity] += 1;
    if (compareSeverity(entry.severity, fix.worstSeverity) < 0) {
      fix.worstSeverity = entry.severity;
    }
    if (!fix.affectedVersions.includes(entry.affectedVersionId)) {
      fix.affectedVersions.push(entry.affectedVersionId);
    }
  }

  return [...byEntryPoint.values()].sort(
    (a, b) =>
      compareSeverity(a.worstSeverity, b.worstSeverity) ||
      b.advisories - a.advisories ||
      a.entryPoint.localeCompare(b.entryPoint),
  );
}

/**
 * How concentrated the findings are.
 *
 * "16 dependencies carry 105 advisories" is not triage; "3 of them carry 62" is.
 */
export function fixPointConcentration(
  fixPoints: FixPoint[],
  totalFindings: number,
  top = 3,
): { count: number; covered: number; share: number } {
  const ranked = [...fixPoints].sort((a, b) => b.advisories - a.advisories).slice(0, top);
  const covered = ranked.reduce((sum, fix) => sum + fix.advisories, 0);
  return {
    count: ranked.length,
    covered,
    share: totalFindings > 0 ? Math.round((covered / totalFindings) * 100) : 0,
  };
}

/**
 * Every installed version in one tree, with its depth and worst severity.
 *
 * Backs the tree map: a few hundred rows, one per installed version, which is
 * small enough to render as a grid and large enough to make the shape of a
 * dependency tree legible at a glance. Counts alone cannot show that the
 * vulnerable packages cluster at a particular depth.
 */
export type TreeNode = {
  versionId: string;
  packageName: string;
  version: string;
  depth: number;
  severity: Severity | null;
};

const TREE_MAP = `
MATCH (app:App {slug: $slug})-[reach:REACHES]->(dep:Version)
OPTIONAL MATCH (vuln:Vulnerability)-[:AFFECTS]->(dep)
RETURN dep.id          AS versionId,
       dep.packageName AS packageName,
       dep.version     AS version,
       reach.depth     AS depth,
       collect(vuln.severity) AS severities
ORDER BY reach.depth, dep.packageName
`;

export async function getTreeMap(slug: string): Promise<TreeNode[]> {
  return read(TREE_MAP, { slug }, (row) => ({
    versionId: row.string("versionId"),
    packageName: row.string("packageName"),
    version: row.string("version"),
    depth: row.count("depth"),
    severity: worstSeverity(row.list("severities")),
  }));
}

export type DepthBucket = { depth: number; count: number };

const DEPTH_HISTOGRAM = `
MATCH (:App {slug: $slug})-[r:REACHES]->(:Version)
RETURN r.depth AS depth, count(*) AS count
ORDER BY depth
`;

export async function getDepthHistogram(slug: string): Promise<DepthBucket[]> {
  return read(DEPTH_HISTOGRAM, { slug }, (row) => ({
    depth: row.number("depth"),
    count: row.count("count"),
  }));
}

/**
 * Dependencies whose licence is not plainly permissive, with the chain that
 * pulled each one in.
 *
 * Reports weak copyleft and unrecognised licences as well as the dramatic AGPL
 * case, because the honest finding for an npm tree is usually that nothing is
 * alarming — and a query that only ever returns nothing teaches the reader
 * nothing about whether it works.
 */
export type LicenseFinding = {
  versionId: string;
  packageName: string;
  version: string;
  spdxId: string;
  category: LicenseCategory;
  depth: number;
  chain: string[];
};

const LICENSE_OBLIGATIONS = `
MATCH (app:App {slug: $slug})-[reach:REACHES]->(dep:Version)-[:LICENSED_UNDER]->(license:License)
WHERE license.category IN $categories
CALL {
${SHORTEST_CHAIN_FROM_DECLARED}
}
RETURN dep.id           AS versionId,
       dep.packageName  AS packageName,
       dep.version      AS version,
       license.spdxId   AS spdxId,
       license.category AS category,
       reach.depth      AS depth,
       chain
ORDER BY reach.depth DESC, dep.id
`;

const NON_PERMISSIVE: LicenseCategory[] = [
  "network-copyleft",
  "copyleft",
  "weak-copyleft",
  "proprietary",
  "unknown",
];

export async function getLicenseObligations(slug: string): Promise<LicenseFinding[]> {
  return read(LICENSE_OBLIGATIONS, { slug, categories: NON_PERMISSIVE }, (row) => ({
    versionId: row.string("versionId"),
    packageName: row.string("packageName"),
    version: row.string("version"),
    spdxId: row.string("spdxId"),
    category: row.string("category") as LicenseCategory,
    depth: row.count("depth"),
    chain: row.strings("chain"),
  }));
}

const APP_SLUGS = `MATCH (app:App) RETURN app.slug AS slug ORDER BY slug`;

export async function getAppSlugs(): Promise<string[]> {
  return read(APP_SLUGS, {}, (row) => row.string("slug"));
}

export const APP_DETAIL_CYPHER = {
  APP_HEADER,
  VULNERABLE_PATHS,
  VULNERABLE_VERSIONS,
  DEPTH_HISTOGRAM,
  TREE_MAP,
  LICENSE_OBLIGATIONS,
};
