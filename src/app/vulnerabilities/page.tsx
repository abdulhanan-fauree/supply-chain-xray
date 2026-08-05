import Link from "next/link";
import { Suspense } from "react";

import { getVulnerabilityList, type VulnerabilityListRow } from "@/lib/queries/vulnerabilities";
import { withDbFallback } from "@/components/db-error";
import { PAGE_SIZE } from "@/lib/config";
import { EmptyState, Panel, SeverityBadge, Skeleton } from "@/components/primitives";
import { Pagination, paginate } from "@/components/pagination";
import { FilterChips } from "@/components/filter-chips";
import { SEVERITY_ORDER } from "@/lib/severity";

// Next.js requires route segment config to be a statically analysable literal, so
// this cannot be imported from lib/config. Keep the value in step with the note
// on caching there.
export const revalidate = 60;

/**
 * Every advisory reaching the portfolio, ranked by blast radius before severity.
 * A moderate issue in a package several applications share is a larger problem
 * than a critical one in a single abandoned service.
 */

export default async function VulnerabilitiesPage({
  searchParams,
}: PageProps<"/vulnerabilities">) {
  const params = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Advisories</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          Published OSV advisories that reach at least one application&apos;s production install
          tree, ranked by blast radius first and severity second — a moderate issue in a package
          several applications share matters more than a critical one in a single abandoned service.
        </p>
      </div>

      <Suspense fallback={<ListSkeleton />}>
        <List params={params} />
      </Suspense>
    </div>
  );
}

async function List({ params }: { params: Record<string, string | string[] | undefined> }) {
  return withDbFallback("advisory list", getVulnerabilityList, (rows) => {
    if (rows.length === 0) {
      return (
        <Panel title="Advisories">
          <EmptyState title="No advisories reach any application">
            Every installed version is clear of published OSV advisories.
          </EmptyState>
        </Panel>
      );
    }

    const multiApp = rows.filter((row) => row.appsReached > 1).length;
    const direct = rows.filter((row) => row.minDepth === 1).length;

    // When nothing spans two applications, say so rather than leaving a headline
    // that implies overlap the data does not contain. It is a real property of the
    // portfolio: the vulnerable versions are pinned old releases specific to one
    // application, while the widely-shared packages are all current.
    const description =
      multiApp > 0
        ? `${rows.length} reaching production trees. ${multiApp} touch more than one application; ${direct} sit in a dependency somebody declared directly.`
        : `${rows.length} reaching production trees, ${direct} of them in a dependency somebody declared directly. None spans two applications: the vulnerable versions here are pinned old releases specific to one app, while the packages several apps share are all current.`;

    const severity = typeof params.severity === "string" ? params.severity : undefined;
    const filtered = severity ? rows.filter((row) => row.severity === severity) : rows;
    const page = paginate(filtered, params.page as string | undefined, PAGE_SIZE.advisories);

    const options = [
      { label: "all", count: rows.length },
      ...SEVERITY_ORDER.map((level) => ({
        value: level,
        label: level.toLowerCase(),
        count: rows.filter((row) => row.severity === level).length,
      })).filter((option) => option.count > 0),
    ];

    return (
      <Panel
        title="Advisories"
        description={description}
        action={
          <FilterChips
            basePath="/vulnerabilities"
            param="severity"
            options={options}
            current={severity}
            searchParams={params}
            label="severity"
          />
        }
      >
        {page.items.length === 0 ? (
          <EmptyState title={`No ${severity?.toLowerCase()} advisories`}>
            Nothing at this severity reaches a production tree. Clear the filter to see the rest.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {page.items.map((row) => (
              <Row key={row.osvId} row={row} />
            ))}
          </ul>
        )}
        <Pagination
          page={page}
          basePath="/vulnerabilities"
          searchParams={params}
          label="advisories"
        />
      </Panel>
    );
  });
}

function Row({ row }: { row: VulnerabilityListRow }) {
  return (
    <li>
      <Link
        href={`/vulnerabilities/${encodeURIComponent(row.osvId)}`}
        className="group block px-5 py-3.5 transition-colors hover:bg-bg-subtle"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={row.severity} />
              <span className="font-mono text-xs font-medium group-hover:text-accent">
                {row.osvId}
              </span>
              {row.aliases
                .filter((alias) => alias.startsWith("CVE-"))
                .slice(0, 1)
                .map((alias) => (
                  <span key={alias} className="font-mono text-xs text-ink-faint">
                    {alias}
                  </span>
                ))}
            </div>
            <p className="mt-1 text-sm text-ink-muted">{row.summary}</p>
          </div>

          <div className="flex shrink-0 items-center gap-5 text-right">
            <div>
              <div className="tnum text-base font-semibold leading-none">{row.appsReached}</div>
              <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-faint">
                {row.appsReached === 1 ? "app" : "apps"}
              </div>
            </div>
            <div>
              <div className="tnum text-base font-semibold leading-none">{row.affectedVersions}</div>
              <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-faint">
                versions
              </div>
            </div>
            <div className="w-20">
              <div className="text-xs text-ink-muted">
                {row.minDepth === 1 ? "declared" : `${row.minDepth} hops`}
              </div>
              <div className="mt-1 text-[11px] text-ink-faint">
                {row.minDepth === 1 ? "directly" : "at closest"}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {row.appSlugs.map((slug) => (
            <span
              key={slug}
              className="rounded border border-line bg-bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-ink-faint"
            >
              {slug}
            </span>
          ))}
        </div>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <Panel title="Advisories" description="Walking every tree in reverse…">
      <ul className="divide-y divide-line">
        {Array.from({ length: 8 }, (_, index) => (
          <li key={index} className="px-5 py-3.5">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="mt-2 h-4 w-full max-w-xl" />
            <Skeleton className="mt-2 h-4 w-40" />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
