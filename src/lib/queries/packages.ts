import { MAX_TRAVERSAL_DEPTH, CHOKE_POINT_MIN_APPS } from "../config";
import { read, readOne } from "../db";
import { worstSeverity } from "../severity";
import type { LicenseCategory, Severity } from "../model";

/**
 * Package views, including the choke-point query.
 *
 * A choke point is a package many applications depend on without any of them
 * having chosen it. Finding them means intersecting several transitive closures
 * and comparing how deep each sits — set intersection over reachability, which
 * SQL expresses as one recursive CTE per application plus a join across their
 * results.
 */

export type ChokePointRow = {
  name: string;
  description: string | null;
  latestVersion: string | null;
  weeklyDownloads: number | null;
  deprecated: boolean;
  /** Applications that reach this package at all. */
  appsReached: number;
  /** Shallowest hop count across those applications. */
  minDepth: number;
  /** True when no application declares it directly. */
  neverDeclared: boolean;
  versionsInstalled: number;
  maintainers: number;
  advisories: number;
  worstSeverity: Severity | null;
};

const CHOKE_POINTS = `
MATCH (pkg:Package)-[:HAS_VERSION]->(version:Version)<-[reach:REACHES]-(app:App)

CALL {
  WITH pkg
  MATCH (:Maintainer)-[m:MAINTAINS]->(pkg)
  RETURN count(m) AS maintainers
}
CALL {
  WITH pkg
  MATCH (pkg)-[:HAS_VERSION]->(:Version)<-[:AFFECTS]-(vuln:Vulnerability)
  RETURN count(DISTINCT vuln) AS advisories,
         collect(DISTINCT vuln.severity) AS severities
}

RETURN pkg.name            AS name,
       pkg.description     AS description,
       pkg.latestVersion   AS latestVersion,
       pkg.weeklyDownloads AS weeklyDownloads,
       pkg.deprecated      AS deprecated,
       count(DISTINCT app)     AS appsReached,
       min(reach.depth)        AS minDepth,
       count(DISTINCT version) AS versionsInstalled,
       maintainers, advisories, severities
`;

export async function getChokePoints(minApps = CHOKE_POINT_MIN_APPS): Promise<ChokePointRow[]> {
  const rows = await read(CHOKE_POINTS, {}, (row) => {
    const minDepth = row.count("minDepth");
    return {
      name: row.string("name"),
      description: row.stringOrNull("description"),
      latestVersion: row.stringOrNull("latestVersion"),
      weeklyDownloads: row.numberOrNull("weeklyDownloads"),
      deprecated: row.boolean("deprecated"),
      appsReached: row.count("appsReached"),
      minDepth,
      neverDeclared: minDepth > 1,
      versionsInstalled: row.count("versionsInstalled"),
      maintainers: row.count("maintainers"),
      advisories: row.count("advisories"),
      worstSeverity: worstSeverity(row.list("severities")),
    };
  });

  return rows
    .filter((row) => row.appsReached >= minApps)
    .sort(
      (a, b) =>
        b.appsReached - a.appsReached ||
        b.advisories - a.advisories ||
        a.minDepth - b.minDepth ||
        a.name.localeCompare(b.name),
    );
}

export type PackageDetail = {
  name: string;
  description: string | null;
  latestVersion: string | null;
  weeklyDownloads: number | null;
  deprecated: boolean;
  repoUrl: string | null;
  homepage: string | null;
  maintainers: string[];
};

const PACKAGE_DETAIL = `
MATCH (pkg:Package {name: $name})
CALL {
  WITH pkg
  MATCH (m:Maintainer)-[:MAINTAINS]->(pkg)
  RETURN collect(m.npmUser) AS maintainers
}
RETURN pkg.name            AS name,
       pkg.description     AS description,
       pkg.latestVersion   AS latestVersion,
       pkg.weeklyDownloads AS weeklyDownloads,
       pkg.deprecated      AS deprecated,
       pkg.repoUrl         AS repoUrl,
       pkg.homepage        AS homepage,
       maintainers
`;

export async function getPackage(name: string): Promise<PackageDetail | null> {
  return readOne(PACKAGE_DETAIL, { name }, (row) => ({
    name: row.string("name"),
    description: row.stringOrNull("description"),
    latestVersion: row.stringOrNull("latestVersion"),
    weeklyDownloads: row.numberOrNull("weeklyDownloads"),
    deprecated: row.boolean("deprecated"),
    repoUrl: row.stringOrNull("repoUrl"),
    homepage: row.stringOrNull("homepage"),
    maintainers: row.strings("maintainers").sort(),
  }));
}

