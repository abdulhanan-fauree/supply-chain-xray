/**
 * Builds data/graph.json: a breadth-first walk of six real dependency trees,
 * enriched with maintainers, licenses, download counts and OSV advisories.
 *
 *   npm run crawl
 *   npm run crawl -- --max-packages 2000 --max-depth 8 --concurrency 12
 *
 * Touches no database. Keeping dataset construction separate from loading means a
 * registry outage cannot leave the graph half-written, and the committed artifact
 * lets anyone seed with no network access.
 *
 * The output is deterministic: the same manifests produce the same bytes. That
 * relies on two things — the package budget being checked between levels rather
 * than within one (see Crawler.expandLevel) and every collection being sorted
 * before serialisation (see sortDataset).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { MAX_TRAVERSAL_DEPTH } from "../src/lib/config";
import type {
  AffectsEdge,
  GraphDataset,
  HasVersionEdge,
  HostedInEdge,
  LicenseNode,
  LicensedUnderEdge,
  MaintainerNode,
  MaintainsEdge,
  PackageNode,
  RepoNode,
} from "../src/lib/model";
import { formatVersionId } from "../src/lib/version-id";
import { Crawler, type CrawlOptions } from "./lib/crawler";
import { sortDataset, summariseDataset } from "./lib/dataset";
import { mapLimit, stats as httpStats } from "./lib/http";
import { manifestNodes } from "./lib/manifests";
import {
  dedupeByAliasCluster,
  fetchAdvisories,
  matchAffectedVersions,
  queryAdvisoryIds,
  toVulnerabilityNode,
} from "./lib/osv";
import { computeReachability } from "./lib/reachability";
import {
  categoriseLicense,
  getLatestDoc,
  getVersionDoc,
  getWeeklyDownloads,
  normaliseLicense,
  packageNodeFrom,
  parseRepo,
  type VersionDoc,
} from "./lib/registry";

/** Sized for a 256 MB instance: lands around 1-2k versions and 10k relationships. */
const DEFAULT_MAX_PACKAGES = 900;
const DEFAULT_CONCURRENCY = 8;

function parseOptions(argv: readonly string[]): CrawlOptions {
  const flag = (name: string, fallback: number) => {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    maxPackages: flag("--max-packages", DEFAULT_MAX_PACKAGES),
    maxDepth: flag("--max-depth", MAX_TRAVERSAL_DEPTH),
    concurrency: flag("--concurrency", DEFAULT_CONCURRENCY),
  };
}

const log = (message: string) => process.stdout.write(`${message}\n`);

/**
 * Package-level metadata, per-version licenses, and download counts.
 *
 * Three registry endpoints, each chosen deliberately:
 *
 *   - `/<pkg>/latest` for the *current* maintainer list, description and
 *     repository. Current rather than historical, because the trust question is
 *     who can publish today, not who could when an old version shipped.
 *   - `/<pkg>/<version>` for the licence of that specific version. A package's
 *     licence can change between releases, and applications pinning old releases
 *     are exactly the ones the licence query is about. Skipped when the resolved
 *     version is latest, since that document is already in hand.
 *   - the bulk downloads API, which rejects scoped names, so those go one at a
 *     time.
 */
async function enrich(crawler: Crawler, concurrency: number) {
  const packageNames = crawler.packageNames();
  log(`\nEnriching ${packageNames.length} packages`);

  const latestDocs = new Map(
    await mapLimit(packageNames, concurrency, async (name) => {
      const doc = await getLatestDoc(name).catch(() => null);
      return [name, doc] as const;
    }),
  );
  log(`  fetched ${latestDocs.size} package metadata documents`);

  const downloads = await getWeeklyDownloads(packageNames);
  log(`  fetched download counts for ${downloads.size} packages`);

  const versions = [...crawler.versions.values()];
  const licenseByVersion = new Map(
    await mapLimit(versions, concurrency, async (version) => {
      const latest = latestDocs.get(version.packageName) ?? null;
      const doc: VersionDoc | null =
        latest && latest.version === version.version
          ? latest
          : await getVersionDoc(version.packageName, version.version).catch(() => null);
      return [version.id, normaliseLicense(doc ?? latest)] as const;
    }),
  );
  log(`  resolved licenses for ${licenseByVersion.size} versions`);

  return { packageNames, latestDocs, downloads, licenseByVersion, versions };
}

