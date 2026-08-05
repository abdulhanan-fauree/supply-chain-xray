import { PORTFOLIO_CYPHER } from "@/lib/queries/portfolio";
import { APP_DETAIL_CYPHER } from "@/lib/queries/app-detail";
import { VULNERABILITY_CYPHER } from "@/lib/queries/vulnerabilities";
import { PACKAGE_CYPHER } from "@/lib/queries/packages";
import { MAINTAINER_CYPHER } from "@/lib/queries/maintainers";

/**
 * Every query the application runs, with its reasoning.
 *
 * The Cypher is imported from the query modules rather than transcribed, so this
 * page cannot drift out of date — if a query changes, what is documented here
 * changes with it. That mattered enough to export the constants for.
 *
 * No database access, so this page is fully static.
 */

export const metadata = {
  title: "Queries · Supply Chain X-Ray",
  description: "Every Cypher query this application runs, and why it is shaped the way it is.",
};

type Entry = {
  title: string;
  question: string;
  cypher: string;
  why: string;
  relational: string;
  cost?: string;
};

const ENTRIES: Entry[] = [
  {
    title: "Portfolio overview",
    question: "For each application: how big is its install tree, how deep, and how much of it is vulnerable?",
    cypher: PORTFOLIO_CYPHER.PORTFOLIO,
    why: "Three aggregates over one app in a single statement, each a different question about the same reachability set. The severity histogram collects [osvId, severity] pairs rather than bare severities, because collecting severities alone counts one advisory once per version it touches — a single CVE in a widely-shared package would dominate the chart.",
    relational: "Three correlated subqueries over a recursive CTE, repeated per column, plus a GROUP BY that cannot distinguish an advisory from an advisory-version pair without a second join.",
    cost: "≈250ms for all six applications",
  },
  {
    title: "Longest dependency chain",
    question: "What is the longest single chain of packages in an application's tree?",
    cypher: PORTFOLIO_CYPHER.LONGEST_CHAIN,
    why: "A genuine unbounded walk, and deliberately a different number from nesting depth: orders-api nests 5 levels deep but contains a 9-package chain, because the longest route to a node is not the shortest one. Both are shown, each labelled for what it is.",
    relational: "A recursive CTE that must enumerate paths rather than nodes, then take a maximum over path length — the case where recursive SQL is at its least readable.",
    cost: "≈520ms",
  },
  {
    title: "Blast radius — the paths",
    question: "For every vulnerable version in an application's tree, what is the shortest chain from a dependency it declared?",
    cypher: APP_DETAIL_CYPHER.VULNERABLE_PATHS,
    why: "The central query. It returns a path — an ordered list of packages — which is the answer to \"how did this get here\". The outer match narrows to vulnerable versions over the materialised closure before any path finding begins; unscoped, a path search per (root, dependency) pair exceeds the query timeout on the free instance.",
    relational: "A recursive CTE to find reachable versions, a second to reconstruct each chain, and then reassembly in application code because a SQL result set has no path type.",
    cost: "≈1.3s for the largest tree, at 207 dependencies",
  },
  {
    title: "Blast radius — the advisories",
    question: "Which advisories affect which versions in this tree?",
    cypher: APP_DETAIL_CYPHER.VULNERABLE_VERSIONS,
    why: "Deliberately separate from the path query. Combined, it runs a path search per advisory, and advisories outnumber affected versions several times over — so the same path is found repeatedly. Split, each path is found once and joined in application code; the two queries run concurrently, so the page waits for the slower rather than the sum.",
    relational: "A straightforward join once the reachable set exists — the hard part is the recursive CTE that produces it.",
  },
  {
    title: "Reverse blast radius",
    question: "Given one advisory, which applications are exposed and by what path?",
    cypher: VULNERABILITY_CYPHER.EXPOSED_APPS,
    why: "The same edges as the blast radius, walked the other way. Nothing was added to the model to make this direction possible, which is the clearest single argument for the graph here.",
    relational: "A different recursive query with a different join order from the forward question, over the same data. Two queries to maintain where the graph has one pattern read in two directions.",
  },
  {
    title: "Trust concentration",
    question: "If one npm account were compromised today, how much of this software could that person publish to?",
    cypher: MAINTAINER_CYPHER.TRUST_CONCENTRATION,
    why: "A three-hop walk from a person, through the packages they can publish, to the versions installed, to the applications exposed — aggregated over the transitive set rather than direct dependencies. Maintainers come from each package's current metadata rather than the historical list on whichever old version is installed, because the question is who holds the keys now.",
    relational: "The reachability half is a recursive CTE; the grouping half joins against its result once per maintainer. For 558 accounts that is either a very large join or a loop.",
    cost: "≈1.6s, with the advisory aggregate split into its own concurrent query",
  },
  {
    title: "Bus factor of one",
    question: "Which installed packages have exactly one account able to publish them?",
    cypher: MAINTAINER_CYPHER.SOLE_MAINTAINERS,
    why: "Aggregate, then filter on the size of the aggregate — collect the maintainers per package and keep the ones of length 1. Restricted to packages some application actually installs, so it measures real exposure rather than registry trivia.",
    relational: "Expressible with GROUP BY … HAVING COUNT(*) = 1, but only after the recursive CTE that establishes which packages are installed at all.",
  },
  {
    title: "Shared choke points",
    question: "Which packages do several applications depend on without any of them having chosen it?",
    cypher: PACKAGE_CYPHER.CHOKE_POINTS,
    why: "Set intersection over several transitive closures at once. The rows that matter are those where the minimum depth is greater than one: nobody reviewed those, and nobody would notice them changing.",
    relational: "One recursive CTE per application, then a join across all of their results. This is the shape SQL handles worst.",
    cost: "≈1.1s",
  },
  {
    title: "What pulls this in",
    question: "Which installed versions depend on this package?",
    cypher: PACKAGE_CYPHER.DEPENDENTS,
    why: "A single reverse edge walk. Cheap here precisely because an edge has no preferred direction — the same relationships answer \"what does X depend on\" and \"what depends on X\".",
    relational: "Needs a second index on the dependency table to avoid a scan, and the index only helps one direction at a time.",
  },
  {
    title: "Six degrees of separation",
    question: "How is one package connected to another?",
    cypher: PACKAGE_CYPHER.PACKAGE_PATH,
    why: "The clearest demonstration of the difference: one line finds the shortest connection between two arbitrary packages, and the answer is a path. In this dataset express reaches ms in two hops, via debug@2.6.9.",
    relational: "An unbounded self-join with no natural termination, returning rows that must be stitched back into an ordered chain by the application.",
  },
  {
    title: "License obligations",
    question: "Which dependencies carry a licence that is not plainly permissive, and what pulled them in?",
    cypher: APP_DETAIL_CYPHER.LICENSE_OBLIGATIONS,
    why: "Filters on a licence category computed at load time from the SPDX expression, then finds the chain responsible. The categoriser has to decompose expressions rather than pattern-match them: \"(BSD-3-Clause OR GPL-2.0)\" is a choice, so the permissive reading is correct, while AND binds every operand at once.",
    relational: "A join to reach the licence, then a recursive CTE to explain each hit — and the explanation is again a path.",
  },
  {
    title: "Nesting depth histogram",
    question: "How much of an application's tree sits at each level of nesting?",
    cypher: APP_DETAIL_CYPHER.DEPTH_HISTOGRAM,
    why: "Single-hop, because depth is already an edge property. This is the query that justified materialising the closure: asked live it becomes one shortest-path search per (application, dependency) pair and exceeds the query timeout, while one breadth-first sweep per application in the loader is effectively free. The answers are identical — a BFS is the shortest-path algorithm, run once per source instead of once per pair.",
    relational: "A recursive CTE tracking minimum depth per node, with the usual difficulty that SQL's recursion has no natural notion of visiting a node once at its shortest distance.",
    cost: "≈650ms",
  },
];