export type InstalledVersion = {
  versionId: string;
  version: string;
  releasesBehind: number | null;
  isLatest: boolean;
  deprecated: boolean;
  spdxId: string | null;
  licenseCategory: LicenseCategory | null;
  advisories: number;
  worstSeverity: Severity | null;
  /** Applications whose production tree contains this exact version. */
  apps: Array<{ slug: string; depth: number }>;
};

const PACKAGE_VERSIONS = `
MATCH (:Package {name: $name})-[:HAS_VERSION]->(version:Version)

CALL {
  WITH version
  OPTIONAL MATCH (version)-[:LICENSED_UNDER]->(license:License)
  RETURN license.spdxId AS spdxId, license.category AS licenseCategory
}
CALL {
  WITH version
  OPTIONAL MATCH (vuln:Vulnerability)-[:AFFECTS]->(version)
  RETURN count(vuln) AS advisories, collect(vuln.severity) AS severities
}
CALL {
  WITH version
  OPTIONAL MATCH (app:App)-[reach:REACHES]->(version)
  RETURN collect(DISTINCT [app.slug, reach.depth]) AS apps
}

RETURN version.id             AS versionId,
       version.version        AS version,
       version.releasesBehind AS releasesBehind,
       version.isLatest       AS isLatest,
       version.deprecated     AS deprecated,
       spdxId, licenseCategory, advisories, severities, apps
`;

export async function getPackageVersions(name: string): Promise<InstalledVersion[]> {
  const rows = await read(PACKAGE_VERSIONS, { name }, (row) => ({
    versionId: row.string("versionId"),
    version: row.string("version"),
    releasesBehind: row.numberOrNull("releasesBehind"),
    isLatest: row.boolean("isLatest"),
    deprecated: row.boolean("deprecated"),
    spdxId: row.stringOrNull("spdxId"),
    licenseCategory: row.stringOrNull("licenseCategory") as LicenseCategory | null,
    advisories: row.count("advisories"),
    worstSeverity: worstSeverity(row.list("severities")),
    // An OPTIONAL MATCH that found nothing collects [null, null].
    apps: row
      .pairs("apps")
      .filter(([slug]) => typeof slug === "string")
      .map(([slug, depth]) => ({ slug: slug as string, depth: Number(depth) || 0 })),
  }));

  return rows.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export type Dependent = {
  versionId: string;
  packageName: string;
  range: string;
  optional: boolean;
  /** Which version of the subject package this dependent resolves to. */
  resolvesTo: string;
};

/**
 * What depends on this package: a one-hop walk against the edge direction.
 *
 * Cheap because a relationship has no preferred direction — the same edges answer
 * "what does X depend on" and "what depends on X". A relational schema needs a
 * second index to make the reverse question anything but a scan.
 */
const DEPENDENTS = `
MATCH (:Package {name: $name})-[:HAS_VERSION]->(target:Version)
MATCH (dependent:Version)-[d:DEPENDS_ON]->(target)
RETURN dependent.id          AS versionId,
       dependent.packageName AS packageName,
       d.range               AS range,
       d.optional            AS optional,
       target.id             AS resolvesTo
ORDER BY dependent.packageName, dependent.version
`;

export async function getDependents(name: string): Promise<Dependent[]> {
  return read(DEPENDENTS, { name }, (row) => ({
    versionId: row.string("versionId"),
    packageName: row.string("packageName"),
    range: row.string("range"),
    optional: row.boolean("optional"),
    resolvesTo: row.string("resolvesTo"),
  }));
}

/**
 * Shortest path between two arbitrary packages.
 *
 * The clearest single demonstration of the difference: one line of Cypher against
 * an unbounded self-join, and the answer is a path rather than a set of rows to
 * stitch back together.
 */
const PACKAGE_PATH = `
MATCH (from:Package {name: $from})-[:HAS_VERSION]->(start:Version)
MATCH (to:Package {name: $to})-[:HAS_VERSION]->(finish:Version)
MATCH p = shortestPath((start)-[:DEPENDS_ON*1..${MAX_TRAVERSAL_DEPTH}]->(finish))
RETURN [n IN nodes(p) | n.id] AS chain, length(p) AS hops
ORDER BY hops ASC
LIMIT 1
`;

export async function getPackagePath(
  from: string,
  to: string,
): Promise<{ chain: string[]; hops: number } | null> {
  return readOne(PACKAGE_PATH, { from, to }, (row) => ({
    chain: row.strings("chain"),
    hops: row.count("hops"),
  }));
}

const PACKAGE_NAMES = `
MATCH (pkg:Package)-[:HAS_VERSION]->(:Version)<-[:REACHES]-(:App)
RETURN DISTINCT pkg.name AS name
ORDER BY name
`;

export async function getPackageNames(): Promise<string[]> {
  return read(PACKAGE_NAMES, {}, (row) => row.string("name"));
}

export const PACKAGE_CYPHER = { CHOKE_POINTS, DEPENDENTS, PACKAGE_PATH };
