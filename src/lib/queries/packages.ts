import { read, readOne } from "../db";
import { MAX_TRAVERSAL_DEPTH, type LicenseCategory, type Severity } from "../model";

/**
 * Package views, including the choke-point query.
 *
 * A choke point is a package that many applications depend on without any of them
 * choosing it. Finding them means intersecting several transitive closures and
 * asking how deep each one sits — set intersection over reachability, which is
 * exactly what a graph is for and what SQL needs a recursive CTE plus a
 * self-join per application to express.
 */

export type ChokePointRow = {
  name: string;
  description: string | null;
  latestVersion: string | null;
  weeklyDownloads: number | null;
  deprecated: boolean;
  /** How many of the six applications reach this package at all. */
  appsReached: number;
  /** Shallowest hop count across those apps. 1 means somebody declared it. */
  minDepth: number;
  /** True when no application declares it directly — pure collateral. */
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
       maintainers,
       advisories,
       severities
`;

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
  UNKNOWN: 4,
};

function worstOf(severities: string[]): Severity | null {
  const known = severities.filter((value): value is Severity => value in SEVERITY_RANK);
  if (known.length === 0) return null;
  return known.sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0];
}

export async function getChokePoints(minApps = 2): Promise<ChokePointRow[]> {
  const rows = await read(CHOKE_POINTS, {}, (record) => {
    const minDepth = record.minDepth as number;
    return {
      name: record.name as string,
      description: (record.description as string | null) ?? null,
      latestVersion: (record.latestVersion as string | null) ?? null,
      weeklyDownloads: (record.weeklyDownloads as number | null) ?? null,
      deprecated: Boolean(record.deprecated),
      appsReached: record.appsReached as number,
      minDepth,
      neverDeclared: minDepth > 1,
      versionsInstalled: record.versionsInstalled as number,
      maintainers: record.maintainers as number,
      advisories: record.advisories as number,
      worstSeverity: worstOf((record.severities ?? []) as string[]),
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
  return readOne(PACKAGE_DETAIL, { name }, (record) => ({
    name: record.name as string,
    description: (record.description as string | null) ?? null,
    latestVersion: (record.latestVersion as string | null) ?? null,
    weeklyDownloads: (record.weeklyDownloads as number | null) ?? null,
    deprecated: Boolean(record.deprecated),
    repoUrl: (record.repoUrl as string | null) ?? null,
    homepage: (record.homepage as string | null) ?? null,
    maintainers: ((record.maintainers ?? []) as string[]).sort(),
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
  /** Apps whose production tree contains this exact version. */
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
  const rows = await read(PACKAGE_VERSIONS, { name }, (record) => ({
    versionId: record.versionId as string,
    version: record.version as string,
    releasesBehind: (record.releasesBehind as number | null) ?? null,
    isLatest: Boolean(record.isLatest),
    deprecated: Boolean(record.deprecated),
    spdxId: (record.spdxId as string | null) ?? null,
    licenseCategory: (record.licenseCategory as LicenseCategory | null) ?? null,
    advisories: record.advisories as number,
    worstSeverity: worstOf(((record.severities ?? []) as Array<string | null>).filter(
      (value): value is string => Boolean(value),
    )),
    apps: (((record.apps ?? []) as Array<[string, number] | null>)
      .filter((entry): entry is [string, number] => Array.isArray(entry) && entry[0] !== null)
      .map(([slug, depth]) => ({ slug, depth }))),
  }));

  return rows.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export type Dependent = {
  versionId: string;
  packageName: string;
  range: string;
  optional: boolean;
  /** Which version of the subject package this dependent pulls in. */
  resolvesTo: string;
};

/**
 * Who depends on this package. A reverse edge walk, one hop — trivial here and
 * the kind of thing that needs a dedicated index in a relational schema.
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
  return read(DEPENDENTS, { name }, (record) => ({
    versionId: record.versionId as string,
    packageName: record.packageName as string,
    range: record.range as string,
    optional: Boolean(record.optional),
    resolvesTo: record.resolvesTo as string,
  }));
}

/**
 * Shortest path between two arbitrary packages: the six-degrees query.
 *
 * Included because it is the single clearest demonstration of the difference.
 * "How is my app related to this package I have never heard of" is one line of
 * Cypher and an unbounded self-join in SQL, and the answer is a path, which a
 * relational result set cannot represent without reassembly in application code.
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
  return readOne(PACKAGE_PATH, { from, to }, (record) => ({
    chain: (record.chain ?? []) as string[],
    hops: record.hops as number,
  }));
}

const PACKAGE_NAMES = `
MATCH (pkg:Package)-[:HAS_VERSION]->(:Version)<-[:REACHES]-(:App)
RETURN DISTINCT pkg.name AS name
ORDER BY name
`;

export async function getPackageNames(): Promise<string[]> {
  return read(PACKAGE_NAMES, {}, (record) => record.name as string);
}

export const PACKAGE_CYPHER = { CHOKE_POINTS, DEPENDENTS, PACKAGE_PATH };
