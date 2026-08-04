import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import {
  deriveFixPoints,
  fixPointConcentration,
  getAppHeader,
  getAppSlugs,
  getBlastRadius,
  getDepthHistogram,
  getLicenseObligations,
  groupByAffectedVersion,
  type AffectedVersionGroup,
  type FixPoint,
} from "@/lib/queries/app-detail";
import { DbError } from "@/lib/db";
import { withDbFallback } from "@/components/db-error";
import { ChainLegend, DependencyChain } from "@/components/dependency-chain";
import {
  CleanBadge,
  EmptyState,
  Panel,
  SeverityBadge,
  Skeleton,
  StatTile,
} from "@/components/primitives";

export const revalidate = 60;

/**
 * Application detail: one app's install tree, and every advisory inside it.
 *
 * The page is ordered by what a person can act on, not by what is easiest to
 * query. Fix points come first — "bump these four dependencies" — because a list
 * of 105 advisories is paralysing while a list of four upgrades is a morning's
 * work. The full blast radius is below it for anyone who wants the detail.
 */

export async function generateStaticParams() {
  try {
    return (await getAppSlugs()).map((slug) => ({ slug }));
  } catch {
    // A build without a reachable database still succeeds; pages render on
    // demand instead. Failing the build here would mean a database blip could
    // block a deploy that has nothing to do with the data.
    return [];
  }
}

export default async function AppDetailPage({ params }: PageProps<"/apps/[slug]">) {
  const { slug } = await params;

  let header;
  try {
    header = await getAppHeader(slug);
  } catch (error) {
    if (error instanceof DbError) {
      // The header is what tells us the app exists, so a database failure here
      // cannot be distinguished from a 404 — show the error rather than claiming
      // the application does not exist.
      return withDbFallback("application", async () => null, () => null);
    }
    throw error;
  }

  if (!header) notFound();

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
          hint={`${header.totalDeps - header.directDeps} you never chose`}
        />
        <StatTile label="Deepest nesting" value={`${header.nestingDepth}`} hint="levels down" />
        <StatTile
          label="Chose vs inherited"
          value={`${Math.round((header.directDeps / Math.max(header.totalDeps, 1)) * 100)}%`}
          hint="share you declared"
        />
      </div>

      <Suspense fallback={<FindingsSkeleton />}>
        <Findings slug={slug} appName={header.name} />
      </Suspense>

      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<PanelSkeleton title="Where the tree sits" rows={7} />}>
          <DepthPanel slug={slug} total={header.totalDeps} />
        </Suspense>
        <Suspense fallback={<PanelSkeleton title="License obligations" rows={3} />}>
          <LicensePanel slug={slug} appName={header.name} />
        </Suspense>
      </div>
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
            <div className="px-5 py-12 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-clean-soft text-clean">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
                  <path d="M6 10.5l2.6 2.5L14 7.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <p className="mt-3 text-sm font-medium">No known advisories reach this app</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
                Every one of its {""}
                installed versions is clear of published OSV advisories today. That is a snapshot,
                not a guarantee — the same tree can light up tomorrow without a single line of your
                code changing.
              </p>
            </div>
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
            }; ${transitive} of those versions were never declared by this app.`}
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
            ? "The vulnerable package itself — upgrade it directly."
            : `Carries ${fix.affectedVersions.length} vulnerable ${
                fix.affectedVersions.length === 1 ? "version" : "versions"
              } further down.`}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        {(["CRITICAL", "HIGH", "MODERATE", "LOW"] as const)
          .filter((severity) => fix.severityCounts[severity] > 0)
          .map((severity) => (
            <SeverityBadge key={severity} severity={severity} count={fix.severityCounts[severity]} />
          ))}
      </div>
    </li>
  );
}

/**
 * One installed version, its path, and every advisory against it.
 *
 * The advisory list is a <details> collapsed by default for anything with more
 * than a couple of findings: the path and the upgrade target are what you act
 * on, and 25 advisory summaries expanded by default would bury them.
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
            {group.depth === 1 ? "you declared this" : `${group.depth} hops down`}
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

function PanelSkeleton({ title, rows }: { title: string; rows: number }) {
  return (
    <Panel title={title} description="Loading…">
      <div className="space-y-3 px-5 py-4">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-5 w-full" />
        ))}
      </div>
    </Panel>
  );
}
