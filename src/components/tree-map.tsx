import Link from "next/link";

import type { TreeNode } from "@/lib/queries/app-detail";
import type { Severity } from "@/lib/model";
import { compareSeverity } from "@/lib/severity";

/**
 * The whole install tree as one scannable grid: a row per depth level, a cell per
 * installed version, coloured only when something is wrong.
 *
 * This is the counterpart to the dependency chain rather than a replacement. A
 * chain answers "how did this one thing get here"; the grid answers "how big is
 * this and where does the risk sit". Neither is a force-directed graph, because a
 * hairball of four hundred nodes conveys size and nothing else.
 *
 * Two properties make it worth the space. Scale is literal — 428 cells look like
 * 428 things, where "428" reads as an abstraction. And clustering is visible: the
 * vulnerable cells in a neglected tree sit at depth 1 and 2, while a modern tree's
 * few findings sit further down, which is a different problem with a different fix.
 *
 * Rendered server-side as plain elements, so there is no client bundle and every
 * cell is a real link.
 */

const CELL: Record<Severity, string> = {
  CRITICAL: "bg-critical border-critical",
  HIGH: "bg-high border-high",
  MODERATE: "bg-moderate border-moderate",
  LOW: "bg-low border-low",
  UNKNOWN: "bg-line-strong border-line-strong",
};

const CLEAN_CELL = "bg-bg-subtle border-line hover:border-line-strong";

export function TreeMap({ nodes }: { nodes: TreeNode[] }) {
  if (nodes.length === 0) return null;

  const byDepth = new Map<number, TreeNode[]>();
  for (const node of nodes) {
    const bucket = byDepth.get(node.depth);
    if (bucket) bucket.push(node);
    else byDepth.set(node.depth, [node]);
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const vulnerable = nodes.filter((node) => node.severity !== null);

  return (
    <div className="space-y-4 px-5 py-4">
      {depths.map((depth) => {
        const level = byDepth.get(depth)!;
        // Vulnerable cells lead each row, so they are findable without hunting.
        const ordered = [...level].sort((a, b) => {
          if (a.severity && b.severity) return compareSeverity(a.severity, b.severity);
          if (a.severity) return -1;
          if (b.severity) return 1;
          return a.packageName.localeCompare(b.packageName);
        });
        const flagged = level.filter((node) => node.severity !== null).length;

        return (
          <div key={depth} className="flex items-start gap-3">
            <div className="w-20 shrink-0 pt-0.5">
              <div className="text-xs font-medium">
                {depth === 1 ? "direct" : `level ${depth}`}
              </div>
              <div className="tnum text-[11px] text-ink-faint">
                {level.length}
                {flagged > 0 && <span className="ml-1 text-high">{flagged} at risk</span>}
              </div>
            </div>

            <div className="flex flex-wrap gap-[3px] pt-1">
              {ordered.map((node) => (
                <Link
                  key={node.versionId}
                  href={`/packages/${encodeURIComponent(node.packageName)}`}
                  title={`${node.versionId}${
                    node.severity ? ` — ${node.severity.toLowerCase()} advisory` : ""
                  } (${depth === 1 ? "declared directly" : `${depth} hops down`})`}
                  aria-label={`${node.versionId}${node.severity ? `, ${node.severity.toLowerCase()} advisory` : ""}`}
                  className={`size-[11px] rounded-[2px] border transition-transform hover:scale-150 ${
                    node.severity ? CELL[node.severity] : CLEAN_CELL
                  }`}
                />
              ))}
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs text-ink-faint">
        <span className="flex items-center gap-1.5">
          <span className="size-[11px] rounded-[2px] border border-line bg-bg-subtle" />
          no known advisory
        </span>
        {(["CRITICAL", "HIGH", "MODERATE", "LOW"] as const)
          .filter((severity) => vulnerable.some((node) => node.severity === severity))
          .map((severity) => (
            <span key={severity} className="flex items-center gap-1.5">
              <span className={`size-[11px] rounded-[2px] border ${CELL[severity]}`} />
              {severity.toLowerCase()}
            </span>
          ))}
        <span className="ml-auto">
          {nodes.length} installed versions · {vulnerable.length} carrying advisories
        </span>
      </div>
    </div>
  );
}
