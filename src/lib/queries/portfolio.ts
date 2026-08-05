import { MAX_TRAVERSAL_DEPTH } from "../config";
import { read, readOne, type Row } from "../db";
import {
  countSeverities,
  worstSeverity,
  type SeverityCounts,
} from "../severity";
import type { Severity } from "../model";

/**
 * Portfolio-level reads: the dashboard row per application, and graph totals.
 *
 * Reachability comes from the materialised (:App)-[:REACHES {depth}]->(:Version)
 * closure rather than a live walk, which makes each figure an index seek per
 * application instead of a traversal. See ReachesEdge in model.ts for why that
 * closure exists and what is deliberately left live.
 */

export type PortfolioRow = {
  slug: string;
  name: string;
  kind: string;
  description: string;
  directDeps: number;
  totalDeps: number;
  /** Deepest nesting level: how far the furthest dependency sits from the app. */
  nestingDepth: number;
  /**
   * Longest single dependency chain. A different measure from nestingDepth — the
   * longest route to a node is not the shortest one — so both are reported.
   */
  longestChain: number;
  /** Dependencies the application did not declare. */
  indirectDeps: number;
  vulnerableVersions: number;
  advisories: number;
  worstSeverity: Severity | null;
  severityCounts: SeverityCounts;
};

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
  RETURN count(r)     AS totalDeps,
         max(r.depth) AS nestingDepth,
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
       nestingDepth,
       indirectDeps,
       vulnerableVersions,
       advisories,
       severityPairs
ORDER BY advisories DESC, totalDeps DESC
`;

/**
 * Longest chain per application, which stays a live traversal.
 *
 * `max(length(p))` over a bounded variable-length match is inexpensive on this
 * engine, whereas a `shortestPath` evaluated per candidate pair is not — the
 * opposite of the intuition carried over from other databases, and worth stating
 * because the two look interchangeable.
 */
const LONGEST_CHAIN = `
MATCH (app:App)-[u:USES]->(root:Version)
WHERE NOT u.dev
MATCH p = (root)-[:DEPENDS_ON*0..${MAX_TRAVERSAL_DEPTH}]->(:Version)
RETURN app.slug AS slug, max(length(p)) + 1 AS longestChain
`;

export async function getPortfolio(): Promise<PortfolioRow[]> {
  const [rows, chains] = await Promise.all([
    read(PORTFOLIO, {}, (row) => row),
    read(LONGEST_CHAIN, {}, (row) => [row.string("slug"), row.count("longestChain")] as const),
  ]);

  const chainBySlug = new Map(chains);

  return rows.map((row) => {
    // Advisory/severity pairs rather than a bare severity list: an advisory
    // affecting several versions of the same package would otherwise be counted
    // once per version and dominate the histogram.
    const severities = row.pairs("severityPairs").map(([, severity]) => severity);
    const severityCounts = countSeverities(severities);
    const slug = row.string("slug");

    return {
      slug,
      name: row.string("name"),
      kind: row.string("kind"),
      description: row.string("description"),
      directDeps: row.count("directDeps"),
      totalDeps: row.count("totalDeps"),
      nestingDepth: row.count("nestingDepth"),
      longestChain: chainBySlug.get(slug) ?? 0,
      indirectDeps: row.count("indirectDeps"),
      vulnerableVersions: row.count("vulnerableVersions"),
      advisories: row.count("advisories"),
      worstSeverity: worstSeverity(severities),
      severityCounts,
    };
  });
}

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

const EMPTY_TOTALS: GraphTotals = {
  packages: 0,
  versions: 0,
  dependencies: 0,
  maintainers: 0,
  advisories: 0,
};

export async function getGraphTotals(): Promise<GraphTotals> {
  const totals = await readOne(TOTALS, {}, (row: Row) => ({
    packages: row.count("packages"),
    versions: row.count("versions"),
    dependencies: row.count("dependencies"),
    maintainers: row.count("maintainers"),
    advisories: row.count("advisories"),
  }));
  return totals ?? EMPTY_TOTALS;
}

/** Exported so /queries renders the text that runs, not a transcription of it. */
export const PORTFOLIO_CYPHER = { PORTFOLIO, LONGEST_CHAIN, TOTALS };
