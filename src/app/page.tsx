import Link from "next/link";
import { Suspense } from "react";

import { getGraphTotals, getPortfolio, type PortfolioRow } from "@/lib/queries/portfolio";
import { withDbFallback } from "@/components/db-error";
import {
  CleanBadge,
  EmptyState,
  Panel,
  SeverityBadge,
  SeverityBar,
  Skeleton,
  StatTile,
  formatCount,
} from "@/components/primitives";

/**
 * The dashboard.
 *
 * A server component: the query runs on the server, the driver never reaches the
 * browser, and the page streams. The two data regions are suspended separately,
 * so the cheap totals paint while the portfolio query is still running rather
 * than the whole page waiting on the slowest one.
 */

// The graph only changes when the seed script runs, so serving a cached render
// for a minute is honest rather than a shortcut — and it keeps the free tier's
// half a vCPU from re-running the same traversal for every visitor.
export const revalidate = 60;

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dependency risk overview</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          Six applications, their full production install trees, and every published advisory that
          reaches them. Pick an application to trace a vulnerability back to the one dependency you
          actually control.
        </p>
      </div>

      <Suspense fallback={<TotalsSkeleton />}>
        <Totals />
      </Suspense>

      <Suspense fallback={<PortfolioSkeleton />}>
        <Portfolio />
      </Suspense>
    </div>
  );
}

async function Totals() {
  return withDbFallback("graph totals", getGraphTotals, (totals) => (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatTile label="Packages" value={formatCount(totals.packages)} />
      <StatTile
        label="Versions"
        value={formatCount(totals.versions)}
        hint="what actually installs"
      />
      <StatTile label="Dependency edges" value={formatCount(totals.dependencies)} />
      <StatTile
        label="Maintainers"
        value={formatCount(totals.maintainers)}
        hint="hold publish rights"
      />
      <StatTile
        label="Advisories"
        value={formatCount(totals.advisories)}
        hint="reaching these apps"
      />
    </div>
  ));
}

async function Portfolio() {
  return withDbFallback("application portfolio", getPortfolio, (rows) => {
    if (rows.length === 0) {
      return (
        <Panel title="Applications">
          <EmptyState title="No applications in the graph">
            Run <code className="font-mono text-xs">npm run seed</code> to load the dataset into
            CognoDB.
          </EmptyState>
        </Panel>
      );
    }

    return (
      <Panel
        title="Applications"
        description="Ranked by the number of distinct advisories reaching the production tree."
      >
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <AppRow key={row.slug} row={row} />
          ))}
        </ul>
      </Panel>
    );
  });
}

function AppRow({ row }: { row: PortfolioRow }) {
  const indirectShare =
    row.totalDeps > 0 ? Math.round((row.indirectDeps / row.totalDeps) * 100) : 0;

  return (
    <li>
      <Link
        href={`/apps/${row.slug}`}
        className="group block px-5 py-4 transition-colors hover:bg-bg-subtle"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h3 className="font-mono text-sm font-semibold tracking-tight group-hover:text-accent">
                {row.name}
              </h3>
              <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-faint">
                {row.kind}
              </span>
            </div>
            <p className="mt-1 max-w-xl text-sm text-ink-muted">{row.description}</p>
          </div>

          <div className="flex shrink-0 items-center gap-6">
            <Metric label="direct" value={row.directDeps} />
            <Metric label="total" value={row.totalDeps} />
            <Metric label="deepest" value={row.nestingDepth} suffix="levels" />
            <Metric label="longest chain" value={row.longestChain} suffix="pkgs" />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {row.advisories === 0 ? (
            <CleanBadge>no known advisories</CleanBadge>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {(["CRITICAL", "HIGH", "MODERATE", "LOW"] as const)
                  .filter((severity) => row.severityCounts[severity] > 0)
                  .map((severity) => (
                    <SeverityBadge
                      key={severity}
                      severity={severity}
                      count={row.severityCounts[severity]}
                    />
                  ))}
              </div>
              <span className="text-xs text-ink-faint">
                across {row.vulnerableVersions}{" "}
                {row.vulnerableVersions === 1 ? "version" : "versions"}
              </span>
            </>
          )}

          <span className="ml-auto text-xs text-ink-faint">
            <span className="tnum font-medium text-ink-muted">{indirectShare}%</span> of the tree was
            never chosen directly
          </span>
        </div>

        {row.advisories > 0 && (
          <div className="mt-2.5">
            <SeverityBar counts={row.severityCounts} />
          </div>
        )}
      </Link>
    </li>
  );
}

function Metric({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string | number;
  suffix?: string;
}) {
  return (
    <div className="text-right">
      <div className="tnum text-lg font-semibold leading-none tracking-tight">
        {value}
        {suffix && <span className="ml-1 text-xs font-normal text-ink-faint">{suffix}</span>}
      </div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}

function TotalsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="rounded-lg border border-line bg-panel px-4 py-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-7 w-12" />
        </div>
      ))}
    </div>
  );
}

function PortfolioSkeleton() {
  return (
    <Panel title="Applications" description="Walking the transitive dependency trees…">
      <ul className="divide-y divide-line">
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} className="px-5 py-4">
            <div className="flex items-start justify-between gap-6">
              <div className="flex-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-2 h-3 w-72" />
              </div>
              <div className="flex gap-6">
                {Array.from({ length: 4 }, (_, metric) => (
                  <div key={metric}>
                    <Skeleton className="ml-auto h-5 w-10" />
                    <Skeleton className="ml-auto mt-1.5 h-2.5 w-12" />
                  </div>
                ))}
              </div>
            </div>
            <Skeleton className="mt-3 h-1.5 w-full" />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