export default function QueriesPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">The queries</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-ink-muted">
          Every Cypher query this application runs, why it is shaped the way it is, and what the
          relational equivalent would cost. The text below is imported from the query modules rather
          than copied, so it cannot drift out of date.
        </p>
        <p className="mt-3 max-w-3xl text-sm text-ink-muted">
          Every value reaches the database as a parameter — the <code className="font-mono text-xs">$slug</code>{" "}
          and <code className="font-mono text-xs">$name</code> placeholders below are sent separately
          from the query text by the driver. No Cypher in this codebase is assembled from data.
        </p>
      </div>

      <ol className="space-y-6">
        {ENTRIES.map((entry, index) => (
          <li key={entry.title} className="rounded-xl border border-line bg-panel">
            <div className="border-b border-line px-5 py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="tnum text-xs font-medium text-ink-faint">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h2 className="text-sm font-semibold tracking-tight">{entry.title}</h2>
                {entry.cost && (
                  <span className="rounded-full border border-line bg-bg-subtle px-2 py-0.5 text-[11px] text-ink-faint">
                    {entry.cost}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-sm text-ink-muted">{entry.question}</p>
            </div>

            <div className="overflow-x-auto border-b border-line bg-bg-subtle">
              <pre className="px-5 py-4 font-mono text-xs leading-relaxed text-ink">
                {entry.cypher.trim()}
              </pre>
            </div>

            <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                  Why it is shaped this way
                </h3>
                <p className="mt-1.5 text-sm text-ink-muted">{entry.why}</p>
              </div>
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                  Relationally
                </h3>
                <p className="mt-1.5 text-sm text-ink-muted">{entry.relational}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
