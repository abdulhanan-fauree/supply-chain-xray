import Link from "next/link";
import { Suspense } from "react";

import {
  getDependents,
  getPackage,
  getPackageVersions,
  type Dependent,
  type InstalledVersion,
} from "@/lib/queries/packages";
import { PAGE_SIZE } from "@/lib/config";
import { loadOrNotFound, withDbFallback } from "@/components/db-error";
import {
  EmptyState,
  Panel,
  PanelSkeleton,
  SeverityBadge,
  StatTile,
  formatCount,
} from "@/components/primitives";
import { Pagination, paginate } from "@/components/pagination";

// Next.js requires route segment config to be a statically analysable literal, so
// this cannot be imported from lib/config. Keep the value in step with the note
// on caching there.
export const revalidate = 60;

/**
 * One package: its installed versions, who can publish it, and what pulls it in.
 *
 * The dependents panel is a single walk against the edge direction. A relational
 * schema needs a second index to answer that as cheaply as the forward question;
 * the graph uses the same relationships either way.
 */

export default async function PackagePage({
  params,
  searchParams,
}: PageProps<"/packages/[name]">) {
  const { name } = await params;
  const query = await searchParams;
  const decoded = decodeURIComponent(name);

  const loaded = await loadOrNotFound("package", () => getPackage(decoded));
  if ("errorState" in loaded) return loaded.errorState;
  const pkg = loaded.data;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/packages" className="text-xs text-ink-muted hover:text-ink">
          ← Shared choke points
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{pkg.name}</h1>
          {pkg.deprecated && (
            <span className="rounded-full border border-high/25 bg-high-soft px-2 py-0.5 text-xs font-medium text-high">
              deprecated
            </span>
          )}
        </div>
        {pkg.description && <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">{pkg.description}</p>}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <a
            href={`https://www.npmjs.com/package/${pkg.name}`}
            className="text-ink-muted underline decoration-line underline-offset-2 hover:text-ink"
          >
            npm ↗
          </a>
          {pkg.repoUrl && (
            <a
              href={pkg.repoUrl}
              className="text-ink-muted underline decoration-line underline-offset-2 hover:text-ink"
            >
              source ↗
            </a>
          )}
          {pkg.homepage && pkg.homepage !== pkg.repoUrl && (
            <a
              href={pkg.homepage}
              className="text-ink-muted underline decoration-line underline-offset-2 hover:text-ink"
            >
              homepage ↗
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Latest" value={pkg.latestVersion ?? "—"} />
        <StatTile
          label="Weekly downloads"
          value={pkg.weeklyDownloads === null ? "—" : formatCount(pkg.weeklyDownloads)}
        />
        <StatTile
          label="Can publish"
          value={pkg.maintainers.length}
          hint={pkg.maintainers.length === 1 ? "a single account" : "npm accounts"}
        />
        <StatTile label="Name" value={<span className="font-mono text-base">{pkg.name}</span>} />
      </div>

      {pkg.maintainers.length > 0 && (
        <Panel
          title="Publish rights"
          description={
            pkg.maintainers.length === 1
              ? "One account can publish a new version of this package. Anything installing it inherits that trust."
              : `${pkg.maintainers.length} accounts can publish a new version of this package.`
          }
        >
          <div className="flex flex-wrap gap-1.5 px-5 py-4">
            {pkg.maintainers.map((npmUser) => (
              <span
                key={npmUser}
                className="rounded-md border border-line bg-bg-subtle px-2 py-1 font-mono text-xs text-ink-muted"
              >
                {npmUser}
              </span>
            ))}
          </div>
        </Panel>
      )}

      <Suspense fallback={<PanelSkeleton title="Installed versions" rows={4} />}>
        <Versions name={decoded} />
      </Suspense>

      <Suspense fallback={<PanelSkeleton title="What pulls this in" rows={6} />}>
        <Dependents name={decoded} query={query} />
      </Suspense>
    </div>
  );
}

async function Versions({ name }: { name: string }) {
  return withDbFallback(
    "installed versions",
    () => getPackageVersions(name),
    (versions) => (
      <Panel
        title="Installed versions"
        description="Only versions some application actually resolves to — this is an install tree, not the full registry history."
      >
        {versions.length === 0 ? (
          <EmptyState title="No versions of this package are installed" />
        ) : (
          <ul className="divide-y divide-line">
            {versions.map((version) => (
              <VersionRow key={version.versionId} version={version} />
            ))}
          </ul>
        )}
      </Panel>
    ),
  );
}

function VersionRow({ version }: { version: InstalledVersion }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{version.version}</span>
          {version.isLatest && (
            <span className="rounded-full border border-clean/25 bg-clean-soft px-2 py-0.5 text-[11px] font-medium text-clean">
              latest
            </span>
          )}
          {!version.isLatest && version.releasesBehind !== null && version.releasesBehind > 0 && (
            <span className="text-xs text-ink-faint">
              {version.releasesBehind} releases behind
            </span>
          )}
          {version.deprecated && (
            <span className="rounded-full border border-high/25 bg-high-soft px-2 py-0.5 text-[11px] text-high">
              deprecated
            </span>
          )}
          {version.worstSeverity && (
            <SeverityBadge severity={version.worstSeverity} count={version.advisories} />
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-faint">
          {version.spdxId && <span className="font-mono">{version.spdxId}</span>}
          {version.licenseCategory && version.licenseCategory !== "permissive" && (
            <span className="text-moderate">{version.licenseCategory.replace("-", " ")}</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {version.apps.length === 0 ? (
          <span className="text-xs text-ink-faint">not in any production tree</span>
        ) : (
          version.apps
            .sort((a, b) => a.depth - b.depth || a.slug.localeCompare(b.slug))
            .map((app) => (
              <Link
                key={app.slug}
                href={`/apps/${app.slug}`}
                className="rounded border border-line bg-bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-ink-muted hover:text-ink"
                title={`${app.depth === 1 ? "declared directly" : `${app.depth} hops down`}`}
              >
                {app.slug}
                <span className="ml-1 text-ink-faint">L{app.depth}</span>
              </Link>
            ))
        )}
      </div>
    </li>
  );
}

async function Dependents({
  name,
  query,
}: {
  name: string;
  query: Record<string, string | string[] | undefined>;
}) {
  return withDbFallback(
    "dependents",
    () => getDependents(name),
    (dependents) => {
      const page = paginate(dependents, query.page as string | undefined, PAGE_SIZE.dependents);
      return (
      <Panel
        title="What pulls this in"
        description={
          dependents.length === 0
            ? "Nothing in the graph depends on this — it is declared directly by an application."
            : `${dependents.length} installed ${dependents.length === 1 ? "version depends" : "versions depend"} on this package.`
        }
      >
        {dependents.length === 0 ? (
          <EmptyState title="No transitive dependents">
            Every application that installs this package declared it in its own manifest.
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {page.items.map((dependent) => (
                <DependentRow
                  key={`${dependent.versionId}-${dependent.resolvesTo}`}
                  dependent={dependent}
                />
              ))}
            </ul>
            <Pagination
              page={page}
              basePath={`/packages/${encodeURIComponent(name)}`}
              searchParams={query}
              label="dependents"
            />
          </>
        )}
      </Panel>
      );
    },
  );
}

function DependentRow({ dependent }: { dependent: Dependent }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2.5">
      <Link
        href={`/packages/${encodeURIComponent(dependent.packageName)}`}
        className="font-mono text-sm hover:text-accent"
      >
        {dependent.versionId}
      </Link>
      <div className="flex items-center gap-3 font-mono text-xs text-ink-faint">
        <span>
          wants <span className="text-ink-muted">{dependent.range}</span>
        </span>
        <span>→ {dependent.resolvesTo}</span>
        {dependent.optional && <span className="not-italic text-ink-faint">optional</span>}
      </div>
    </li>
  );
}

