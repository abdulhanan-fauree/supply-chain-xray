import { read, readOne } from "../db";
import { MAX_TRAVERSAL_DEPTH, type LicenseCategory, type Severity } from "../model";

/**
 * The application detail page: everything about one app's install tree.
 *
 * This is where the graph earns its place. Three of the four queries below
 * return a *path* — not a count, not a join result, but the actual chain of
 * packages connecting something you chose to something you did not. That is the
 * shape a relational schema cannot hand back without either a recursive CTE per
 * question or reassembling the chain in application code from a pile of rows.
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
RETURN app.slug AS slug, app.name AS name, app.kind AS kind,
       app.description AS description,
       directDeps, devDeps,
       coalesce(totalDeps, 0)    AS totalDeps,
       coalesce(nestingDepth, 0) AS nestingDepth
`;

export async function getAppHeader(slug: string): Promise<AppHeader | null> {
  return readOne(APP_HEADER, { slug }, (record) => ({
    slug: record.slug as string,
    name: record.name as string,
    kind: record.kind as string,
    description: record.description as string,
    directDeps: record.directDeps as number,
    devDeps: record.devDeps as number,
    totalDeps: record.totalDeps as number,
    nestingDepth: record.nestingDepth as number,
  }));
}

export type BlastRadiusEntry = {
  osvId: string;
  aliases: string[];
  severity: Severity;
  summary: string;
  referenceUrl: string | null;
  /** The vulnerable version in this app's tree, e.g. "minimist@0.0.10". */
  affectedVersionId: string;
  affectedPackage: string;
  affectedVersion: string;
  vulnerableRange: string;
  fixedIn: string | null;
  /** Hops from the app: 1 means it is a direct dependency. */
  depth: number;
  /**
   * The shortest chain of version ids from a direct dependency to the vulnerable
   * version. This is the thing the UI draws, and the reason the app exists.
   */
  chain: string[];
  /** The direct dependency at the head of that chain — the one you can bump. */
  entryPoint: string;
  /** The range the app declares for that direct dependency. */
  entryRange: string;
};

/**
 * Blast radius, in two queries rather than one.
 *
 * The obvious single query joins advisories to versions and finds a path for
 * each resulting row. That measured at 2.6s for legacy-admin, because 105
 * advisory rows land on only 29 distinct vulnerable versions — so the same
 * path was being found roughly four times over.
 *
 * Splitting it finds each path exactly once and joins in application code, where
 * a 29-entry map lookup is free. The two queries run concurrently, so the page
 * waits for the slower of them instead of the sum.
 *
 * Scoping is what makes path finding affordable at all here: the outer match is
 * single-hop over the materialised closure, narrowing to the handful of
 * vulnerable versions before any traversal starts. Unscoped, one path per
 * (root, dependency) pair timed out at 20s during benchmarking.
 */
const VULNERABLE_PATHS = `
MATCH (app:App {slug: $slug})-[reach:REACHES]->(dep:Version)<-[:AFFECTS]-(:Vulnerability)
WITH DISTINCT app, dep, reach.depth AS depth

CALL {
  WITH app, dep
  MATCH (app)-[u:USES]->(root:Version)
  WHERE NOT u.dev
  MATCH p = (root)-[:DEPENDS_ON*0..${MAX_TRAVERSAL_DEPTH}]->(dep)
  RETURN [n IN nodes(p) | n.id] AS chain, u.range AS entryRange
  ORDER BY length(p) ASC
  LIMIT 1
}

RETURN dep.id AS versionId, depth, chain, entryRange
`;

const VULNERABLE_VERSIONS = `
MATCH (app:App {slug: $slug})-[:REACHES]->(dep:Version)
MATCH (vuln:Vulnerability)-[affects:AFFECTS]->(dep)
RETURN vuln.osvId        AS osvId,
       vuln.aliases      AS aliases,
       vuln.severity     AS severity,
       vuln.summary      AS summary,
       vuln.referenceUrl AS referenceUrl,
       dep.id            AS affectedVersionId,
       dep.packageName   AS affectedPackage,
       dep.version       AS affectedVersion,
       affects.vulnerableRange AS vulnerableRange,
       affects.fixedIn   AS fixedIn
`;

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
  UNKNOWN: 4,
};

