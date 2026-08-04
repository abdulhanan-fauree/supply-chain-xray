/**
 * Schema: uniqueness constraints and secondary indexes.
 *
 * Constraints are not decoration here. The loader MERGEs by key across many
 * concurrent batches, and without a uniqueness constraint MERGE has no index to
 * look through — so it both scans and races, producing duplicate nodes. Every
 * key the loader merges on has a constraint behind it.
 *
 * Indexes cover the properties the *application* filters and sorts on. On a
 * 0.5 vCPU instance the difference between an index seek and a label scan over
 * 1,100 versions is the difference between a snappy page and a visible stall.
 */

export const CONSTRAINTS: Array<{ name: string; cypher: string }> = [
  {
    name: "app_slug",
    cypher: "CREATE CONSTRAINT app_slug IF NOT EXISTS FOR (n:App) REQUIRE n.slug IS UNIQUE",
  },
  {
    name: "package_name",
    cypher:
      "CREATE CONSTRAINT package_name IF NOT EXISTS FOR (n:Package) REQUIRE n.name IS UNIQUE",
  },
  {
    name: "version_id",
    cypher: "CREATE CONSTRAINT version_id IF NOT EXISTS FOR (n:Version) REQUIRE n.id IS UNIQUE",
  },
  {
    name: "maintainer_user",
    cypher:
      "CREATE CONSTRAINT maintainer_user IF NOT EXISTS FOR (n:Maintainer) REQUIRE n.npmUser IS UNIQUE",
  },
  {
    name: "license_spdx",
    cypher:
      "CREATE CONSTRAINT license_spdx IF NOT EXISTS FOR (n:License) REQUIRE n.spdxId IS UNIQUE",
  },
  {
    name: "repo_id",
    cypher: "CREATE CONSTRAINT repo_id IF NOT EXISTS FOR (n:Repo) REQUIRE n.id IS UNIQUE",
  },
  {
    name: "vuln_osv_id",
    cypher:
      "CREATE CONSTRAINT vuln_osv_id IF NOT EXISTS FOR (n:Vulnerability) REQUIRE n.osvId IS UNIQUE",
  },
];

export const INDEXES: Array<{ name: string; cypher: string }> = [
  {
    // Version -> its package, used by every package detail page.
    name: "version_package",
    cypher: "CREATE INDEX version_package IF NOT EXISTS FOR (n:Version) ON (n.packageName)",
  },
  {
    // Severity ranking drives the vulnerability list ordering and filters.
    name: "vuln_severity",
    cypher: "CREATE INDEX vuln_severity IF NOT EXISTS FOR (n:Vulnerability) ON (n.severity)",
  },
  {
    // License category is the filter behind the obligations query.
    name: "license_category",
    cypher: "CREATE INDEX license_category IF NOT EXISTS FOR (n:License) ON (n.category)",
  },
  {
    // Popularity sort on package listings.
    name: "package_downloads",
    cypher: "CREATE INDEX package_downloads IF NOT EXISTS FOR (n:Package) ON (n.weeklyDownloads)",
  },
];

/** Labels the loader owns, in the order they are safe to delete. */
export const OWNED_LABELS = [
  "App",
  "Version",
  "Package",
  "Maintainer",
  "License",
  "Repo",
  "Vulnerability",
] as const;
