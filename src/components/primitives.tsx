import type { ReactNode } from "react";
import { SEVERITY_ORDER, type Severity } from "@/lib/model";

/** Severity is the only place saturated colour is used, so it always means risk. */
const SEVERITY_STYLE: Record<Severity, string> = {
  CRITICAL: "bg-critical-soft text-critical border-critical/25",
  HIGH: "bg-high-soft text-high border-high/25",
  MODERATE: "bg-moderate-soft text-moderate border-moderate/25",
  LOW: "bg-low-soft text-low border-low/25",
  UNKNOWN: "bg-bg-subtle text-ink-muted border-line",
};

export function SeverityBadge({
  severity,
  count,
}: {
  severity: Severity;
  count?: number;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[severity]}`}
    >
      {severity.toLowerCase()}
      {count !== undefined && <span className="tnum tabular-nums opacity-70">{count}</span>}
    </span>
  );
}

export function CleanBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-clean/25 bg-clean-soft px-2 py-0.5 text-xs font-medium text-clean">
      {children}
    </span>
  );
}

/** A severity histogram as a single proportional bar. */
export function SeverityBar({ counts }: { counts: Record<Severity, number> }) {
  const entries = (Object.entries(counts) as Array<[Severity, number]>)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b]);

  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return null;

  const fill: Record<Severity, string> = {
    CRITICAL: "bg-critical",
    HIGH: "bg-high",
    MODERATE: "bg-moderate",
    LOW: "bg-low",
    UNKNOWN: "bg-line-strong",
  };

  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle"
      role="img"
      aria-label={entries.map(([s, c]) => `${c} ${s.toLowerCase()}`).join(", ")}
    >
      {entries.map(([severity, count]) => (
        <div
          key={severity}
          className={fill[severity]}
          style={{ width: `${(count / total) * 100}%` }}
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
      <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
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

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{children}</p>}
    </div>
  );
}

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
