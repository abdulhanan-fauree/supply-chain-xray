import type { Severity } from "./model";

/**
 * Severity ranking and aggregation.
 *
 * Severity is a label rather than an ordered value, so every comparison needs an
 * explicit rank. Keeping that rank and the operations over it in one place means
 * adding a level is a single edit, and means no query module has to reimplement
 * "which of these is worst".
 */

const RANK: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
  UNKNOWN: 4,
};

/** Most severe first, for display order and for sort callbacks. */
export const SEVERITY_ORDER: readonly Severity[] = ["CRITICAL", "HIGH", "MODERATE", "LOW"];

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && value in RANK;
}

/** Coerce an unrecognised or missing label to UNKNOWN rather than throwing. */
export function toSeverity(value: unknown): Severity {
  if (isSeverity(value)) return value;
  // NVD says MEDIUM where GitHub advisories say MODERATE.
  if (typeof value === "string" && value.toUpperCase() === "MEDIUM") return "MODERATE";
  return "UNKNOWN";
}

/** Negative when `a` is more severe. Suitable for Array.prototype.sort. */
export function compareSeverity(a: Severity, b: Severity): number {
  return RANK[a] - RANK[b];
}

/** The most severe of the given labels, or null when there are none. */
export function worstSeverity(values: readonly unknown[]): Severity | null {
  const known = values.filter(isSeverity);
  if (known.length === 0) return null;
  return known.reduce((worst, next) => (compareSeverity(next, worst) < 0 ? next : worst));
}

export type SeverityCounts = Record<Severity, number>;

export function emptySeverityCounts(): SeverityCounts {
  return { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0, UNKNOWN: 0 };
}

export function countSeverities(values: readonly unknown[]): SeverityCounts {
  const counts = emptySeverityCounts();
  for (const value of values) counts[toSeverity(value)] += 1;
  return counts;
}

/** Levels present in a histogram, most severe first. UNKNOWN is excluded. */
export function presentSeverities(counts: SeverityCounts): Severity[] {
  return SEVERITY_ORDER.filter((severity) => counts[severity] > 0);
}

export function totalSeverities(counts: SeverityCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}
