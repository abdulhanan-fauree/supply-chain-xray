import Link from "next/link";
import type { Severity } from "@/lib/model";

/**
 * A dependency path, drawn as a readable chain.
 *
 * This is the component the whole application is built around. A force-directed
 * graph of 1,200 nodes looks impressive and answers nothing; the question people
 * actually have is "how did this get into my app", and the answer is a sequence
 * of four or five package names. So the sequence is what gets drawn, at a size
 * you can read, with the two ends labelled: the head is the dependency you
 * declared and can change, the tail is the version carrying the advisory.
 *
 * Everything in between is the part nobody chose.
 */

const TAIL_TONE: Record<Severity, string> = {
  CRITICAL: "border-critical/40 bg-critical-soft text-critical",
  HIGH: "border-high/40 bg-high-soft text-high",
  MODERATE: "border-moderate/40 bg-moderate-soft text-moderate",
  LOW: "border-low/40 bg-low-soft text-low",
  UNKNOWN: "border-line-strong bg-bg-subtle text-ink-muted",
};

function splitVersionId(versionId: string): { name: string; version: string } {
  // Scoped packages contain an @ of their own, so split on the last one.
  const at = versionId.lastIndexOf("@");
  if (at <= 0) return { name: versionId, version: "" };
  return { name: versionId.slice(0, at), version: versionId.slice(at + 1) };
}

export function DependencyChain({
  chain,
  severity,
  appName,
}: {
  chain: string[];
  /** Colours the final link. Omit for a neutral chain. */
  severity?: Severity;
  /** Rendered as the origin link, so the path starts where the reader does. */
  appName?: string;
}) {
  const tailTone = severity ? TAIL_TONE[severity] : "border-line-strong bg-bg-subtle text-ink";

  return (
    // Scrolls inside itself rather than pushing the page sideways.
    <div className="-mx-1 overflow-x-auto px-1 py-0.5">
      <ol className="flex items-center gap-1.5 whitespace-nowrap">
        {appName && (
          <>
            <li className="rounded-md border border-accent/30 bg-accent-soft px-2 py-1 font-mono text-xs font-medium text-accent">
              {appName}
            </li>
            <Arrow />
          </>
        )}

        {chain.map((versionId, index) => {
          const { name, version } = splitVersionId(versionId);
          const isFirst = index === 0;
          const isLast = index === chain.length - 1;

          return (
            <li key={`${versionId}-${index}`} className="flex items-center gap-1.5">
              <Link
                href={`/packages/${encodeURIComponent(name)}`}
                className={`group/link rounded-md border px-2 py-1 font-mono text-xs transition-colors ${
                  isLast
                    ? `font-medium ${tailTone}`
                    : isFirst
                      ? "border-line-strong bg-panel text-ink hover:border-accent/40"
                      : "border-line bg-bg-subtle text-ink-muted hover:text-ink"
                }`}
                title={isFirst ? "You declared this dependency" : undefined}
              >
                {name}
                {version && (
                  <span className={isLast ? "opacity-80" : "text-ink-faint"}>@{version}</span>
                )}
              </Link>
              {!isLast && <Arrow />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Arrow() {
  return (
    <span aria-hidden="true" className="shrink-0 text-ink-faint">
      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 8h9M9 5l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** Legend explaining what the two ends of a chain mean. Shown once per page. */
export function ChainLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-faint">
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm border border-line-strong bg-panel" />
        you declared this
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm border border-line bg-bg-subtle" />
        pulled in transitively
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm border border-high/40 bg-high-soft" />
        carries the advisory
      </span>
    </div>
  );
}
