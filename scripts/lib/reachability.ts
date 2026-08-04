import type { DependsOnEdge, ReachesEdge, UsesEdge } from "../../src/lib/model";

/**
 * Breadth-first reachability from each application over its production install
 * tree, recording the minimum hop count to every version reached.
 *
 * BFS visits each node once at its shortest distance, which is exactly what a
 * per-pair shortest-path search would compute — one sweep per source rather than
 * one search per (source, target) pair. Doing it here rather than in Cypher turns
 * the most expensive query in the application into an edge property. See
 * ReachesEdge in model.ts for what that trades away.
 *
 * Dev dependencies are excluded at the root, matching every traversal in the
 * application: npm installs the devDependencies of the root project only, so a
 * dev subtree is not part of a production install tree.
 */
export function computeReachability(
  uses: readonly UsesEdge[],
  dependsOn: readonly DependsOnEdge[],
): ReachesEdge[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of dependsOn) {
    const neighbours = adjacency.get(edge.fromVersionId);
    if (neighbours) neighbours.push(edge.toVersionId);
    else adjacency.set(edge.fromVersionId, [edge.toVersionId]);
  }

  const rootsByApp = new Map<string, string[]>();
  for (const edge of uses) {
    if (edge.dev) continue;
    const roots = rootsByApp.get(edge.appSlug);
    if (roots) roots.push(edge.versionId);
    else rootsByApp.set(edge.appSlug, [edge.versionId]);
  }

  const reaches: ReachesEdge[] = [];

  for (const [appSlug, roots] of rootsByApp) {
    const depthOf = new Map<string, number>();
    // A plain array as a FIFO queue with a moving read cursor. Because BFS
    // dequeues in non-decreasing depth order, the first time a version is seen is
    // its shortest distance, so no revisiting is needed.
    const queue: string[] = [];

    for (const root of roots) {
      if (depthOf.has(root)) continue;
      depthOf.set(root, 1);
      queue.push(root);
    }

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      const nextDepth = depthOf.get(current)! + 1;
      for (const neighbour of adjacency.get(current) ?? []) {
        if (depthOf.has(neighbour)) continue;
        depthOf.set(neighbour, nextDepth);
        queue.push(neighbour);
      }
    }

    for (const [versionId, depth] of depthOf) {
      reaches.push({ appSlug, versionId, depth });
    }
  }

  return reaches;
}
