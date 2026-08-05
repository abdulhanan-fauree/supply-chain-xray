import Link from "next/link";
import { Suspense } from "react";

import { getPackageNames, getPackagePath } from "@/lib/queries/packages";
import { MAX_TRAVERSAL_DEPTH } from "@/lib/config";
import { withDbFallback } from "@/components/db-error";
import { DependencyChain } from "@/components/dependency-chain";
import { EmptyState, Panel, PanelSkeleton } from "@/components/primitives";

// Next.js requires route segment config to be a statically analysable literal, so
// this cannot be imported from lib/config. Keep the value in step with the note
// on caching there.
export const revalidate = 60;

/**
 * Six degrees of separation between two packages.
 *
 * The clearest single demonstration of what a graph buys: one line of Cypher
 * finds the shortest connection between two arbitrary packages, and the answer is
 * a path rather than a set of rows to stitch back together.
 *
 * The form submits by GET, so a result is a shareable URL and the whole page
 * works without JavaScript. Package names come from the graph and populate a
 * datalist, which gives native autocomplete over a thousand packages with no
 * client bundle at all.
 */

const EXAMPLES = [
  { from: "express", to: "ms", note: "two hops, through debug" },
  { from: "next", to: "picocolors", note: "deep inside the build chain" },
  { from: "handlebars", to: "minimist", note: "the prototype-pollution path" },
  { from: "react-native", to: "debug", note: "across a large tree" },
];

export default async function ExplorePage({ searchParams }: PageProps<"/explore">) {
  const params = await searchParams;
  const from = typeof params.from === "string" ? params.from.trim() : "";
  const to = typeof params.to === "string" ? params.to.trim() : "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Explore connections</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
          How is one package connected to another? This is a single{" "}
          <code className="font-mono text-xs">shortestPath</code> over the dependency graph, bounded
          at {MAX_TRAVERSAL_DEPTH} hops. The relational equivalent is an unbounded self-join whose
          result has to be reassembled into an ordered chain by the application.
        </p>
      </div>

      <Suspense fallback={<PanelSkeleton title="Find a path" rows={3} />}>
        <Form from={from} to={to} />
      </Suspense>

      {from && to ? (
        <Suspense key={`${from}|${to}`} fallback={<PanelSkeleton title="Shortest path" rows={2} />}>
          <Result from={from} to={to} />
        </Suspense>
      ) : (
        <Panel title="Shortest path">
          <EmptyState title="Pick two packages">
            Choose a starting and ending package above, or try one of the suggested pairs.
          </EmptyState>
        </Panel>
      )}
    </div>
  );
}

/**
 * The datalist is server-rendered from the graph, so autocomplete covers every
 * installed package without shipping a search index or a client component.
 */
async function Form({ from, to }: { from: string; to: string }) {
  return withDbFallback(
    "package list",
    getPackageNames,
    (names) => (
      <Panel
        title="Find a path"
        description={`Autocomplete covers all ${names.length} installed packages.`}
      >
        <form method="get" className="space-y-4 px-5 py-4">
          <datalist id="package-names">
            {names.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-end">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-faint">
                From
              </span>
              <input
                name="from"
                defaultValue={from}
                list="package-names"
                placeholder="express"
                autoComplete="off"
                spellCheck={false}
                className="field font-mono"
              />
            </label>

            <span
              aria-hidden="true"
              className="hidden pb-2.5 text-center text-ink-faint sm:block"
            >
              →
            </span>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-faint">
                To
              </span>
              <input
                name="to"
                defaultValue={to}
                list="package-names"
                placeholder="ms"
                autoComplete="off"
                spellCheck={false}
                className="field font-mono"
              />
            </label>

            <button
              type="submit"
              className="rounded-lg border border-accent/30 bg-accent-soft px-4 py-2 text-sm font-medium text-accent transition-colors hover:border-accent/50"
            >
              Find path
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
            <span className="text-ink-faint">Try:</span>
            {EXAMPLES.map((example) => (
              <Link
                key={`${example.from}-${example.to}`}
                href={`/explore?from=${encodeURIComponent(example.from)}&to=${encodeURIComponent(example.to)}`}
                title={example.note}
                className="rounded-md border border-line bg-bg-subtle px-2 py-1 font-mono text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
              >
                {example.from} → {example.to}
              </Link>
            ))}
          </div>
        </form>
      </Panel>
    ),
  );
}

async function Result({ from, to }: { from: string; to: string }) {
  return withDbFallback(
    "shortest path",
    () => getPackagePath(from, to),
    (result) => {
      if (!result) {
        return (
          <Panel title="Shortest path">
            <EmptyState title="No path within 8 hops">
              Nothing installed connects{" "}
              <span className="font-mono text-xs">{from}</span> to{" "}
              <span className="font-mono text-xs">{to}</span> in this direction. Dependency edges are
              directed, so try swapping them — and check both names are spelled as the registry has
              them.
            </EmptyState>
          </Panel>
        );
      }

      return (
        <Panel
          title="Shortest path"
          description={`${result.hops} ${result.hops === 1 ? "hop" : "hops"} from ${from} to ${to}, across ${result.chain.length} packages.`}
        >
          <div className="space-y-4 px-5 py-5">
            <DependencyChain chain={result.chain} />

            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
              <span>
                Reading it: each arrow is one{" "}
                <span className="font-mono">DEPENDS_ON</span> edge in the direction of the
                dependency.
              </span>
              <Link
                href={`/explore?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`}
                className="rounded-md border border-line px-2 py-1 transition-colors hover:border-line-strong hover:text-ink"
              >
                Reverse the direction
              </Link>
            </div>
          </div>
        </Panel>
      );
    },
  );
}
