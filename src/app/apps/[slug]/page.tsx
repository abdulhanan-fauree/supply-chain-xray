import Link from "next/link";
import { Suspense } from "react";

import {
  deriveFixPoints,
  fixPointConcentration,
  getAppHeader,
  getAppSlugs,
  getBlastRadius,
  getDepthHistogram,
  getLicenseObligations,
  getTreeMap,
  groupByAffectedVersion,
  type AffectedVersionGroup,
  type FixPoint,
} from "@/lib/queries/app-detail";
import { loadOrNotFound, withDbFallback } from "@/components/db-error";
import { ChainLegend, DependencyChain } from "@/components/dependency-chain";
import { TreeMap } from "@/components/tree-map";
import {
  CleanBadge,
  CleanState,
  SeverityBadge,
  EmptyState,
  Panel,
  PanelSkeleton,
  SeverityBadges,
  Skeleton,
  StatTile,
} from "@/components/primitives";

// Next.js requires route segment config to be a statically analysable literal, so
// this cannot be imported from lib/config. Keep the value in step with the note
// on caching there.
export const revalidate = 60;

/**
 * Application detail: one install tree, and every advisory inside it.
 *
 * Ordered by what is actionable rather than by what is cheapest to query. Fix
 * points lead, because a list of a hundred advisories is paralysing while a list
 * of four upgrades is a morning's work; the full blast radius follows for anyone
 * who wants the detail.
 */

export async function generateStaticParams() {
  try {
    return (await getAppSlugs()).map((slug) => ({ slug }));
  } catch {
    // A build without a reachable database still succeeds, with pages rendered
    // on demand instead. Failing here would let a transient database problem
    // block a deploy that has nothing to do with the data.
    return [];
  }
}

export default async function AppDetailPage({ params }: PageProps<"/apps/[slug]">) {
  const { slug } = await params;

  const loaded = await loadOrNotFound("application", () => getAppHeader(slug));
  if ("errorState" in loaded) return loaded.errorState;
  const header = loaded.data;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/"
          className="text-xs text-ink-muted transition-colors hover:text-ink"
        >
          ← All applications
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{header.name}</h1>
          <span className="rounded border border-line px-2 py-0.5 text-xs text-ink-faint">
            {header.kind}
          </span>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">{header.description}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Declared"
          value={header.directDeps}
          hint={`+${header.devDeps} dev, not shipped`}
        />
        <StatTile
          label="Actually installed"
          value={header.totalDeps}
          hint={`${header.totalDeps - header.directDeps} arrived transitively`}
        />
        <StatTile label="Deepest nesting" value={`${header.nestingDepth}`} hint="levels down" />
        <StatTile
          label="Chose vs inherited"
          value={`${Math.round((header.directDeps / Math.max(header.totalDeps, 1)) * 100)}%`}
          hint="share declared directly"
        />
      </div>

      <Suspense fallback={<PanelSkeleton title="The install tree" rows={7} />}>
        <TreePanel slug={slug} />
      </Suspense>

      <Suspense fallback={<FindingsSkeleton />}>
        <Findings slug={slug} appName={header.name} />
      </Suspense>

      {/*
        Stacked rather than side by side: license chains run four links deep and
        overflow a half-width column, and the depth histogram is a horizontal bar
        chart that benefits from the width.
      */}
      <Suspense fallback={<PanelSkeleton title="Where the tree sits" rows={7} />}>
        <DepthPanel slug={slug} total={header.totalDeps} />
      </Suspense>
      <Suspense fallback={<PanelSkeleton title="License obligations" rows={3} />}>
        <LicensePanel slug={slug} appName={header.name} />
      </Suspense>
    </div>
  );
}

