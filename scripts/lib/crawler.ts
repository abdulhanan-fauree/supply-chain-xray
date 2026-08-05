import semver from "semver";

import { MANIFESTS } from "./manifests";
import { getPackument, type Packument } from "./registry";
import { mapLimit } from "./http";
import { formatVersionId } from "../../src/lib/version-id";
import type { DependsOnEdge, UsesEdge, VersionNode } from "../../src/lib/model";

/**
 * Breadth-first walk of the six application manifests.
 *
 * The result is an *install* tree, not a manifest tree: every range is resolved to
 * the single version npm would pick, so the graph describes what lands on disk.
 *
 * Two exclusions matter, both because including them would invent edges no real
 * install has:
 *
 *   - devDependencies are followed from the root applications only. npm does not
 *     install the dev dependencies of your dependencies.
 *   - peerDependencies are not followed at all. A peer is satisfied by a version
 *     already elsewhere in the tree, so an edge for it would double-count.
 */

export type CrawlOptions = {
  /** Soft budget on distinct packages. Checked between levels, never within one. */
  maxPackages: number;
  maxDepth: number;
  concurrency: number;
};

export type UnresolvedRange = {
  /** The app slug or version id that declared the range. */
  from: string;
  name: string;
  range: string;
  reason: string;
};

type ResolveResult =
  | { ok: true; node: VersionNode }
  | { ok: false; reason: string };

/** Range syntaxes npm accepts that do not resolve to a published version. */
const NON_REGISTRY_RANGE =
  /^(git|git\+|https?:|file:|link:|workspace:|npm:|github:|[\w-]+\/[\w.-]+$)/;

export class Crawler {
  private readonly packuments = new Map<string, Packument | null>();
  private readonly expanded = new Set<string>();
  private depthReached = 0;

  readonly versions = new Map<string, VersionNode>();
  readonly dependsOn = new Map<string, DependsOnEdge>();
  readonly uses: UsesEdge[] = [];
  readonly unresolved: UnresolvedRange[] = [];

  constructor(private readonly options: CrawlOptions) {}

  async run(log: (message: string) => void): Promise<void> {
    log(`Resolving direct dependencies of ${MANIFESTS.length} applications`);
    let frontier = await this.resolveManifests();
    log(`  depth 0: ${frontier.length} direct dependencies`);

    for (let depth = 1; depth <= this.options.maxDepth; depth += 1) {
      if (frontier.length === 0) break;
      if (this.distinctPackageCount() >= this.options.maxPackages) {
        log(`  stopping at depth ${depth}: package budget (${this.options.maxPackages}) reached`);
        break;
      }

      frontier = await this.expandLevel(frontier);
      this.depthReached = depth;
      log(
        `  depth ${depth}: +${frontier.length} new versions ` +
          `(${this.versions.size} total, ${this.dependsOn.size} edges)`,
      );
    }
  }

  /** Distinct package names in the graph, sorted for stable downstream batching. */
  packageNames(): string[] {
    return [...this.distinctPackages()].sort();
  }

  /**
   * Packages represented by at least one version in the graph.
   *
   * Deliberately not "packuments fetched": a lookup that resolves to a version
   * already present, or that fails to resolve at all, adds nothing to the graph
   * and must not consume the budget. Counting fetches instead trips the budget an
   * entire level early.
   */
  private distinctPackages(): Set<string> {
    return new Set([...this.versions.values()].map((version) => version.packageName));
  }

  private distinctPackageCount(): number {
    return this.distinctPackages().size;
  }

  maxDepthReached(): number {
    return this.depthReached;
  }

  /** Depth 0: the applications' own manifests, where dev dependencies count. */
  private async resolveManifests(): Promise<string[]> {
    const frontier: string[] = [];

    for (const manifest of MANIFESTS) {
      const declared: Array<{ name: string; range: string; dev: boolean }> = [
        ...Object.entries(manifest.dependencies).map(([name, range]) => ({
          name,
          range,
          dev: false,
        })),
        ...Object.entries(manifest.devDependencies).map(([name, range]) => ({
          name,
          range,
          dev: true,
        })),
      ];

      await mapLimit(declared, this.options.concurrency, async ({ name, range, dev }) => {
        const result = await this.resolve(name, range);
        if (!result.ok) {
          this.unresolved.push({ from: manifest.slug, name, range, reason: result.reason });
          return;
        }
        this.uses.push({ appSlug: manifest.slug, versionId: result.node.id, range, dev });
        frontier.push(result.node.id);
      });
    }

    // Sorted so every run walks the graph in the same order.
    return [...new Set(frontier)].sort();
  }