type PathRow = { depth: number; chain: string[]; entryRange: string };

export async function getBlastRadius(slug: string): Promise<BlastRadiusEntry[]> {
  const [pathRows, advisoryRows] = await Promise.all([
    read(VULNERABLE_PATHS, { slug }, (record) => ({
      versionId: record.versionId as string,
      depth: record.depth as number,
      chain: (record.chain ?? []) as string[],
      entryRange: (record.entryRange as string) ?? "",
    })),
    read(VULNERABLE_VERSIONS, { slug }, (record) => record),
  ]);

  const pathByVersion = new Map<string, PathRow>(
    pathRows.map((row) => [row.versionId, { depth: row.depth, chain: row.chain, entryRange: row.entryRange }]),
  );

  const rows = advisoryRows.map((record) => {
    const affectedVersionId = record.affectedVersionId as string;
    const path = pathByVersion.get(affectedVersionId);
    const chain = path?.chain ?? [affectedVersionId];
    return {
      osvId: record.osvId as string,
      aliases: (record.aliases ?? []) as string[],
      severity: record.severity as Severity,
      summary: record.summary as string,
      referenceUrl: (record.referenceUrl as string | null) ?? null,
      affectedVersionId,
      affectedPackage: record.affectedPackage as string,
      affectedVersion: record.affectedVersion as string,
      vulnerableRange: record.vulnerableRange as string,
      fixedIn: (record.fixedIn as string | null) ?? null,
      depth: path?.depth ?? chain.length,
      chain,
      entryPoint: chain[0] ?? affectedVersionId,
      entryRange: path?.entryRange ?? "",
    };
  });

  // Ordered in the application rather than Cypher: severity is a label, not a
  // sortable value, and encoding the rank in the query would mean a CASE ladder
  // that has to stay in sync with the Severity type.
  return rows.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.depth - b.depth ||
      a.affectedVersionId.localeCompare(b.affectedVersionId),
  );
}

/**
 * The blast radius grouped by the version that carries the advisories.
 *
 * 105 findings for legacy-admin land on 29 distinct versions, and every advisory
 * on a given version shares the same path. Rendering one row per advisory drew
 * the same chain four times over on average, which produced a 676 KB page and a
 * wall of repetition nobody would read. Grouping collapses it to 29 blocks: one
 * chain, with its advisories listed beneath.
 */
export type AffectedVersionGroup = {
  versionId: string;
  packageName: string;
  version: string;
  depth: number;
  chain: string[];
  entryPoint: string;
  worstSeverity: Severity;
  /** The highest fix across the advisories — the version that clears them all. */
  clearedBy: string | null;
  advisories: BlastRadiusEntry[];
};

export function groupByAffectedVersion(entries: BlastRadiusEntry[]): AffectedVersionGroup[] {
  const groups = new Map<string, AffectedVersionGroup>();

  for (const entry of entries) {
    const existing = groups.get(entry.affectedVersionId);
    if (existing) {
      existing.advisories.push(entry);
      if (SEVERITY_RANK[entry.severity] < SEVERITY_RANK[existing.worstSeverity]) {
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
    // Highest published fix across the group: upgrading to anything lower still
    // leaves one of these advisories open.
    group.clearedBy = group.advisories.reduce<string | null>((highest, advisory) => {
      if (!advisory.fixedIn) return highest;
      if (!highest) return advisory.fixedIn;
      return compareVersions(advisory.fixedIn, highest) > 0 ? advisory.fixedIn : highest;
    }, null);

    group.advisories.sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.osvId.localeCompare(b.osvId),
    );
  }

  return [...groups.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.worstSeverity] - SEVERITY_RANK[b.worstSeverity] ||
      b.advisories.length - a.advisories.length ||
      a.versionId.localeCompare(b.versionId),
  );
}

/**
 * Numeric-segment version comparison. Deliberately not the `semver` package:
 * that is a crawler dependency, and pulling it into the client bundle to compare
 * two already-validated version strings is not worth the bytes.
 */
