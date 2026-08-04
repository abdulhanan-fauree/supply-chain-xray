import type { RecordShape } from "neo4j-driver";

/**
 * Typed reads over a driver record.
 *
 * A Bolt record arrives as untyped values, so mapping one to a domain object
 * otherwise means a cast per field. Casts silence the compiler without checking
 * anything: rename a column in Cypher and `record.slug as string` yields
 * `undefined` typed as `string`, which then fails somewhere unrelated.
 *
 * These readers check instead. A missing or wrong-typed required field throws
 * naming the key, which turns a schema mismatch into an immediate, locatable
 * error rather than a downstream mystery.
 */
export class Row {
  constructor(private readonly record: RecordShape) {}

  private require(key: string): unknown {
    const value = this.record[key];
    if (value === undefined) {
      throw new Error(
        `Query result has no column "${key}". Available: ${Object.keys(this.record).join(", ")}`,
      );
    }
    return value;
  }

  private fail(key: string, expected: string, value: unknown): never {
    throw new Error(
      `Column "${key}" should be ${expected} but was ${
        value === null ? "null" : typeof value
      } (${JSON.stringify(value)?.slice(0, 60)})`,
    );
  }

  string(key: string): string {
    const value = this.require(key);
    if (typeof value !== "string") this.fail(key, "a string", value);
    return value;
  }

  stringOrNull(key: string): string | null {
    const value = this.record[key];
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") this.fail(key, "a string or null", value);
    return value;
  }

  /**
   * The driver is configured with disableLosslessIntegers, so counts arrive as
   * plain numbers. Nothing in this data model approaches 2^53.
   */
  number(key: string): number {
    const value = this.require(key);
    if (typeof value !== "number" || Number.isNaN(value)) this.fail(key, "a number", value);
    return value;
  }

  numberOrNull(key: string): number | null {
    const value = this.record[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || Number.isNaN(value)) this.fail(key, "a number or null", value);
    return value;
  }

  /** Coalesces null to zero, for aggregates over an empty match. */
  count(key: string): number {
    return this.numberOrNull(key) ?? 0;
  }

  boolean(key: string): boolean {
    return Boolean(this.record[key]);
  }

  /** Absent, null and empty all yield an empty array, so callers need no guard. */
  strings(key: string): string[] {
    const value = this.record[key];
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) this.fail(key, "an array of strings", value);
    return value.filter((item): item is string => typeof item === "string");
  }

  /** Values collected by Cypher whose element type is not known statically. */
  list(key: string): unknown[] {
    const value = this.record[key];
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) this.fail(key, "an array", value);
    return value;
  }

  /**
   * Pairs from `collect(DISTINCT [a, b])`. Malformed entries are dropped rather
   * than throwing: an OPTIONAL MATCH that found nothing collects `[null, null]`.
   */
  pairs(key: string): Array<[unknown, unknown]> {
    return this.list(key).filter(
      (entry): entry is [unknown, unknown] => Array.isArray(entry) && entry.length >= 2,
    );
  }

  /** Escape hatch for shapes the readers above do not cover. */
  raw(key: string): unknown {
    return this.record[key];
  }
}
