/**
 * Builds the dataset: breadth-first walk of six real dependency trees, then
 * enrichment with maintainers, licenses, download counts and OSV advisories.
 *
 * Run:  npm run crawl          (writes data/graph.json)
 *       npm run crawl -- --max-packages 400 --max-depth 6
 *
 * Needs no database. The output is a single JSON document that `npm run seed`
 * loads into CognoDB, which keeps the two concerns separable: a network problem
 * cannot leave the graph half-written, and a reviewer with no network can seed
 * from the committed cache.
 *
 * Modelling decisions worth knowing about:
 *
 *   - The tree is an *install* tree, not a manifest tree. Ranges are resolved to
 *     the single version npm would pick (highest satisfying), so the graph
 *     describes what actually ends up on disk.
 *   - devDependencies are followed only from the root apps. npm does not install
 *     the dev dependencies of your dependencies, so following them would inflate
 *     the graph with edges that do not exist in any real install.
 *   - peerDependencies are not followed. A peer is satisfied by a version
 *     already elsewhere in the tree; adding an edge for it would double-count.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import semver from "semver";

import { MANIFESTS, manifestNodes, type Manifest } from "./lib/manifests";
import {
  categoriseLicense,
  getLatestDoc,
  getPackument,
  getVersionDoc,
  getWeeklyDownloads,
  normaliseLicense,
  packageNodeFrom,
  parseRepo,
  type Packument,
} from "./lib/registry";
import {
  dedupeByAliasCluster,
  fetchAdvisories,
  matchAffectedVersions,
  queryAdvisoryIds,
  toVulnerabilityNode,
} from "./lib/osv";
import { mapLimit, stats as httpStats } from "./lib/http";
import {
  MAX_TRAVERSAL_DEPTH,
  type AffectsEdge,
  type DependsOnEdge,
  type GraphDataset,
  type HasVersionEdge,
  type HostedInEdge,
  type LicenseNode,
  type LicensedUnderEdge,
  type MaintainerNode,
  type MaintainsEdge,
  type PackageNode,
  type RepoNode,
  type UsesEdge,
  type VersionNode,
} from "../src/lib/model";

type Options = { maxPackages: number; maxDepth: number; concurrency: number };

function parseOptions(argv: string[]): Options {
  const read = (flag: string, fallback: number) => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    // Sized for the free c0 instance: 256 MB RAM and 1 GB disk. This lands
    // around 1-2k versions and 10-20k relationships, which is plenty to make
    // the traversals interesting without making them slow.
    maxPackages: read("--max-packages", 900),
    maxDepth: read("--max-depth", MAX_TRAVERSAL_DEPTH),
    concurrency: read("--concurrency", 8),
  };
}

/** Ranges npm accepts that are not semver and cannot be resolved to a version. */
function isResolvableRange(range: string): boolean {
  return !/^(git|git\+|https?:|file:|link:|workspace:|npm:|github:|[\w-]+\/[\w.-]+$)/.test(range.trim());
}

class Crawler {
  private readonly packumentCache = new Map<string, Packument | null>();

  readonly versions = new Map<string, VersionNode>();
  readonly dependsOn = new Map<string, DependsOnEdge>();
  readonly uses: UsesEdge[] = [];
  readonly unresolved: Array<{ from: string; name: string; range: string; reason: string }> = [];

  private maxDepthReached = 0;

  constructor(private readonly options: Options) {}

  private async packument(name: string): Promise<Packument | null> {
    if (this.packumentCache.has(name)) return this.packumentCache.get(name) ?? null;
    const doc = await getPackument(name).catch(() => null);
    this.packumentCache.set(name, doc);
    return doc;
  }

  /** Stable, published versions in descending semver order. */
  private stableVersions(packument: Packument): string[] {
    return semver.rsort(
      Object.keys(packument.versions).filter((v) => semver.valid(v) && !semver.prerelease(v)),
    );
  }