async function Findings({ slug, appName }: { slug: string; appName: string }) {
  return withDbFallback(
    "vulnerability blast radius",
    () => getBlastRadius(slug),
    (entries) => {
      if (entries.length === 0) {
        return (
          <Panel title="Vulnerability blast radius">
            <CleanState title="No known advisories reach this application">
              Every installed version is clear of published OSV advisories today. That is a
              snapshot, not a guarantee — the same tree can light up tomorrow without a line of
              code changing.
            </CleanState>
          </Panel>
        );
      }

      const fixPoints = deriveFixPoints(entries);
      const groups = groupByAffectedVersion(entries);
      const concentration = fixPointConcentration(fixPoints, entries.length);
      const transitive = groups.filter((group) => group.depth > 1).length;

      return (
        <div className="space-y-6">
          <Panel
            title="Fix points"
            description={
              fixPoints.length === 1
                ? `One direct dependency carries all ${entries.length} findings.`
                : `${fixPoints.length} direct dependencies carry all ${entries.length} findings — the ${concentration.count} biggest account for ${concentration.covered} of them (${concentration.share}%).`
            }
          >
            <ul className="divide-y divide-line">
              {fixPoints.map((fix) => (
                <FixPointRow key={fix.entryPoint} fix={fix} />
              ))}
            </ul>
          </Panel>

          <Panel
            title="Vulnerability blast radius"
            description={`${entries.length} findings across ${groups.length} installed ${
              groups.length === 1 ? "version" : "versions"
            }; ${transitive} of those versions were never declared.`}
            action={<ChainLegend />}
          >
            <ul className="divide-y divide-line">
              {groups.map((group) => (
                <AffectedVersionRow key={group.versionId} group={group} appName={appName} />
              ))}
            </ul>
          </Panel>
        </div>
      );
    },
  );
}