  /**
   * Expand one level, returning the versions to expand next.
   *
   * The package budget is deliberately not checked inside this method. Checking it
   * mid-level made the crawl non-deterministic: concurrent workers observed
   * different counts depending on interleaving, so two runs of the same manifests
   * produced graphs differing by a few packages — and, because those packages
   * carried advisories, by considerably more downstream. A whole level always
   * completes, which can overshoot the budget slightly. The budget is a
   * convenience; a reproducible dataset is a correctness property.
   */
  private async expandLevel(frontier: readonly string[]): Promise<string[]> {
    const next = new Set<string>();

    await mapLimit(frontier, this.options.concurrency, async (versionId) => {
      const version = this.versions.get(versionId);
      if (!version) return;

      const packument = await this.packument(version.packageName);
      const entry = packument?.versions[version.version];
      if (!entry) return;

      const dependencies: Array<{ name: string; range: string; optional: boolean }> = [
        ...Object.entries(entry.dependencies ?? {}).map(([name, range]) => ({
          name,
          range,
          optional: false,
        })),
        ...Object.entries(entry.optionalDependencies ?? {}).map(([name, range]) => ({
          name,
          range,
          optional: true,
        })),
      ];

      for (const { name, range, optional } of dependencies) {
        const result = await this.resolve(name, range);
        if (!result.ok) {
          this.unresolved.push({ from: versionId, name, range, reason: result.reason });
          continue;
        }
        this.addDependsOn(versionId, result.node.id, range, optional);
        next.add(result.node.id);
      }
    });

    return [...next].filter((id) => !this.expanded.has(id)).sort().map((id) => {
      this.expanded.add(id);
      return id;
    });
  }

  private async packument(name: string): Promise<Packument | null> {
    const cached = this.packuments.get(name);
    if (cached !== undefined) return cached;
    const fetched = await getPackument(name).catch(() => null);
    this.packuments.set(name, fetched);
    return fetched;
  }

  /**
   * Resolve a range the way npm would: the highest published version satisfying
   * it. Prereleases are considered only when nothing stable matches, which is the
   * case for packages that have only ever shipped prereleases.
   */
  private async resolve(name: string, range: string): Promise<ResolveResult> {
    if (NON_REGISTRY_RANGE.test(range.trim())) {
      return { ok: false, reason: "non-registry range" };
    }

    const packument = await this.packument(name);
    if (!packument) return { ok: false, reason: "package not found in registry" };

    const published = Object.keys(packument.versions).filter((version) => semver.valid(version));
    const stable = semver.rsort(published.filter((version) => !semver.prerelease(version)));
    const wanted = /^(|latest)$/.test(range.trim()) ? "*" : range.trim();

    let picked =
      semver.maxSatisfying(stable, wanted, { includePrerelease: false }) ??
      semver.maxSatisfying(published, wanted, { includePrerelease: true });

    // An exact pin that has since been unpublished still deserves a node: an
    // application sitting on an abandoned version is the case worth surfacing.
    if (!picked && semver.valid(wanted)) picked = wanted;
    if (!picked) return { ok: false, reason: `no published version satisfies ${range}` };

    const entry = packument.versions[picked];
    if (!entry) return { ok: false, reason: `version ${picked} missing from packument` };

    const id = formatVersionId(name, picked);
    const existing = this.versions.get(id);
    if (existing) return { ok: true, node: existing };

    const node: VersionNode = {
      id,
      packageName: name,
      version: picked,
      releasesBehind: stable.filter((version) => semver.gt(version, picked)).length,
      isLatest: packument["dist-tags"]?.latest === picked,
      deprecated: Boolean(entry.deprecated),
    };
    this.versions.set(id, node);
    return { ok: true, node };
  }

  private addDependsOn(from: string, to: string, range: string, optional: boolean): void {
    const key = `${from}|${to}`;
    if (this.dependsOn.has(key)) return;
    this.dependsOn.set(key, { fromVersionId: from, toVersionId: to, range, optional });
  }
}
