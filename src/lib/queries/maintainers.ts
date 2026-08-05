import { TRUST_SUMMARY_TOP_N } from "../config";
import { read } from "../db";
import { worstSeverity } from "../severity";
import type { Severity } from "../model";

/**
 * Trust concentration: if one npm account were compromised today, how much of
 * this software could that person publish to?
 *
 * A three-hop walk from a person, through the packages they can publish, to the
 * versions installed, to the applications exposed — aggregated over the
 * transitive set rather than direct dependencies, because a compromise five hops
 * down is the one nobody would notice in review.
 *
 * Maintainers come from each package's current metadata rather than the
 * historical list on whichever old version happens to be installed. The question
 * is who holds the keys now.
 */

export type TrustRow = {
  npmUser: string;
  /** Packages this account can publish that are installed somewhere. */
  packages: number;
  /** Installed versions those packages account for. */
  versions: number;
  appsReached: number;
  appSlugs: string[];
  /** Shallowest hop count; 1 means an application declares one of them. */
  minDepth: number;
  /** Deepest hop count — how far from review their code can sit. */
  maxDepth: number;
  /** True when no application declares anything they publish. */
  entirelyTransitive: boolean;
  advisories: number;
  worstSeverity: Severity | null;
  /** A few package names, for display. */
  samplePackages: string[];
};

/**
 * Split from the advisory aggregate below.
 *
 * Counting advisories per maintainer inside this query means running a subquery
 * for every account, when only a small minority maintain anything with an
 * advisory against it. Asking separately touches a fraction of the graph, and the
 * two run concurrently.
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
RETURN maintainer.npmUser     AS npmUser,
       count(DISTINCT vuln)   AS advisories,
       collect(DISTINCT vuln.severity) AS severities
`;

export async function getTrustConcentration(): Promise<TrustRow[]> {
  const [accounts, advisories] = await Promise.all([
    read(TRUST_CONCENTRATION, {}, (row) => {
      const minDepth = row.count("minDepth");
      return {
        npmUser: row.string("npmUser"),
        packages: row.count("packages"),
        versions: row.count("versions"),
        appsReached: row.count("appsReached"),
        appSlugs: row.strings("appSlugs").sort(),
        minDepth,
        maxDepth: row.count("maxDepth"),
        entirelyTransitive: minDepth > 1,
        samplePackages: row.strings("samplePackages").sort(),
      };
    }),
    read(MAINTAINER_ADVISORIES, {}, (row) => ({
      npmUser: row.string("npmUser"),
      advisories: row.count("advisories"),
      worstSeverity: worstSeverity(row.list("severities")),
    })),
  ]);

  const advisoriesByUser = new Map(advisories.map((entry) => [entry.npmUser, entry]));

  return accounts
    .map((account): TrustRow => {
      const found = advisoriesByUser.get(account.npmUser);
      return {
        ...account,
        advisories: found?.advisories ?? 0,
        worstSeverity: found?.worstSeverity ?? null,
      };
    })
    .sort(
      (a, b) =>
        b.packages - a.packages ||
        b.appsReached - a.appsReached ||
        a.npmUser.localeCompare(b.npmUser),
    );
}

export type TrustSummary = {
  maintainers: number;
  /** Installed packages the top accounts can publish between them. */
  topCoverage: number;
  topCount: number;
  totalPackages: number;
  share: number;
};

/**
 * How lopsided the distribution is.
 *
 * `topCoverage` sums rather than unions: two accounts co-maintaining a package
 * both genuinely hold its keys, so counting it for each is the honest reading of
 * "how much could these accounts publish to". Capped at the total so the share
 * cannot exceed 100%.
 */
export function summariseTrust(
  rows: TrustRow[],
  totalPackages: number,
  top = TRUST_SUMMARY_TOP_N,
): TrustSummary {
  const ranked = [...rows].sort((a, b) => b.packages - a.packages).slice(0, top);
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
 * Installed packages with exactly one account able to publish them — a bus factor
 * of one, in production, with no second pair of eyes on a release.
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
       minDepth, appsReached
`;

export async function getSoleMaintainers(): Promise<SoleMaintainerRow[]> {
  const rows = await read(SOLE_MAINTAINERS, {}, (row) => ({
    packageName: row.string("packageName"),
    npmUser: row.string("npmUser"),
    weeklyDownloads: row.numberOrNull("weeklyDownloads"),
    minDepth: row.count("minDepth"),
    appsReached: row.count("appsReached"),
  }));

  return rows.sort(
    (a, b) =>
      (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0) ||
      a.packageName.localeCompare(b.packageName),
  );
}

export const MAINTAINER_CYPHER = {
  TRUST_CONCENTRATION,
  MAINTAINER_ADVISORIES,
  SOLE_MAINTAINERS,
};