  /**
   * Resolve a range the way npm would: the highest published version that
   * satisfies it. Falls back to including prereleases only if nothing stable
   * matches, which is what happens for packages that only ship prereleases.
   */
  private async resolve(
    name: string,
    range: string,
  ): Promise<{ node: VersionNode; entryDeps: Packument["versions"][string] } | { error: string }> {
    if (!isResolvableRange(range)) return { error: "non-registry range" };

    const packument = await this.packument(name);
    if (!packument) return { error: "package not found in registry" };

    const stable = this.stableVersions(packument);
    const all = Object.keys(packument.versions).filter((v) => semver.valid(v));
    const wanted = range.trim() === "" || range.trim() === "latest" ? "*" : range.trim();

    let picked =
      semver.maxSatisfying(stable, wanted, { includePrerelease: false }) ??
      semver.maxSatisfying(all, wanted, { includePrerelease: true });

    // A pinned version that has since been unpublished still deserves a node —
    // legacy-admin's whole point is sitting on versions nobody maintains.
    if (!picked && semver.valid(wanted)) picked = wanted;
    if (!picked) return { error: `no published version satisfies ${range}` };

    const entry = packument.versions[picked];
    if (!entry) return { error: `version ${picked} missing from packument` };

    const id = `${name}@${picked}`;
    const existing = this.versions.get(id);
    if (existing) return { node: existing, entryDeps: entry };

    const latest = packument["dist-tags"]?.latest ?? null;
    const node: VersionNode = {
      id,
      packageName: name,
      version: picked,
      releasesBehind: stable.filter((v) => semver.gt(v, picked!)).length,
      isLatest: latest === picked,
      deprecated: Boolean(entry.deprecated),
    };
    this.versions.set(id, node);
    return { node, entryDeps: entry };
  }

  private addDependsOn(from: string, to: string, range: string, optional: boolean): void {
    const key = `${from}|${to}`;
    if (!this.dependsOn.has(key)) {
      this.dependsOn.set(key, { fromVersionId: from, toVersionId: to, range, optional });
    }
  }

  /** Depth 0: the apps' own manifests, where dev dependencies do count. */
  private async seedRoots(): Promise<string[]> {
    const frontier: string[] = [];

    for (const manifest of MANIFESTS) {
      const direct: Array<[string, string, boolean]> = [
        ...Object.entries(manifest.dependencies).map(
          ([name, range]) => [name, range, false] as [string, string, boolean],
        ),
        ...Object.entries(manifest.devDependencies).map(
          ([name, range]) => [name, range, true] as [string, string, boolean],
        ),
      ];

      await mapLimit(direct, this.options.concurrency, async ([name, range, dev]) => {
        const result = await this.resolve(name, range);
        if ("error" in result) {
          this.unresolved.push({ from: manifest.slug, name, range, reason: result.error });
          return;
        }
        this.uses.push({ appSlug: manifest.slug, versionId: result.node.id, range, dev });
        frontier.push(result.node.id);
      });
    }

    return [...new Set(frontier)];
  }

  async run(): Promise<void> {
    process.stdout.write("Resolving direct dependencies of 6 apps\n");
    let frontier = await this.seedRoots();
    process.stdout.write(`  depth 0: ${frontier.length} direct dependencies\n`);

    for (let depth = 1; depth <= this.options.maxDepth; depth += 1) {
      if (!frontier.length) break;
      if (this.uniquePackageCount() >= this.options.maxPackages) {
        process.stdout.write(
          `  stopping at depth ${depth}: package cap (${this.options.maxPackages}) reached\n`,
        );
        break;
      }

      const next = new Set<string>();

      await mapLimit(frontier, this.options.concurrency, async (versionId) => {
        const node = this.versions.get(versionId);
        if (!node) return;
        const packument = await this.packument(node.packageName);
        const entry = packument?.versions[node.version];
        if (!entry) return;

        const deps: Array<[string, string, boolean]> = [
          ...Object.entries(entry.dependencies ?? {}).map(
            ([name, range]) => [name, range, false] as [string, string, boolean],
          ),
          ...Object.entries(entry.optionalDependencies ?? {}).map(
            ([name, range]) => [name, range, true] as [string, string, boolean],
          ),
        ];

        for (const [name, range, optional] of deps) {
          if (this.uniquePackageCount() >= this.options.maxPackages && !this.knows(name)) continue;
          const result = await this.resolve(name, range);
          if ("error" in result) {
            this.unresolved.push({ from: versionId, name, range, reason: result.error });
            continue;
          }
          this.addDependsOn(versionId, result.node.id, range, optional);
          next.add(result.node.id);
        }
      });

      // Only versions we have not already expanded advance to the next level.
      frontier = [...next].filter((id) => !this.expanded.has(id));
      frontier.forEach((id) => this.expanded.add(id));
      this.maxDepthReached = Math.max(this.maxDepthReached, depth);
      process.stdout.write(
        `  depth ${depth}: +${frontier.length} new versions (${this.versions.size} total, ${this.dependsOn.size} edges)\n`,
      );
    }
  }

