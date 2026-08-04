import Link from "next/link";
import { Suspense } from "react";

import { getChokePoints, type ChokePointRow } from "@/lib/queries/packages";
import { withDbFallback } from "@/components/db-error";
import {
  EmptyState,
  Panel,
  SeverityBadge,
  Skeleton,
  StatTile,
  formatCount,
} from "@/components/primitives";

export const revalidate = 60;

/**
 * Choke points: packages that several applications depend on without any of them
 * having chosen it.
 *
 * The query is a set intersection over transitive closures — which packages appear
 * in N different reachability sets, and how deep in each. That is the shape SQL
 * handles worst: a recursive CTE per application, then a join across their
 * results. The interesting rows are the ones where minimum depth is greater than
 * one, because nobody reviewed those and nobody would notice them changing.
 */
export default function PackagesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shared choke points</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          Packages installed by two or more applications. The ones nobody declared are the ones
          worth knowing about: if any of them broke, several things would break at once, and no
          pull request would have mentioned it.
        </p>
      </div>

      <Suspense fallback={<ListSkeleton />}>
        <List />
      </Suspense>
    </div>
  );
}

async function List() {
  return withDbFallback(
    "choke points",
    () => getChokePoints(2),
    (rows) => {
      if (rows.length === 0) {
        return (
          <Panel title="Choke points">
            <EmptyState title="No package is shared by two or more applications">
              Each application&apos;s dependency tree is entirely its own.
            </EmptyState>
          </Panel>
        );
      }

      const undeclared = rows.filter((row) => row.neverDeclared);
      const allSix = rows.filter((row) => row.appsReached >= 6);
      const vulnerable = rows.filter((row) => row.advisories > 0);

      return (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Shared packages" value={rows.length} hint="in 2+ applications" />
            <StatTile
              label="Never declared"
              value={undeclared.length}
              hint={`${Math.round((undeclared.length / rows.length) * 100)}% of the shared set`}
            />
            <StatTile label="In every app" value={allSix.length} hint="all six trees" />
            <StatTile
              label="Carrying advisories"
              value={vulnerable.length}
              hint="shared and vulnerable"
            />
          </div>

          <Panel
            title="Choke points"
            description="Ranked by how many applications reach them. Depth is the shallowest hop count across those applications."
          >
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <Row key={row.name} row={row} />
              ))}
            </ul>
          </Panel>
        </div>
      );
    },
  );
}

function Row({ row }: { row: ChokePointRow }) {
  return (
    <li>
      <Link
        href={`/packages/${encodeURIComponent(row.name)}`}
        className="group flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3 transition-colors hover:bg-bg-subtle"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium group-hover:text-accent">{row.name}</span>
            {row.latestVersion && (
              <span className="font-mono text-xs text-ink-faint">{row.latestVersion}</span>
            )}
            {row.neverDeclared && (
              <span className="rounded-full border border-line bg-bg-subtle px-2 py-0.5 text-[11px] text-ink-muted">
                nobody declared this
              </span>
            )}
            {row.deprecated && (
              <span className="rounded-full border border-high/25 bg-high-soft px-2 py-0.5 text-[11px] text-high">
                deprecated
              </span>
            )}
            {row.worstSeverity && <SeverityBadge severity={row.worstSeverity} count={row.advisories} />}
          </div>
          {row.description && (
            <p className="mt-0.5 max-w-2xl truncate text-xs text-ink-muted">{row.description}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-5 text-right text-xs">
          <Cell value={row.appsReached} label={row.appsReached === 1 ? "app" : "apps"} />
          <Cell value={`L${row.minDepth}`} label="closest" />
          <Cell value={row.maintainers} label="can publish" />
          <div className="w-16">
            <div className="tnum text-sm font-semibold leading-none">
              {row.weeklyDownloads === null ? "—" : formatCount(row.weeklyDownloads)}
            </div>
            <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-faint">weekly</div>
          </div>
        </div>
      </Link>
    </li>
  );
}

function Cell({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="w-14">
      <div className="tnum text-sm font-semibold leading-none">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-lg border border-line bg-panel px-4 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-12" />
          </div>
        ))}
      </div>
      <Panel title="Choke points" description="Intersecting six transitive closures…">
        <ul className="divide-y divide-line">
          {Array.from({ length: 10 }, (_, index) => (
            <li key={index} className="px-5 py-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="mt-2 h-3 w-64" />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
