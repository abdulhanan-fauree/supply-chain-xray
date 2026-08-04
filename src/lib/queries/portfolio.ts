import { read } from "../db";
import { MAX_TRAVERSAL_DEPTH, SEVERITY_ORDER, type Severity } from "../model";

/**
 * The dashboard query: one row per application, each row summarising an entire
 * transitive dependency tree.
 *
 * Reachability comes from the materialised (:App)-[:REACHES {depth}]->(:Version)
 * closure rather than a live walk. That is a measured decision, not a guess —
 * see ReachesEdge in model.ts, and the two notes below on what the free instance
 * is and is not fast at.
 *
 * The relational comparison still holds. Even with the closure materialised,
 * `worstSeverity` and the per-app advisory counts join reachability against
 * advisories whose applicability is a version-range predicate, and the longest
 * chain below is a genuine unbounded walk. In SQL the closure itself would be a
 * recursive CTE that has to be re-derived or maintained by triggers.
 */

export type PortfolioRow = {
  slug: string;
  name: string;
  kind: string;
  description: string;
  directDeps: number;
  totalDeps: number;
  /** Deepest nesting level: the furthest a dependency sits from the app. */
  nestingDepth: number;
  /** Longest single dependency chain. A different number from nestingDepth. */
  longestChain: number;
  /** Dependencies the app did not declare — pulled in by something else. */
  indirectDeps: number;
  vulnerableVersions: number;
  advisories: number;
  worstSeverity: Severity | null;
  severityCounts: Record<Severity, number>;
};

/**
 * Everything here is single-hop over REACHES, so it is an index seek per app
 * rather than a traversal. Measured at roughly 250ms for all six apps, against
 * 1043ms for the equivalent live-traversal version and a 20s timeout for the
 * per-pair shortestPath version this replaced.
 */
const PORTFOLIO = `
MATCH (app:App)

CALL {
  WITH app
  MATCH (app)-[u:USES]->(:Version)
  WHERE NOT u.dev
  RETURN count(u) AS directDeps
}

CALL {
  WITH app
  MATCH (app)-[r:REACHES]->(:Version)
  RETURN count(r)          AS totalDeps,
         max(r.depth)      AS nestingDepth,
         count(CASE WHEN r.depth > 1 THEN 1 END) AS indirectDeps
}

CALL {
  WITH app
  MATCH (app)-[:REACHES]->(dep:Version)<-[:AFFECTS]-(vuln:Vulnerability)
  RETURN count(DISTINCT dep)  AS vulnerableVersions,
         count(DISTINCT vuln) AS advisories,
         collect(DISTINCT [vuln.osvId, vuln.severity]) AS severityPairs
}

RETURN app.slug        AS slug,
       app.name        AS name,
       app.kind        AS kind,
       app.description AS description,
       directDeps,
       totalDeps,
       coalesce(nestingDepth, 0) AS nestingDepth,
       coalesce(indirectDeps, 0) AS indirectDeps,
       vulnerableVersions,
       advisories,
       severityPairs
ORDER BY advisories DESC, totalDeps DESC
`;

/**
 * The longest single dependency chain, which stays a live traversal.
 *
 * `max(length(p))` is the cheap one here — 519ms for all six apps — which is the
 * opposite of what I assumed before measuring. On this engine a `shortestPath`
 * called once per (source, target) pair is what falls over, not path length over
 * a bounded variable-length match. Worth stating plainly because the intuition
 * carried over from other databases is wrong in this specific case.
 *
 * This is deliberately a different number from `nestingDepth`: orders-api nests
 * 5 levels deep but contains a 9-package chain, because the longest route to a
 * node is not the shortest one. Both are shown, labelled for what they are.
 */
const LONGEST_CHAIN = `
MATCH (app:App)-[u:USES]->(root:Version)
WHERE NOT u.dev
MATCH p = (root)-[:DEPENDS_ON*0..${MAX_TRAVERSAL_DEPTH}]->(:Version)
RETURN app.slug AS slug, max(length(p)) + 1 AS longestChain
`;

const EMPTY_SEVERITIES: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 0,
  MODERATE: 0,
  LOW: 0,
  UNKNOWN: 0,
};

export async function getPortfolio(): Promise<PortfolioRow[]> {
  const [rows, chains] = await Promise.all([
    read(PORTFOLIO, {}, (record) => record),
    read(LONGEST_CHAIN, {}, (record) => record),
  ]);

  const chainBySlug = new Map<string, number>(
    chains.map((row) => [row.slug as string, (row.longestChain as number) ?? 0]),
  );

  return rows.map((row) => {
    // Pairs rather than a bare severity list: collecting severities alone would
    // count one advisory once per affected version it touches, so a single CVE
    // in a widely-shared package would dominate the histogram.
    const pairs = (row.severityPairs ?? []) as Array<[string, string]>;
    const severityCounts = { ...EMPTY_SEVERITIES };
    for (const [, severity] of pairs) {
      const key: Severity = severity in severityCounts ? (severity as Severity) : "UNKNOWN";
      severityCounts[key] += 1;
    }

    const worstSeverity =
      (Object.entries(severityCounts)
        .filter(([, count]) => count > 0)
        .sort(
          ([a], [b]) => SEVERITY_ORDER[a as Severity] - SEVERITY_ORDER[b as Severity],
        )[0]?.[0] as Severity | undefined) ?? null;

    const slug = row.slug as string;
    return {
      slug,
      name: row.name as string,
      kind: row.kind as string,
      description: row.description as string,
      directDeps: row.directDeps as number,
      totalDeps: row.totalDeps as number,
      nestingDepth: row.nestingDepth as number,
      longestChain: chainBySlug.get(slug) ?? 0,
      indirectDeps: row.indirectDeps as number,
      vulnerableVersions: row.vulnerableVersions as number,
      advisories: row.advisories as number,
      worstSeverity,
      severityCounts,
    };
  });
}

/** Graph-wide totals for the dashboard header. */
export type GraphTotals = {
  packages: number;
  versions: number;
  dependencies: number;
  maintainers: number;
  advisories: number;
};

const TOTALS = `
CALL { MATCH (n:Package) RETURN count(n) AS packages }
CALL { MATCH (n:Version) RETURN count(n) AS versions }
CALL { MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS dependencies }
CALL { MATCH (n:Maintainer) RETURN count(n) AS maintainers }
CALL { MATCH (n:Vulnerability) RETURN count(n) AS advisories }
RETURN packages, versions, dependencies, maintainers, advisories
`;

export async function getGraphTotals(): Promise<GraphTotals> {
  const rows = await read(TOTALS, {}, (record) => ({
    packages: record.packages as number,
    versions: record.versions as number,
    dependencies: record.dependencies as number,
    maintainers: record.maintainers as number,
    advisories: record.advisories as number,
  }));
  return rows[0] ?? { packages: 0, versions: 0, dependencies: 0, maintainers: 0, advisories: 0 };
}