  private readonly expanded = new Set<string>();

  private knows(packageName: string): boolean {
    return this.packumentCache.has(packageName);
  }

  packageNames(): string[] {
    return [...new Set([...this.versions.values()].map((v) => v.packageName))];
  }

  private uniquePackageCount(): number {
    return new Set([...this.versions.values()].map((v) => v.packageName)).size;
  }

  depthReached(): number {
    return this.maxDepthReached;
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const started = Date.now();

  const crawler = new Crawler(options);
  await crawler.run();

  const packageNames = crawler.packageNames();
  process.stdout.write(`\nEnriching ${packageNames.length} packages\n`);

  // Current metadata: maintainers, description, repository, homepage.
  const latestDocs = new Map(
    await mapLimit(packageNames, options.concurrency, async (name) => {
      const doc = await getLatestDoc(name).catch(() => null);
      return [name, doc] as const;
    }),
  );
  process.stdout.write(`  fetched ${latestDocs.size} package metadata documents\n`);

  const downloads = await getWeeklyDownloads(packageNames);
  process.stdout.write(`  fetched download counts for ${downloads.size} packages\n`);

  // Per-version licenses. Skipped when the resolved version *is* latest, since
  // that document is already in hand.
  const versionList = [...crawler.versions.values()];
  const licenseByVersion = new Map(
    await mapLimit(versionList, options.concurrency, async (version) => {
      const latest = latestDocs.get(version.packageName) ?? null;
      const doc =
        latest && latest.version === version.version
          ? latest
          : await getVersionDoc(version.packageName, version.version).catch(() => null);
      return [version.id, normaliseLicense(doc ?? latest)] as const;
    }),
  );
  process.stdout.write(`  resolved licenses for ${licenseByVersion.size} versions\n`);

  // Advisories.
  process.stdout.write(`\nQuerying OSV for ${packageNames.length} packages\n`);
  const advisoryIdsByPackage = await queryAdvisoryIds(packageNames);
  const allIds = [...new Set([...advisoryIdsByPackage.values()].flat())];
  process.stdout.write(
    `  ${advisoryIdsByPackage.size} packages carry advisories, ${allIds.length} distinct advisories\n`,
  );
  const rawAdvisories = await fetchAdvisories(allIds);
  const { canonical: advisories, canonicalIdOf } = dedupeByAliasCluster(rawAdvisories);
  process.stdout.write(
    `  collapsed ${rawAdvisories.length} records into ${advisories.length} distinct issues by alias cluster\n`,
  );
  const advisoryById = new Map(advisories.map((a) => [a.id, a]));

  // Build node and edge collections.
  const packages: PackageNode[] = packageNames.map((name) =>
    packageNodeFrom(name, latestDocs.get(name) ?? null, null, downloads.get(name) ?? null),
  );
  // latestVersion comes from dist-tags, which lives on the packument; the latest
  // doc's own version is the same value, so read it from there.
  for (const pkg of packages) {
    pkg.latestVersion = latestDocs.get(pkg.name)?.version ?? pkg.latestVersion;
  }

  const hasVersion: HasVersionEdge[] = versionList.map((v) => ({
    packageName: v.packageName,
    versionId: v.id,
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
    const doc = latestDocs.get(name);
    for (const maintainer of doc?.maintainers ?? []) {
      const npmUser = maintainer.name?.trim();
      if (!npmUser) continue;
      if (!maintainers.has(npmUser)) maintainers.set(npmUser, { npmUser });
      maintains.push({ npmUser, packageName: name });
    }
    const repo = parseRepo(doc ?? null);
    if (repo) {
      if (!repos.has(repo.id)) repos.set(repo.id, repo);
      hostedIn.push({ packageName: name, repoId: repo.id });
    }
  }

  // AFFECTS: only for versions actually in the graph, and only where the
  // advisory's own range says so.
  const versionsByPackage = new Map<string, string[]>();
  for (const version of versionList) {
    const list = versionsByPackage.get(version.packageName) ?? [];
    list.push(version.version);
    versionsByPackage.set(version.packageName, list);
  }

  // Matching runs against every raw record, not just the cluster survivor:
  // collapsed records sometimes declare a *wider* vulnerable range than the one
  // that wins, and dropping their ranges would under-report. Results are then
  // attributed to the canonical id, and where a cluster disagrees about the fix
  // we keep the highest fixed version — that is the one that actually clears
  // every record in the cluster.
  const rawById = new Map(rawAdvisories.map((a) => [a.id, a]));
  const affectsByKey = new Map<string, AffectsEdge>();
  const usedAdvisoryIds = new Set<string>();

  for (const [packageName, ids] of advisoryIdsByPackage) {
    const candidates = versionsByPackage.get(packageName) ?? [];
    if (!candidates.length) continue;

    for (const id of ids) {
      const advisory = rawById.get(id);
      if (!advisory) continue;
      const osvId = canonicalIdOf.get(id) ?? id;
      if (!advisoryById.has(osvId)) continue;

      for (const match of matchAffectedVersions(advisory, packageName, candidates)) {
        const versionId = `${packageName}@${match.version}`;
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
          if (
            match.fixedIn &&
            (!existing.fixedIn ||
              (semver.valid(match.fixedIn) &&
                semver.valid(existing.fixedIn) &&
                semver.gt(match.fixedIn, existing.fixedIn)))
          ) {
            existing.fixedIn = match.fixedIn;
          }
          if (!existing.vulnerableRange.includes(match.vulnerableRange)) {
            existing.vulnerableRange = `${existing.vulnerableRange} || ${match.vulnerableRange}`;
          }
        }
        usedAdvisoryIds.add(osvId);
      }
    }
  }

  const affects: AffectsEdge[] = [...affectsByKey.values()];

  // Only advisories that hit a version in the graph become nodes. An advisory
  // for a version nobody installs is noise, not signal.
  const vulnerabilities = advisories
    .filter((a) => usedAdvisoryIds.has(a.id))
    .map(toVulnerabilityNode);

  const dataset: GraphDataset = {
    generatedAt: new Date().toISOString(),
    stats: {
      packages: packages.length,
      versions: versionList.length,
      dependsOn: crawler.dependsOn.size,
      vulnerabilities: vulnerabilities.length,
      affects: affects.length,
      maintainers: maintainers.size,
      maxDepthReached: crawler.depthReached(),
      unresolved: crawler.unresolved.length,
    },
    apps: manifestNodes(),
    packages,
    versions: versionList,
    maintainers: [...maintainers.values()],
    licenses: [...licenses.values()],
    repos: [...repos.values()],
    vulnerabilities,
    uses: crawler.uses,
    hasVersion,
    dependsOn: [...crawler.dependsOn.values()],
    licensedUnder,
    maintains,
    hostedIn,
    affects,
  };

  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  const outPath = resolve(process.cwd(), "data/graph.json");
  writeFileSync(outPath, JSON.stringify(dataset, null, 2));

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    [
      "",
      `Wrote ${outPath}`,
      "",
      `  apps               ${dataset.apps.length}`,
      `  packages           ${dataset.stats.packages}`,
      `  versions           ${dataset.stats.versions}`,
      `  DEPENDS_ON         ${dataset.stats.dependsOn}`,
      `  maintainers        ${dataset.stats.maintainers}`,
      `  licenses           ${dataset.licenses.length}`,
      `  repos              ${dataset.repos.length}`,
      `  vulnerabilities    ${dataset.stats.vulnerabilities}`,
      `  AFFECTS            ${dataset.stats.affects}`,
      `  max depth reached  ${dataset.stats.maxDepthReached}`,
      `  unresolved ranges  ${dataset.stats.unresolved}`,
      "",
      `  http: ${httpStats.hits} cache hits, ${httpStats.misses} fetched, ${httpStats.failures} failed`,
      `  took ${seconds}s`,
      "",
    ].join("\n"),
  );

  if (crawler.unresolved.length) {
    writeFileSync(
      resolve(process.cwd(), "data/unresolved.json"),
      JSON.stringify(crawler.unresolved, null, 2),
    );
    process.stdout.write(
      `  ${crawler.unresolved.length} unresolvable range(s) recorded in data/unresolved.json\n\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`\nCrawl failed: ${error instanceof Error ? error.stack : error}\n\n`);
  process.exit(1);
});

export type { Manifest };