/**
 * Match advisories to the versions actually in the graph.
 *
 * Matching runs against every raw OSV record rather than only the survivor of each
 * alias cluster: collapsed records sometimes declare a *wider* vulnerable range
 * than the one that wins, and dropping their ranges would under-report. Results
 * are attributed to the canonical id, and where a cluster disagrees about the fix
 * the highest fixed version wins — that is the one clearing every record in it.
 */
async function collectAdvisories(
  packageNames: readonly string[],
  versionsByPackage: ReadonlyMap<string, string[]>,
) {
  log(`\nQuerying OSV for ${packageNames.length} packages`);
  const idsByPackage = await queryAdvisoryIds([...packageNames]);
  const allIds = [...new Set([...idsByPackage.values()].flat())];
  log(
    `  ${idsByPackage.size} packages carry advisories, ${allIds.length} distinct records`,
  );

  const rawRecords = await fetchAdvisories(allIds);
  const { canonical, canonicalIdOf } = dedupeByAliasCluster(rawRecords);
  log(`  collapsed ${rawRecords.length} records into ${canonical.length} distinct issues`);

  const rawById = new Map(rawRecords.map((record) => [record.id, record]));
  const canonicalById = new Map(canonical.map((record) => [record.id, record]));
  const affectsByKey = new Map<string, AffectsEdge>();
  const usedIds = new Set<string>();

  for (const [packageName, ids] of idsByPackage) {
    const candidates = versionsByPackage.get(packageName);
    if (!candidates?.length) continue;

    for (const id of ids) {
      const record = rawById.get(id);
      if (!record) continue;
      const osvId = canonicalIdOf.get(id) ?? id;
      if (!canonicalById.has(osvId)) continue;

      for (const match of matchAffectedVersions(record, packageName, candidates)) {
        const versionId = formatVersionId(packageName, match.version);
        const key = `${osvId}|${versionId}`;
        const existing = affectsByKey.get(key);

        if (!existing) {
          affectsByKey.set(key, {
            osvId,
            versionId,
            vulnerableRange: match.vulnerableRange,
            fixedIn: match.fixedIn,
          });
        } else {
          existing.fixedIn = highestFix(existing.fixedIn, match.fixedIn);
          if (!existing.vulnerableRange.includes(match.vulnerableRange)) {
            existing.vulnerableRange = `${existing.vulnerableRange} || ${match.vulnerableRange}`;
          }
        }
        usedIds.add(osvId);
      }
    }
  }

  // Only advisories that hit a version in the graph become nodes; an advisory for
  // a version nobody installs is noise.
  const vulnerabilities = canonical
    .filter((record) => usedIds.has(record.id))
    .map(toVulnerabilityNode);

  return { vulnerabilities, affects: [...affectsByKey.values()] };
}

