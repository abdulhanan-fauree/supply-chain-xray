import type { GraphDataset } from "../../src/lib/model";

/**
 * Sort every collection so the serialised dataset is byte-stable.
 *
 * The crawl fans out across concurrent workers, so collections are populated in
 * whatever order responses arrive. The resulting graph is identical either way,
 * but the JSON is not — which makes data/graph.json produce meaningless diffs and
 * makes "the dataset is reproducible" impossible to demonstrate. Sorting is the
 * last step before writing, each collection ordered by the key that makes it
 * unique.
 */
export function sortDataset(dataset: GraphDataset): void {
  const by =
    <T,>(...keys: Array<(row: T) => string | number>) =>
    (a: T, b: T): number => {
      for (const key of keys) {
        const left = key(a);
        const right = key(b);
        if (left < right) return -1;
        if (left > right) return 1;
      }
      return 0;
    };

  dataset.apps.sort(by((node) => node.slug));
  dataset.packages.sort(by((node) => node.name));
  dataset.versions.sort(by((node) => node.id));
  dataset.maintainers.sort(by((node) => node.npmUser));
  dataset.licenses.sort(by((node) => node.spdxId));
  dataset.repos.sort(by((node) => node.id));
  dataset.vulnerabilities.sort(by((node) => node.osvId));

  dataset.uses.sort(by((edge) => edge.appSlug, (edge) => edge.versionId));
  dataset.reaches.sort(by((edge) => edge.appSlug, (edge) => edge.versionId));
  dataset.hasVersion.sort(by((edge) => edge.packageName, (edge) => edge.versionId));
  dataset.dependsOn.sort(by((edge) => edge.fromVersionId, (edge) => edge.toVersionId));
  dataset.licensedUnder.sort(by((edge) => edge.versionId, (edge) => edge.spdxId));
  dataset.maintains.sort(by((edge) => edge.npmUser, (edge) => edge.packageName));
  dataset.hostedIn.sort(by((edge) => edge.packageName, (edge) => edge.repoId));
  dataset.affects.sort(by((edge) => edge.osvId, (edge) => edge.versionId));
}

/** Human-readable summary of what a crawl produced. */
export function summariseDataset(dataset: GraphDataset): string {
  const rows: Array<[string, number]> = [
    ["apps", dataset.apps.length],
    ["packages", dataset.stats.packages],
    ["versions", dataset.stats.versions],
    ["DEPENDS_ON", dataset.stats.dependsOn],
    ["REACHES", dataset.stats.reaches],
    ["maintainers", dataset.stats.maintainers],
    ["licenses", dataset.licenses.length],
    ["repos", dataset.repos.length],
    ["vulnerabilities", dataset.stats.vulnerabilities],
    ["AFFECTS", dataset.stats.affects],
    ["max depth reached", dataset.stats.maxDepthReached],
    ["unresolved ranges", dataset.stats.unresolved],
  ];
  return rows
    .map(([label, value]) => `  ${label.padEnd(19)}${String(value).padStart(6)}`)
    .join("\n");
}
