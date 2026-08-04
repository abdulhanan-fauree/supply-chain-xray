/**
 * The graph data model as plain TypeScript.
 *
 * These types are the contract between three things: the crawler that builds the
 * dataset, the loader that writes it to CognoDB, and the query layer that reads
 * it back. Labels and relationship types are declared as constants so a rename
 * is a compile error rather than a silently empty result set.
 *
 *   (:App)-[:USES {range, dev}]->(:Version)
 *   (:App)-[:REACHES {depth}]->(:Version)
 *   (:Package)-[:HAS_VERSION]->(:Version)
 *   (:Version)-[:DEPENDS_ON {range, optional}]->(:Version)
 *   (:Version)-[:LICENSED_UNDER]->(:License)
 *   (:Maintainer)-[:MAINTAINS]->(:Package)
 *   (:Vulnerability)-[:AFFECTS {vulnerableRange, fixedIn}]->(:Version)
 *   (:Package)-[:HOSTED_IN]->(:Repo)
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
  REACHES: "REACHES",
  HAS_VERSION: "HAS_VERSION",
  DEPENDS_ON: "DEPENDS_ON",
  LICENSED_UNDER: "LICENSED_UNDER",
  MAINTAINS: "MAINTAINS",
  AFFECTS: "AFFECTS",
  HOSTED_IN: "HOSTED_IN",
} as const;

export type NodeLabel = (typeof NODE)[keyof typeof NODE];
export type RelType = (typeof REL)[keyof typeof REL];

export type Severity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";

/**
 * License buckets.
 *
 * The distinction that matters for the obligations query is what shipping a
 * dependency requires of the distributor, not which licence family it belongs to.
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
  /** Project kind, e.g. "Web app", "Service", "CLI tool". */
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

/**
 * A published version.
 *
 * Modelled as its own node rather than a property of Package because advisories
 * apply to version ranges. Hanging AFFECTS off Package would report every user
 * of a package as vulnerable, including those already on a patched release.
 */
export type VersionNode = {
  /** `"name@version"` — the unique key. See version-id.ts for parsing. */
  id: string;
  packageName: string;
  version: string;
  /**
   * Published releases newer than this one.
   *
   * Stands in for a publish date: the abbreviated registry packument used to
   * build the dependency graph is one to two orders of magnitude smaller than
   * the full document but carries no `time` map, and "93 releases behind"
   * answers the staleness question for a fraction of the bandwidth.
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
  /** `"host/owner/name"` — the unique key. */
  id: string;
  host: string;
  owner: string;
  name: string;
};

export type VulnerabilityNode = {
  osvId: string;
  /** CVE identifiers and cross-referenced advisory ids. */
  aliases: string[];
  severity: Severity;
  /** OSV reports CVSS as a vector string, not a score, so that is what is kept. */
  cvssVector: string | null;
  summary: string;
  details: string;
  publishedAt: string | null;
  referenceUrl: string | null;
};

export type UsesEdge = {
  appSlug: string;
  versionId: string;
  /** The range as written in the manifest, e.g. `"^4.18.2"`. */
  range: string;
  dev: boolean;
};

/**
 * A dependency between two installed versions.
 *
 * There is deliberately no `dev` flag. npm installs the devDependencies of the
 * root project only, so a dev edge below the root does not exist in any real
 * install tree and is not in this graph either. `optional` does survive, because
 * optional dependencies are installed by default and can meaningfully be
 * excluded mid-traversal.
 */
export type DependsOnEdge = {
  fromVersionId: string;
  toVersionId: string;
  range: string;
  optional: boolean;
};

/**
 * A materialised transitive closure: every version in an application's production
 * install tree, with the minimum number of hops from the application.
 *
 * Nesting depth is the number behind the most useful thing this application has
 * to say — that most of a dependency tree was never chosen by anyone. Asked live
 * it is expensive on a burstable instance, because it becomes one shortest-path
 * search per (application, dependency) pair. Computed with one breadth-first
 * sweep per application in the crawler it is effectively free, and the answer is
 * identical: a BFS is the shortest-path algorithm, run once per source instead of
 * once per pair.
 *
 * Only reachability aggregates are materialised. Queries that return a *path*
 * traverse live, since there is nothing about a path to precompute.
 */
export type ReachesEdge = {
  appSlug: string;
  versionId: string;
  /** 1 for a directly declared dependency. */
  depth: number;
};

export type HasVersionEdge = { packageName: string; versionId: string };
export type LicensedUnderEdge = { versionId: string; spdxId: string };
export type MaintainsEdge = { npmUser: string; packageName: string };
export type HostedInEdge = { packageName: string; repoId: string };

export type AffectsEdge = {
  osvId: string;
  versionId: string;
  /** The range the advisory declares vulnerable, e.g. `">=4.0.0 <4.17.21"`. */
  vulnerableRange: string;
  /** First version containing the fix, or null if none has been published. */
  fixedIn: string | null;
};

export type DatasetStats = {
  packages: number;
  versions: number;
  dependsOn: number;
  vulnerabilities: number;
  affects: number;
  maintainers: number;
  maxDepthReached: number;
  /** Dependency ranges that could not be resolved to a published version. */
  unresolved: number;
  reaches: number;
};

/** Everything the loader needs, in one serialisable payload. */
export type GraphDataset = {
  generatedAt: string;
  stats: DatasetStats;
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
