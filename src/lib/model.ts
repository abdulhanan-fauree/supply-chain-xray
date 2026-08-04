/**
 * The graph data model, as plain TypeScript.
 *
 * These types are the contract between three things: the crawler that builds
 * the dataset, the loader that writes it to CognoDB, and the query layer that
 * reads it back. Node labels and relationship types are declared as constants
 * so a rename is a compile error rather than a silently empty result set.
 *
 *   (:App)-[:USES {range, dev}]->(:Version)
 *   (:Package)-[:HAS_VERSION]->(:Version)
 *   (:Version)-[:DEPENDS_ON {range, dev, optional}]->(:Version)
 *   (:Version)-[:LICENSED_UNDER]->(:License)
 *   (:Maintainer)-[:MAINTAINS]->(:Package)
 *   (:Vulnerability)-[:AFFECTS {vulnerableRange, fixedIn}]->(:Version)
 *   (:Package)-[:HOSTED_IN]->(:Repo)
 *
 * The load-bearing decision is that Version is its own node rather than a
 * property on Package. Vulnerabilities affect version ranges, not packages —
 * modelling AFFECTS against Package would make every blast-radius answer a
 * false positive for anyone already on a patched version.
 */

export const NODE = {
  App: "App",
  Package: "Package",
  Version: "Version",
  Maintainer: "Maintainer",
  Vulnerability: "Vulnerability",
  License: "License",
  Repo: "Repo",
} as const;

export const REL = {
  USES: "USES",
  HAS_VERSION: "HAS_VERSION",
  DEPENDS_ON: "DEPENDS_ON",
  LICENSED_UNDER: "LICENSED_UNDER",
  MAINTAINS: "MAINTAINS",
  AFFECTS: "AFFECTS",
  HOSTED_IN: "HOSTED_IN",
  REACHES: "REACHES",
} as const;

/** Maximum traversal depth used by every variable-length query in the app. */
export const MAX_TRAVERSAL_DEPTH = 8;

export type Severity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";

export const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
  UNKNOWN: 4,
};

/**
 * License buckets. The distinction that matters for the contamination query is
 * whether linking a dependency imposes obligations on the distributing app.
 */
export type LicenseCategory =
  | "permissive"
  | "weak-copyleft"
  | "copyleft"
  | "network-copyleft"
  | "proprietary"
  | "unknown";

export type AppNode = {
  slug: string;
  name: string;
  description: string;
  /** What kind of project this is, e.g. "Web app", "Service", "CLI". */
  kind: string;
};

export type PackageNode = {
  name: string;
  description: string | null;
  latestVersion: string | null;
  weeklyDownloads: number | null;
  deprecated: boolean;
  repoUrl: string | null;
  homepage: string | null;
};

export type VersionNode = {
  /** "name@version" — the unique key for this node. */
  id: string;
  packageName: string;
  version: string;
  /**
   * How many published releases sit between this version and the current
   * latest. This stands in for a publish date on purpose: the abbreviated
   * registry packument is one to two orders of magnitude smaller than the full
   * one but carries no `time` map, and "47 releases behind" answers the
   * staleness question at least as well as a date for a fraction of the
   * bandwidth. Null when the version is not in the published list.
   */
  releasesBehind: number | null;
  isLatest: boolean;
  deprecated: boolean;
};

export type MaintainerNode = {
  npmUser: string;
};

export type LicenseNode = {
  spdxId: string;
  category: LicenseCategory;
};

export type RepoNode = {
  /** "host/owner/name" — the unique key. */
  id: string;
  host: string;
  owner: string;
  name: string;
};

export type VulnerabilityNode = {
  osvId: string;
  /** CVE identifiers and other cross-references for this advisory. */
  aliases: string[];
  severity: Severity;
  /**
   * OSV reports CVSS as a vector string, not a number, so that is what we
   * store. The severity label above comes from the advisory's own
   * database_specific.severity, which is what the UI ranks by.
   */
  cvssVector: string | null;
  summary: string;
  details: string;
  publishedAt: string | null;
  referenceUrl: string | null;
};

export type UsesEdge = {
  appSlug: string;
  versionId: string;
  /** The semver range as written in the manifest, e.g. "^4.18.2". */
  range: string;
  dev: boolean;
};

/**
 * Note the absence of a `dev` flag here, which USES does carry. npm does not
 * install the devDependencies of your dependencies — only of the root project —
 * so a dev edge below depth 0 does not exist in a real install tree and is not
 * in this graph either. `optional` does survive, because optional dependencies
 * are installed by default and can meaningfully be excluded mid-traversal.
 */
export type DependsOnEdge = {
  fromVersionId: string;
  toVersionId: string;
  range: string;
  optional: boolean;
};

/**
 * A materialised transitive closure: (:App)-[:REACHES {depth}]->(:Version) for
 * every version in an app's production install tree, with `depth` being the
 * minimum number of hops from the app (a direct dependency is 1).
 *
 * Why this exists. Nesting depth per dependency is the number behind the most
 * interesting thing this app has to say — "you did not choose this; something
 * five levels down did". Asked live it is expensive, and measurably so on the
 * free c0 instance: a `shortestPath` per (app, dependency) pair times out at
 * 20s, because the engine solves ~730 independent shortest-path problems.
 * Computed with one breadth-first sweep in the loader it is microseconds, and
 * the answer is identical because a BFS *is* the shortest-path algorithm — just
 * run once from each source instead of once per pair.
 *
 * This is not a way of avoiding graph queries. The queries that need a *path* —
 * blast radius, the fix point, shortest path between two packages — still
 * traverse live, because a path is the thing a graph database is uniquely good
 * at returning and there is nothing to precompute. What is materialised here is
 * only the reachability aggregate behind dashboard counters.
 *
 * Note this is distinct from the longest chain through a tree, which is a
 * different number (orders-api: nesting depth 5, longest chain 9) and stays a
 * live query since `max(length(p))` is cheap.
 */
export type ReachesEdge = {
  appSlug: string;
  versionId: string;
  depth: number;
};

export type HasVersionEdge = { packageName: string; versionId: string };
export type LicensedUnderEdge = { versionId: string; spdxId: string };
export type MaintainsEdge = { npmUser: string; packageName: string };
export type HostedInEdge = { packageName: string; repoId: string };

export type AffectsEdge = {
  osvId: string;
  versionId: string;
  /** The range the advisory declares vulnerable, e.g. ">=4.0.0 <4.17.21". */
  vulnerableRange: string;
  /** First version containing the fix, or null if none has been published. */
  fixedIn: string | null;
};

/** Everything the loader needs, in one serialisable payload. */
export type GraphDataset = {
  generatedAt: string;
  stats: {
    packages: number;
    versions: number;
    dependsOn: number;
    vulnerabilities: number;
    affects: number;
    maintainers: number;
    maxDepthReached: number;
    /** Dependency ranges that could not be resolved, with the reason. */
    unresolved: number;
    /** Materialised (app, version) reachability pairs. */
    reaches: number;
  };
  apps: AppNode[];
  packages: PackageNode[];
  versions: VersionNode[];
  maintainers: MaintainerNode[];
  licenses: LicenseNode[];
  repos: RepoNode[];
  vulnerabilities: VulnerabilityNode[];
  uses: UsesEdge[];
  reaches: ReachesEdge[];
  hasVersion: HasVersionEdge[];
  dependsOn: DependsOnEdge[];
  licensedUnder: LicensedUnderEdge[];
  maintains: MaintainsEdge[];
  hostedIn: HostedInEdge[];
  affects: AffectsEdge[];
};
