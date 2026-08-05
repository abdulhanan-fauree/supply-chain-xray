import { MAX_TRAVERSAL_DEPTH } from "../config";

/**
 * Shared Cypher fragments.
 *
 * Three queries need "the shortest chain from a dependency this application
 * declared to some target version". Duplicating that subquery meant a fix to the
 * traversal — the dev-dependency filter, the depth bound, the tie-break — had to
 * be applied in three places and would silently diverge in the one that was
 * missed. It is defined once here and interpolated at module load.
 *
 * These are static template strings composed only of other static strings and
 * numeric constants. No caller data ever reaches them; every value the queries
 * take is a Bolt parameter.
 */

/**
 * Requires `app` and `dep` in scope; returns `chain` and `entryRange`.
 *
 * Notes on the shape:
 *
 *   - `*0..N` starts at zero hops so a target that *is* a declared dependency
 *     still produces a one-element chain. With `*1..N` it would vanish.
 *   - dev dependencies are excluded on the USES edge before the walk begins.
 *     npm installs the dev dependencies of the root project only, so a dev
 *     subtree is not part of a production install tree.
 *   - `ORDER BY length(p) LIMIT 1` rather than `shortestPath()`: it returns the
 *     path and allows the ordering in one clause, and on this engine a
 *     `shortestPath` evaluated per candidate pair is significantly slower.
 */
export const SHORTEST_CHAIN_FROM_DECLARED = `
  WITH app, dep
  MATCH (app)-[u:USES]->(root:Version)
  WHERE NOT u.dev
  MATCH p = (root)-[:DEPENDS_ON*0..${MAX_TRAVERSAL_DEPTH}]->(dep)
  RETURN [n IN nodes(p) | n.id] AS chain, u.range AS entryRange
  ORDER BY length(p) ASC
  LIMIT 1
`;

/** Properties every advisory projection returns, so the shapes stay identical. */
export const VULNERABILITY_FIELDS = `
       vuln.osvId        AS osvId,
       vuln.aliases      AS aliases,
       vuln.severity     AS severity,
       vuln.summary      AS summary,
       vuln.referenceUrl AS referenceUrl
`;
