/**
 * Application-wide tuning constants.
 *
 * Values that need to agree across the query layer, the loader and the UI live
 * here so they cannot drift apart. Anything read from the environment belongs in
 * env.ts instead.
 */

/**
 * Upper bound on every variable-length traversal.
 *
 * Dependency graphs contain cycles, so an unbounded pattern is not safe. Eight
 * hops comfortably covers the deepest real chain in the dataset (nine packages)
 * while keeping the search space small enough for a burstable instance.
 */
export const MAX_TRAVERSAL_DEPTH = 8;

/**
 * Rows written per transaction by the loader. Sized for a 256 MB instance: a
 * large UNWIND materialises its whole intermediate result in memory.
 */
export const LOAD_BATCH_SIZE = 500;

/**
 * Page cache window.
 *
 * Not exported as a constant: Next.js requires `export const revalidate` to be a
 * statically analysable literal in each route segment, and an imported binding is
 * rejected at build time. Every page declares `revalidate = 60` directly. The
 * value is safe to cache for because the graph changes only when the seed script
 * runs.
 */

/** Rows per page for each paginated list. */
export const PAGE_SIZE = {
  advisories: 25,
  chokePoints: 30,
  maintainers: 25,
  soleMaintainers: 25,
  dependents: 25,
} as const;

/**
 * Driver connection tuning.
 *
 * Timeouts are set against how long a person will wait on a loading state
 * rather than against protocol defaults: an unreachable host surfaces an error
 * card in roughly five seconds, against a quarter-second for a healthy query.
 * The pool is small because the web app needs few connections and the seed
 * script should not have to compete for the instance's 200-connection limit.
 */
export const DRIVER = {
  maxConnectionPoolSize: 12,
  connectionAcquisitionTimeout: 6_000,
  connectionTimeout: 4_000,
  maxTransactionRetryTime: 4_000,
  /** Server-side ceiling on a single read, so a runaway query is cancelled. */
  queryTimeout: 20_000,
} as const;

/** Minimum applications a package must appear in to count as a choke point. */
export const CHOKE_POINT_MIN_APPS = 2;

/** Accounts included in the "top N reach" headline on the trust page. */
export const TRUST_SUMMARY_TOP_N = 5;
