import { read } from "../db";
import type { Severity } from "../model";

/**
 * Trust concentration.
 *
 * The question: if one npm account were compromised today, how much of my
 * software could that person publish to? Not "how many packages do they own" —
 * how many packages that my applications actually install, and how far down,
 * because a compromise at depth five is one nobody would notice in review.
 *
 * This is the query I would open an interview with. It is a three-hop join from
 * a person, through the packages they can publish, to the versions installed, to
 * the applications exposed — and the interesting part is the aggregate over the
 * *transitive* set, not the direct dependencies. In a relational schema the
 * reachability half is a recursive CTE and the grouping half is a join against
 * its result, per maintainer. Here the closure is already an edge, so the whole
 * question is one pattern and a count.
 *
 * It is also the query where the modelling decision in registry.ts pays off:
 * maintainers come from each package's *current* metadata rather than the
 * historical maintainer list of whichever old version happens to be installed.
 * "Who holds the keys today" is the question; "who held them in 2019" is not.
 */

export type TrustRow = {
  npmUser: string;
  /** Packages this account can publish to that are installed somewhere. */
  packages: number;
  /** Installed versions those packages account for. */
  versions: number;
  appsReached: number;
  appSlugs: string[];
  /** Shallowest hop count. 1 means an app declares one of their packages. */
  minDepth: number;
  /** Deepest hop count — how far from review their code can sit. */
  maxDepth: number;
  /** True when nothing they publish is declared directly by any app. */
  entirelyTransitive: boolean;
  advisories: number;
  worstSeverity: Severity | null;
  /** A few package names, for the UI. */
  samplePackages: string[];
};

/**
 * Split in two, for the same reason the blast radius was: the obvious single
 * query ran a per-maintainer advisory subquery for all 558 accounts and measured
 * 3980ms. Only a handful of accounts maintain anything with an advisory against
 * it, so asking that separately touches a fraction of the graph, and the two run
 * concurrently.
 */
const TRUST_CONCENTRATION = `
MATCH (maintainer:Maintainer)-[:MAINTAINS]->(pkg:Package)
MATCH (pkg)-[:HAS_VERSION]->(version:Version)<-[reach:REACHES]-(app:App)
RETURN maintainer.npmUser       AS npmUser,
       count(DISTINCT pkg)      AS packages,
       count(DISTINCT version)  AS versions,
       count(DISTINCT app)      AS appsReached,
       collect(DISTINCT app.slug) AS appSlugs,
       min(reach.depth)         AS minDepth,
       max(reach.depth)         AS maxDepth,
       collect(DISTINCT pkg.name)[0..4] AS samplePackages
`;

const MAINTAINER_ADVISORIES = `
MATCH (maintainer:Maintainer)-[:MAINTAINS]->(:Package)
      -[:HAS_VERSION]->(version:Version)<-[:REACHES]-(:App)
MATCH (vuln:Vulnerability)-[:AFFECTS]->(version)
RETURN maintainer.npmUser AS npmUser,
       count(DISTINCT vuln) AS advisories,
       collect(DISTINCT vuln.severity) AS severities
`;

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
  UNKNOWN: 4,
};

export async function getTrustConcentration(): Promise<TrustRow[]> {
  const [base, advisories] = await Promise.all([
    read(TRUST_CONCENTRATION, {}, (record) => record),
    read(MAINTAINER_ADVISORIES, {}, (record) => ({
      npmUser: record.npmUser as string,
      advisories: record.advisories as number,
      severities: ((record.severities ?? []) as Array<string | null>).filter(
        (value): value is Severity => Boolean(value) && (value as string) in SEVERITY_RANK,
      ),
    })),
  ]);

  const advisoriesByUser = new Map(advisories.map((row) => [row.npmUser, row]));

  const rows = base.map((record) => {
    const npmUser = record.npmUser as string;
    const advisoryInfo = advisoriesByUser.get(npmUser);
    const severities = [...(advisoryInfo?.severities ?? [])];
    const minDepth = record.minDepth as number;
    return {
      npmUser,
      packages: record.packages as number,
      versions: record.versions as number,
      appsReached: record.appsReached as number,
      appSlugs: ((record.appSlugs ?? []) as string[]).sort(),
      minDepth,
      maxDepth: record.maxDepth as number,
      entirelyTransitive: minDepth > 1,
      advisories: advisoryInfo?.advisories ?? 0,
      worstSeverity:
        severities.length === 0
          ? null
          : severities.sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0],
      samplePackages: ((record.samplePackages ?? []) as string[]).sort(),
    };
  });

  return rows.sort(
    (a, b) =>
      b.packages - a.packages ||
      b.appsReached - a.appsReached ||
      a.npmUser.localeCompare(b.npmUser),
  );
}

/**
 * Graph-wide framing for the trust page: how lopsided the distribution is.
 * Computed here rather than in Cypher because it is arithmetic over a result set
 * already in hand, and asking the instance to do it twice would be wasteful.
 */
export type TrustSummary = {
  maintainers: number;
  /** Distinct installed packages covered by the top N accounts. */
  topCoverage: number;
  topCount: number;
  totalPackages: number;
  share: number;
};

export function summariseTrust(rows: TrustRow[], totalPackages: number, top = 5): TrustSummary {
  const ranked = [...rows].sort((a, b) => b.packages - a.packages).slice(0, top);
  // Deliberately a sum rather than a union: two accounts co-maintaining a package
  // both genuinely hold its keys, so counting it twice is the honest reading of
  // "how much could these accounts publish to". Capped at the total so the
  // headline share cannot exceed 100%.
  const covered = Math.min(
    ranked.reduce((sum, row) => sum + row.packages, 0),
    totalPackages,
  );
  return {
    maintainers: rows.length,
    topCoverage: covered,
    topCount: ranked.length,
    totalPackages,
    share: totalPackages > 0 ? Math.round((covered / totalPackages) * 100) : 0,
  };
}

/**
 * Packages with exactly one maintainer that applications actually install — the
 * bus-factor-of-one set. A single person, no second pair of eyes, in production.
 */
export type SoleMaintainerRow = {
  packageName: string;
  npmUser: string;
  weeklyDownloads: number | null;
  minDepth: number;
  appsReached: number;
};

const SOLE_MAINTAINERS = `
MATCH (pkg:Package)-[:HAS_VERSION]->(version:Version)<-[reach:REACHES]-(app:App)
WITH pkg, min(reach.depth) AS minDepth, count(DISTINCT app) AS appsReached
MATCH (maintainer:Maintainer)-[:MAINTAINS]->(pkg)
WITH pkg, minDepth, appsReached, collect(maintainer.npmUser) AS maintainers
WHERE size(maintainers) = 1
RETURN pkg.name            AS packageName,
       maintainers[0]      AS npmUser,
       pkg.weeklyDownloads AS weeklyDownloads,
       minDepth,
       appsReached
`;

export async function getSoleMaintainers(): Promise<SoleMaintainerRow[]> {
  const rows = await read(SOLE_MAINTAINERS, {}, (record) => ({
    packageName: record.packageName as string,
    npmUser: record.npmUser as string,
    weeklyDownloads: (record.weeklyDownloads as number | null) ?? null,
    minDepth: record.minDepth as number,
    appsReached: record.appsReached as number,
  }));

  return rows.sort(
    (a, b) =>
      (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0) ||
      a.packageName.localeCompare(b.packageName),
  );
}

export const MAINTAINER_CYPHER = { TRUST_CONCENTRATION, MAINTAINER_ADVISORIES, SOLE_MAINTAINERS };
