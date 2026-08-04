import Link from "next/link";
import { Suspense } from "react";

import {
  getSoleMaintainers,
  getTrustConcentration,
  summariseTrust,
  type SoleMaintainerRow,
  type TrustRow,
} from "@/lib/queries/maintainers";
import { getGraphTotals } from "@/lib/queries/portfolio";
import { withDbFallback } from "@/components/db-error";
import {
  EmptyState,
  Panel,
  SeverityBadge,
  Skeleton,
  StatTile,
  formatCount,
} from "@/components/primitives";
import { Pagination, paginate } from "@/components/pagination";

export const revalidate = 60;

/**
 * Trust concentration: if one npm account were compromised today, how much of
 * this software could that person publish to?
 *
 * The most useful question in the application and the least visible one anywhere
 * else. It is not about vulnerabilities — none of these accounts has done
 * anything wrong — it is about how much implicit trust a dependency tree hands to
 * people its owners have never heard of.
 */
// Two independent lists on one page, so each needs its own search param.
const TRUST_PAGE_SIZE = 25;
const SOLE_PAGE_SIZE = 25;

export default async function MaintainersPage({ searchParams }: PageProps<"/maintainers">) {
  const params = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Trust concentration</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          Every npm account that can publish a new version of something these applications install.
          Not a list of suspects — a measure of how much implicit trust a dependency tree hands to
          people nobody chose.
        </p>
      </div>

      <Suspense fallback={<TrustSkeleton />}>
        <Trust params={params} />
      </Suspense>

      <Suspense fallback={<PanelSkeleton title="Bus factor of one" rows={8} />}>
        <SoleMaintainers params={params} />
      </Suspense>
    </div>
  );
}

async function Trust({ params }: { params: Record<string, string | string[] | undefined> }) {
  return withDbFallback(
    "trust concentration",
    async () => {
      const [rows, totals] = await Promise.all([getTrustConcentration(), getGraphTotals()]);
      return { rows, totals };
    },
    ({ rows, totals }) => {
      if (rows.length === 0) {
        return (
          <Panel title="Publish rights">
            <EmptyState title="No maintainer data in the graph" />
          </Panel>
        );
      }

      const summary = summariseTrust(rows, totals.packages);
      const transitiveOnly = rows.filter((row) => row.entirelyTransitive).length;
      const deep = rows.filter((row) => row.minDepth >= 4).length;
      const page = paginate(rows, params.trust as string | undefined, TRUST_PAGE_SIZE);

      return (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Accounts" value={summary.maintainers} hint="hold publish rights" />
            <StatTile
              label={`Top ${summary.topCount} reach`}
              value={`${summary.share}%`}
              hint={`${summary.topCoverage} of ${summary.totalPackages} packages`}
            />
            <StatTile
              label="Never declared"
              value={transitiveOnly}
              hint="reach you only indirectly"
            />
            <StatTile label="Four hops or deeper" value={deep} hint="below any review" />
          </div>

          <Panel
            title="Publish rights, ranked"
            description="Packages counted are only those some application actually installs. Depth range shows how close to, and how far from, a declared dependency their code sits."
          >
            <ul className="divide-y divide-line">
              {page.items.map((row) => (
                <TrustRowView key={row.npmUser} row={row} />
              ))}
            </ul>
            <Pagination
              page={page}
              basePath="/maintainers"
              param="trust"
              searchParams={params}
              label="accounts"
            />
          </Panel>
        </div>
      );
    },
  );
}

function TrustRowView({ row }: { row: TrustRow }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`https://www.npmjs.com/~${row.npmUser}`}
            className="font-mono text-sm font-medium hover:text-accent"
          >
            {row.npmUser}
          </a>
          {row.entirelyTransitive && (
            <span className="rounded-full border border-line bg-bg-subtle px-2 py-0.5 text-[11px] text-ink-muted">
              nobody declared their packages
            </span>
          )}
          {row.worstSeverity && <SeverityBadge severity={row.worstSeverity} count={row.advisories} />}
        </div>
        <p className="mt-1 truncate font-mono text-xs text-ink-faint">
          {row.samplePackages.join(", ")}
          {row.packages > row.samplePackages.length &&
            ` +${row.packages - row.samplePackages.length} more`}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-5 text-right text-xs">
        <div className="w-16">
          <div className="tnum text-sm font-semibold leading-none">{row.packages}</div>
          <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-faint">packages</div>
        </div>
        <div className="w-14">
          <div className="tnum text-sm font-semibold leading-none">{row.appsReached}</div>
          <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-faint">
            {row.appsReached === 1 ? "app" : "apps"}
          </div>
        </div>
        <div className="w-16">
          <div className="tnum text-sm font-semibold leading-none">
            {row.minDepth === row.maxDepth ? `L${row.minDepth}` : `L${row.minDepth}–${row.maxDepth}`}
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-faint">depth</div>
        </div>
        <div className="hidden w-32 flex-wrap gap-1 sm:flex">
          {row.appSlugs.slice(0, 3).map((slug) => (
            <Link
              key={slug}
              href={`/apps/${slug}`}
              className="rounded border border-line bg-bg-subtle px-1 py-0.5 font-mono text-[10px] text-ink-faint hover:text-ink"
            >
              {slug}
            </Link>
          ))}
        </div>
      </div>
    </li>
  );
}

async function SoleMaintainers({ params }: { params: Record<string, string | string[] | undefined> }) {
  return withDbFallback(
    "sole maintainers",
    getSoleMaintainers,
    (rows) => {
      const page = paginate(rows, params.sole as string | undefined, SOLE_PAGE_SIZE);
      return (
      <Panel
        title="Bus factor of one"
        description={
          rows.length === 0
            ? "Every installed package has more than one account able to publish it."
            : `${rows.length} installed packages have exactly one account able to publish them. No second pair of eyes, in production.`
        }
      >
        {rows.length === 0 ? (
          <EmptyState title="No single-maintainer packages" />
        ) : (
          <ul className="divide-y divide-line">
            {page.items.map((row) => (
              <SoleRow key={row.packageName} row={row} />
            ))}
          </ul>
        )}
        {rows.length > 0 && (
          <Pagination
            page={page}
            basePath="/maintainers"
            param="sole"
            searchParams={params}
            label="single-maintainer packages"
          />
        )}
      </Panel>
      );
    },
  );
}

function SoleRow({ row }: { row: SoleMaintainerRow }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/packages/${encodeURIComponent(row.packageName)}`}
          className="font-mono text-sm hover:text-accent"
        >
          {row.packageName}
        </Link>
        <span className="text-xs text-ink-faint">
          maintained by <span className="font-mono text-ink-muted">{row.npmUser}</span>
        </span>
      </div>
      <div className="flex items-center gap-4 text-xs text-ink-faint">
        <span className="tnum">
          {row.weeklyDownloads === null ? "—" : formatCount(row.weeklyDownloads)} weekly
        </span>
        <span>
          {row.appsReached} {row.appsReached === 1 ? "app" : "apps"}
        </span>
        <span>{row.minDepth === 1 ? "declared" : `L${row.minDepth}`}</span>
      </div>
    </li>
  );
}

function TrustSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-lg border border-line bg-panel px-4 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-14" />
          </div>
        ))}
      </div>
      <PanelSkeleton title="Publish rights, ranked" rows={10} />
    </div>
  );
}

function PanelSkeleton({ title, rows }: { title: string; rows: number }) {
  return (
    <Panel title={title} description="Joining accounts to installed versions…">
      <div className="space-y-3 px-5 py-4">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-5 w-full" />
        ))}
      </div>
    </Panel>
  );
}