function FixPointRow({ fix }: { fix: FixPoint }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/packages/${encodeURIComponent(fix.entryPackage)}`}
            className="font-mono text-sm font-medium hover:text-accent"
          >
            {fix.entryPoint}
          </Link>
          {fix.entryRange && (
            <span className="font-mono text-xs text-ink-faint">declared {fix.entryRange}</span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-ink-muted">
          {fix.isDirect
            ? "The vulnerable package itself — upgrade in place."
            : `Carries ${fix.affectedVersions.length} vulnerable ${
                fix.affectedVersions.length === 1 ? "version" : "versions"
              } further down.`}
        </p>
      </div>
      <SeverityBadges counts={fix.severityCounts} />
    </li>
  );
}

/**
 * One installed version, its path, and every advisory against it.
 *
 * The advisory list collapses by default past a couple of findings. The path and
 * the upgrade target are the actionable parts; two dozen expanded summaries would
 * bury them.
 */
function AffectedVersionRow({
  group,
  appName,
}: {
  group: AffectedVersionGroup;
  appName: string;
}) {
  const many = group.advisories.length > 2;

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={group.worstSeverity} />
            <Link
              href={`/packages/${encodeURIComponent(group.packageName)}`}
              className="font-mono text-sm font-medium hover:text-accent"
            >
              {group.versionId}
            </Link>
            <span className="text-xs text-ink-faint">
              {group.advisories.length}{" "}
              {group.advisories.length === 1 ? "advisory" : "advisories"}
            </span>
          </div>
        </div>

        <div className="shrink-0 text-right text-xs">
          <div className="text-ink-muted">
            {group.depth === 1 ? "declared directly" : `${group.depth} hops down`}
          </div>
          <div className="mt-0.5 font-mono text-ink-faint">
            {group.clearedBy ? `cleared by ${group.clearedBy}` : "no fix published"}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <DependencyChain chain={group.chain} severity={group.worstSeverity} appName={appName} />
      </div>

      <details className="mt-2.5" open={!many}>
        <summary
          className={`cursor-pointer text-xs font-medium text-ink-faint transition-colors hover:text-ink-muted ${
            many ? "" : "sr-only"
          }`}
        >
          {group.advisories.length} {group.advisories.length === 1 ? "advisory" : "advisories"} on
          this version
        </summary>
        <ul className="mt-2 space-y-1.5 border-l border-line pl-3">
          {group.advisories.map((advisory) => (
            <li key={advisory.osvId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <SeverityBadge severity={advisory.severity} />
              <Link
                href={`/vulnerabilities/${encodeURIComponent(advisory.osvId)}`}
                className="font-mono text-xs hover:text-accent"
              >
                {advisory.osvId}
              </Link>
              <span className="text-sm text-ink-muted">{advisory.summary}</span>
              <span className="font-mono text-xs text-ink-faint">{advisory.vulnerableRange}</span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

async function TreePanel({ slug }: { slug: string }) {
  return withDbFallback(
    "install tree",
    () => getTreeMap(slug),
    (nodes) =>
      nodes.length === 0 ? (
        <Panel title="The install tree">
          <EmptyState title="No dependencies recorded" />
        </Panel>
      ) : (
        <Panel
          title="The install tree"
          description="One cell per installed version, grouped by how far it sits from the application. Coloured cells carry advisories."
        >
          <TreeMap nodes={nodes} />
        </Panel>
      ),
  );
}

async function DepthPanel({ slug, total }: { slug: string; total: number }) {
  return withDbFallback(
    "dependency depth",
    () => getDepthHistogram(slug),
    (buckets) => {
      if (buckets.length === 0) {
        return (
          <Panel title="Where the tree sits">
            <EmptyState title="No dependencies recorded" />
          </Panel>
        );
      }

      const widest = Math.max(...buckets.map((bucket) => bucket.count));

      return (
        <Panel
          title="Where the tree sits"
          description="How many installed versions sit at each level of nesting."
        >
          <div className="space-y-2 px-5 py-4">
            {buckets.map((bucket) => (
              <div key={bucket.depth} className="flex items-center gap-3">
                <span className="w-14 shrink-0 text-xs text-ink-faint">
                  {bucket.depth === 1 ? "direct" : `level ${bucket.depth}`}
                </span>
                <div className="h-5 flex-1 overflow-hidden rounded bg-bg-subtle">
                  <div
                    className={`h-full rounded ${bucket.depth === 1 ? "bg-accent" : "bg-line-strong"}`}
                    style={{ width: `${Math.max((bucket.count / widest) * 100, 2)}%` }}
                  />
                </div>
                <span className="tnum w-16 shrink-0 text-right text-xs text-ink-muted">
                  {bucket.count}
                  <span className="ml-1 text-ink-faint">
                    {Math.round((bucket.count / total) * 100)}%
                  </span>
                </span>
              </div>
            ))}
          </div>
        </Panel>
      );
    },
  );
}

async function LicensePanel({ slug, appName }: { slug: string; appName: string }) {
  return withDbFallback(
    "license obligations",
    () => getLicenseObligations(slug),
    (findings) => (
      <Panel
        title="License obligations"
        description="Dependencies whose licence is not plainly permissive, and what pulled them in."
      >
        {findings.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <CleanBadge>all permissive</CleanBadge>
            <p className="mx-auto mt-3 max-w-sm text-sm text-ink-muted">
              Every installed version is MIT, Apache-2.0, BSD, ISC or similar. This is the common
              case for npm and not a weakness of the query — an{" "}
              <span className="font-mono text-xs">AND</span> expression containing LGPL, or a
              missing licence field, would appear here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {findings.map((finding) => (
              <li key={finding.versionId} className="px-5 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-sm">{finding.versionId}</span>
                  <span className="rounded-full border border-moderate/25 bg-moderate-soft px-2 py-0.5 text-xs font-medium text-moderate">
                    {finding.category.replace("-", " ")}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-ink-muted">{finding.spdxId}</p>
                <div className="mt-2">
                  <DependencyChain chain={finding.chain} appName={appName} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    ),
  );
}

function FindingsSkeleton() {
  return (
    <div className="space-y-6">
      <PanelSkeleton title="Fix points" rows={4} />
      <Panel title="Vulnerability blast radius" description="Tracing every advisory to its path…">
        <ul className="divide-y divide-line">
          {Array.from({ length: 4 }, (_, index) => (
            <li key={index} className="px-5 py-4">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="mt-2 h-4 w-full max-w-lg" />
              <Skeleton className="mt-3 h-7 w-80" />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

