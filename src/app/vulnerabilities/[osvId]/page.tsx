import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getExposedApps, getVulnerability, type ExposedApp } from "@/lib/queries/vulnerabilities";
import { DbError } from "@/lib/db";
import { withDbFallback } from "@/components/db-error";
import { ChainLegend, DependencyChain } from "@/components/dependency-chain";
import { EmptyState, Panel, SeverityBadge, Skeleton, StatTile } from "@/components/primitives";

export const revalidate = 60;

/**
 * One advisory, and the reverse blast radius: who is exposed and by what path.
 *
 * The same edges as the application page, walked the other way. Nothing was added
 * to the model to make this direction possible, which is the point — in a
 * relational schema "which apps does this CVE reach" and "which CVEs reach this
 * app" are two different recursive queries.
 */
export default async function VulnerabilityPage({
  params,
}: PageProps<"/vulnerabilities/[osvId]">) {
  const { osvId } = await params;
  const decoded = decodeURIComponent(osvId);

  let advisory;
  try {
    advisory = await getVulnerability(decoded);
  } catch (error) {
    if (error instanceof DbError) {
      return withDbFallback("advisory", async () => null, () => null);
    }
    throw error;
  }

  if (!advisory) notFound();

  return (
    <div className="space-y-8">
      <div>
        <Link href="/vulnerabilities" className="text-xs text-ink-muted hover:text-ink">
          ← All advisories
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <SeverityBadge severity={advisory.severity} />
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{advisory.osvId}</h1>
        </div>
        <p className="mt-2 max-w-3xl text-base">{advisory.summary}</p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-faint">
          {advisory.publishedAt && (
            <span>published {advisory.publishedAt.slice(0, 10)}</span>
          )}
          {advisory.aliases.length > 0 && (
            <span className="font-mono">also known as {advisory.aliases.join(", ")}</span>
          )}
          {advisory.referenceUrl && (
            <a
              href={advisory.referenceUrl}
              className="text-ink-muted underline decoration-line underline-offset-2 hover:text-ink"
            >
              full advisory ↗
            </a>
          )}
        </div>

        {advisory.cvssVector && (
          <p className="mt-2 font-mono text-xs text-ink-faint">{advisory.cvssVector}</p>
        )}
      </div>

      {advisory.details && (
        <div className="rounded-xl border border-line bg-panel px-5 py-4">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
            {advisory.details}
          </p>
        </div>
      )}

      <Suspense fallback={<ExposureSkeleton />}>
        <Exposure osvId={decoded} />
      </Suspense>
    </div>
  );
}

async function Exposure({ osvId }: { osvId: string }) {
  return withDbFallback(
    "exposed applications",
    () => getExposedApps(osvId),
    (rows) => {
      if (rows.length === 0) {
        return (
          <Panel title="Who is exposed">
            <EmptyState title="No application reaches an affected version">
              This advisory is in the graph because it matched a version somewhere, but no
              application&apos;s production tree currently installs one.
            </EmptyState>
          </Panel>
        );
      }

      const declared = rows.filter((row) => row.depth === 1).length;
      const fixes = [...new Set(rows.map((row) => row.fixedIn).filter(Boolean))] as string[];

      return (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Applications" value={rows.length} hint="production trees" />
            <StatTile
              label="Declared directly"
              value={declared}
              hint={declared === rows.length ? "all of them" : `${rows.length - declared} inherited`}
            />
            <StatTile
              label="Closest"
              value={Math.min(...rows.map((row) => row.depth))}
              hint="hops from an app"
            />
            <StatTile
              label="Fixed in"
              value={fixes.length ? fixes.join(", ") : "—"}
              hint={fixes.length ? "upgrade target" : "no fix published"}
            />
          </div>

          <Panel
            title="Who is exposed"
            description="Each row is the shortest path from a declared dependency to the affected version."
            action={<ChainLegend />}
          >
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <ExposedRow key={`${row.slug}-${row.affectedVersionId}`} row={row} />
              ))}
            </ul>
          </Panel>
        </div>
      );
    },
  );
}

function ExposedRow({ row }: { row: ExposedApp }) {
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div>
          <Link
            href={`/apps/${row.slug}`}
            className="font-mono text-sm font-medium hover:text-accent"
          >
            {row.name}
          </Link>
          <span className="ml-2 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-faint">
            {row.kind}
          </span>
          <p className="mt-1 text-xs text-ink-muted">
            {row.depth === 1
              ? "Declared directly — upgrade it in place."
              : `Inherited ${row.depth} hops down. Bump ${row.entryPoint.split("@").slice(0, -1).join("@")} to clear it.`}
          </p>
        </div>
        <div className="shrink-0 text-right text-xs">
          <div className="font-mono text-ink-muted">{row.affectedVersionId}</div>
          <div className="mt-0.5 font-mono text-ink-faint">
            {row.fixedIn ? `fixed in ${row.fixedIn}` : "no fix published"}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <DependencyChain chain={row.chain} appName={row.name} />
      </div>
    </li>
  );
}

function ExposureSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-lg border border-line bg-panel px-4 py-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-7 w-12" />
          </div>
        ))}
      </div>
      <Panel title="Who is exposed" description="Walking every tree in reverse…">
        <ul className="divide-y divide-line">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="px-5 py-4">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-3 h-7 w-72" />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