function highestFix(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  // String compare is insufficient across major versions, so compare numerically.
  const parts = (value: string) => value.split(/[.+-]/).map((part) => Number(part) || 0);
  const left = parts(candidate);
  const right = parts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0 ? candidate : current;
  }
  return current;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const startedAt = Date.now();

  const crawler = new Crawler(options);
  await crawler.run(log);

  const { packageNames, latestDocs, downloads, licenseByVersion, versions } = await enrich(
    crawler,
    options.concurrency,
  );

  const packages: PackageNode[] = packageNames.map((name) => {
    const doc = latestDocs.get(name) ?? null;
    const node = packageNodeFrom(name, doc, null, downloads.get(name) ?? null);
    // dist-tags live on the packument; the latest document's own version is the
    // same value and is already in hand.
    return { ...node, latestVersion: doc?.version ?? node.latestVersion };
  });

  const hasVersion: HasVersionEdge[] = versions.map((version) => ({
    packageName: version.packageName,
    versionId: version.id,
  }));

  const licenses = new Map<string, LicenseNode>();
  const licensedUnder: LicensedUnderEdge[] = [];
  for (const [versionId, spdxId] of licenseByVersion) {
    if (!licenses.has(spdxId)) {
      licenses.set(spdxId, { spdxId, category: categoriseLicense(spdxId) });
    }
    licensedUnder.push({ versionId, spdxId });
  }

  const maintainers = new Map<string, MaintainerNode>();
  const maintains: MaintainsEdge[] = [];
  const repos = new Map<string, RepoNode>();
  const hostedIn: HostedInEdge[] = [];

  for (const name of packageNames) {
    const doc = latestDocs.get(name) ?? null;
    for (const maintainer of doc?.maintainers ?? []) {
      const npmUser = maintainer.name?.trim();
      if (!npmUser) continue;
      if (!maintainers.has(npmUser)) maintainers.set(npmUser, { npmUser });
      maintains.push({ npmUser, packageName: name });
    }
    const repo = parseRepo(doc);
    if (repo) {
      if (!repos.has(repo.id)) repos.set(repo.id, repo);
      hostedIn.push({ packageName: name, repoId: repo.id });
    }
  }

  const versionsByPackage = new Map<string, string[]>();
  for (const version of versions) {
    const list = versionsByPackage.get(version.packageName);
    if (list) list.push(version.version);
    else versionsByPackage.set(version.packageName, [version.version]);
  }

  const { vulnerabilities, affects } = await collectAdvisories(packageNames, versionsByPackage);

  const dependsOn = [...crawler.dependsOn.values()];
  const reaches = computeReachability(crawler.uses, dependsOn);
  log(
    `\n  materialised ${reaches.length} reachability pairs, ` +
      `max nesting depth ${Math.max(0, ...reaches.map((edge) => edge.depth))}`,
  );

  const dataset: GraphDataset = {
    generatedAt: new Date().toISOString(),
    stats: {
      packages: packages.length,
      versions: versions.length,
      dependsOn: dependsOn.length,
      vulnerabilities: vulnerabilities.length,
      affects: affects.length,
      maintainers: maintainers.size,
      maxDepthReached: crawler.maxDepthReached(),
      unresolved: crawler.unresolved.length,
      reaches: reaches.length,
    },
    apps: manifestNodes(),
    packages,
    versions,
    maintainers: [...maintainers.values()],
    licenses: [...licenses.values()],
    repos: [...repos.values()],
    vulnerabilities,
    uses: crawler.uses,
    reaches,
    hasVersion,
    dependsOn,
    licensedUnder,
    maintains,
    hostedIn,
    affects,
  };

  sortDataset(dataset);

  const dataDir = resolve(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(dataDir, "graph.json"), JSON.stringify(dataset, null, 2));

  log(`\nWrote data/graph.json\n\n${summariseDataset(dataset)}`);
  log(
    `\n  http: ${httpStats.hits} cache hits, ${httpStats.misses} fetched, ` +
      `${httpStats.failures} failed`,
  );
  log(`  took ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);

  if (crawler.unresolved.length > 0) {
    const sorted = [...crawler.unresolved].sort((a, b) =>
      `${a.from}|${a.name}`.localeCompare(`${b.from}|${b.name}`),
    );
    writeFileSync(resolve(dataDir, "unresolved.json"), JSON.stringify(sorted, null, 2));
    log(`  ${sorted.length} unresolvable range(s) recorded in data/unresolved.json\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`\nCrawl failed: ${error instanceof Error ? error.stack : error}\n\n`);
  process.exit(1);
});
