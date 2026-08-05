import type { ReactNode } from "react";

import type { Severity } from "@/lib/model";
import {
  presentSeverities,
  totalSeverities,
  SEVERITY_ORDER,
  type SeverityCounts,
} from "@/lib/severity";

/**
 * Shared display primitives.
 *
 * Severity is the only place saturated colour appears, so colour always means
 * risk. Everything else uses one neutral ramp, which is what lets a CRITICAL
 * badge read instantly rather than competing with decoration.
 */

const SEVERITY_STYLE: Record<Severity, string> = {
  CRITICAL: "bg-critical-soft text-critical border-critical/25",
  HIGH: "bg-high-soft text-high border-high/25",
  MODERATE: "bg-moderate-soft text-moderate border-moderate/25",
  LOW: "bg-low-soft text-low border-low/25",
  UNKNOWN: "bg-bg-subtle text-ink-muted border-line",
};

const SEVERITY_FILL: Record<Severity, string> = {
  CRITICAL: "bg-critical",
  HIGH: "bg-high",
  MODERATE: "bg-moderate",
  LOW: "bg-low",
  UNKNOWN: "bg-line-strong",
};

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[severity]}`}
    >
      {severity.toLowerCase()}
      {count !== undefined && <span className="tnum opacity-70">{count}</span>}
    </span>
  );
}

/** Every level present in a histogram, most severe first. */
export function SeverityBadges({ counts }: { counts: SeverityCounts }) {
  const present = presentSeverities(counts);
  if (present.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {present.map((severity) => (
        <SeverityBadge key={severity} severity={severity} count={counts[severity]} />
      ))}
    </div>
  );
}

export function CleanBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-clean/25 bg-clean-soft px-2 py-0.5 text-xs font-medium text-clean">
      {children}
    </span>
  );
}

/** A severity histogram as one proportional bar. */
export function SeverityBar({ counts }: { counts: SeverityCounts }) {
  const total = totalSeverities(counts);
  if (total === 0) return null;

  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle"
      role="img"
      aria-label={SEVERITY_ORDER.filter((severity) => counts[severity] > 0)
        .map((severity) => `${counts[severity]} ${severity.toLowerCase()}`)
        .join(", ")}
    >
      {SEVERITY_ORDER.filter((severity) => counts[severity] > 0).map((severity) => (
        <div
          key={severity}
          className={SEVERITY_FILL[severity]}
          style={{ width: `${(counts[severity] / total) * 100}%` }}
        />
      ))}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="tnum mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}

export function Panel({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} aria-hidden="true" />;
}

/** A titled panel of skeleton rows, for Suspense fallbacks. */
export function PanelSkeleton({
  title,
  description = "Loading…",
  rows,
}: {
  title: string;
  description?: string;
  rows: number;
}) {
  return (
    <Panel title={title} description={description}>
      <div className="space-y-3 px-5 py-4">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-5 w-full" />
        ))}
      </div>
    </Panel>
  );
}

export function StatTilesSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-lg border border-line bg-panel px-4 py-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-7 w-12" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{children}</p>}
    </div>
  );
}

/** A positive empty state: nothing to report, said deliberately. */
export function CleanState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-12 text-center">
      <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-clean-soft text-clean">
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="size-5"
          aria-hidden="true"
        >
          <path d="M6 10.5l2.6 2.5L14 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{children}</p>}
    </div>
  );
}

/** Compact counts: 1234 becomes 1.2k, 1234567 becomes 1.2M. */
export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