function compareVersions(a: string, b: string): number {
  const partsOf = (value: string) => value.split(/[.+-]/).map((part) => Number(part) || 0);
  const left = partsOf(a);
  const right = partsOf(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The fix point: group the blast radius by the direct dependency that carries it.
 *
 * This is the actionable view. "You have 102 advisories" is paralysing; "bumping
 * these four direct dependencies clears 71 of them" is a morning's work. Derived
 * from the blast radius rather than re-queried, since it is the same traversal
 * grouped differently and the free instance should not do it twice.
 */
export type FixPoint = {
  entryPoint: string;
  entryPackage: string;
  entryRange: string;
  /** True when the vulnerable package *is* the direct dependency. */
  isDirect: boolean;
  advisories: number;
  worstSeverity: Severity;
  severityCounts: Record<Severity, number>;
  affectedVersions: string[];
};

/**
 * How concentrated the findings are. "16 dependencies carry 105 advisories" is
 * not triage; "3 of them carry 62" tells you where to start.
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

export function deriveFixPoints(entries: BlastRadiusEntry[]): FixPoint[] {
  const byEntry = new Map<string, FixPoint>();

  for (const entry of entries) {
    const existing = byEntry.get(entry.entryPoint);
    const target =
      existing ??
      ({
        entryPoint: entry.entryPoint,
        entryPackage: entry.entryPoint.split("@").slice(0, -1).join("@"),
        entryRange: entry.entryRange,
        isDirect: entry.chain.length <= 1,
        advisories: 0,
        worstSeverity: "UNKNOWN" as Severity,
        severityCounts: { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0, UNKNOWN: 0 },
        affectedVersions: [],
      } satisfies FixPoint);

    target.advisories += 1;
    target.severityCounts[entry.severity] += 1;
    if (SEVERITY_RANK[entry.severity] < SEVERITY_RANK[target.worstSeverity]) {
      target.worstSeverity = entry.severity;
    }
    if (!target.affectedVersions.includes(entry.affectedVersionId)) {
      target.affectedVersions.push(entry.affectedVersionId);
    }
    byEntry.set(entry.entryPoint, target);
  }

  return [...byEntry.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.worstSeverity] - SEVERITY_RANK[b.worstSeverity] ||
      b.advisories - a.advisories ||
      a.entryPoint.localeCompare(b.entryPoint),
  );
}

/** How much of the tree sits at each level of nesting. */
export type DepthBucket = { depth: number; count: number };

const DEPTH_HISTOGRAM = `
MATCH (:App {slug: $slug})-[r:REACHES]->(:Version)
RETURN r.depth AS depth, count(*) AS count
ORDER BY depth
`;

export async function getDepthHistogram(slug: string): Promise<DepthBucket[]> {
  return read(DEPTH_HISTOGRAM, { slug }, (record) => ({
    depth: record.depth as number,
    count: record.count as number,
  }));
}

/**
 * License obligations: dependencies whose licence is not plainly permissive,
 * with the chain that pulled each one in.
 *
 * The honest finding for an npm tree is usually "nothing alarming" — npm really
 * is overwhelmingly MIT and Apache-2.0 — so this query is built to report weak
 * copyleft and unknown licences rather than only the dramatic AGPL case, and the
 * page has a genuine clean state for when there is nothing to say.
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
  WITH app, dep
  MATCH (app)-[u:USES]->(root:Version)
  WHERE NOT u.dev
  MATCH p = (root)-[:DEPENDS_ON*0..${MAX_TRAVERSAL_DEPTH}]->(dep)
  RETURN [n IN nodes(p) | n.id] AS chain
  ORDER BY length(p) ASC
  LIMIT 1
}

RETURN dep.id          AS versionId,
       dep.packageName AS packageName,
       dep.version     AS version,
       license.spdxId  AS spdxId,
       license.category AS category,
       reach.depth     AS depth,
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
  return read(LICENSE_OBLIGATIONS, { slug, categories: NON_PERMISSIVE }, (record) => ({
    versionId: record.versionId as string,
    packageName: record.packageName as string,
    version: record.version as string,
    spdxId: record.spdxId as string,
    category: record.category as LicenseCategory,
    depth: record.depth as number,
    chain: (record.chain ?? []) as string[],
  }));
}

/** All apps, for the detail page's switcher and for generating static params. */
const APP_SLUGS = `MATCH (app:App) RETURN app.slug AS slug ORDER BY slug`;

export async function getAppSlugs(): Promise<string[]> {
  return read(APP_SLUGS, {}, (record) => record.slug as string);
}
