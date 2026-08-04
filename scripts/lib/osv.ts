/**
 * OSV.dev client.
 *
 * Two calls: `querybatch` maps package names to advisory ids (up to 1000
 * packages per request, no auth), then `/vulns/<id>` fetches each advisory once.
 * Advisories are shared across packages, so fetching them by id rather than per
 * package avoids re-downloading the same document dozens of times.
 *
 * The important work here is deciding *which of our versions* an advisory
 * actually hits. OSV expresses that two ways — an explicit `versions` list, or
 * SEMVER `ranges` built from introduced/fixed events — and an advisory may carry
 * several `affected` entries covering other ecosystems entirely. Getting this
 * wrong in the permissive direction would make the whole app cry wolf.
 */

import { createHash } from "node:crypto";
import semver from "semver";
import { fetchJson, mapLimit } from "./http";
import type { Severity, VulnerabilityNode } from "../../src/lib/model";

const OSV = "https://api.osv.dev/v1";

type OsvRange = {
  type: string;
  events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
};

type OsvAffected = {
  package?: { name?: string; ecosystem?: string };
  ranges?: OsvRange[];
  versions?: string[];
};

export type OsvVuln = {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  modified?: string;
  severity?: Array<{ type?: string; score?: string }>;
  database_specific?: { severity?: string };
  references?: Array<{ type?: string; url?: string }>;
  affected?: OsvAffected[];
};

/** Advisory ids per package name. */
export async function queryAdvisoryIds(names: string[]): Promise<Map<string, string[]>> {
  const byPackage = new Map<string, string[]>();
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += 200) batches.push(names.slice(i, i + 200));

  await mapLimit(batches, 3, async (batch) => {
    const response = await fetchJson<{ results?: Array<{ vulns?: Array<{ id: string }> }> }>({
      url: `${OSV}/querybatch`,
      namespace: "osv-batch",
      // Keyed by batch *contents*, not position. A positional key silently
      // mismatches whenever the package list shifts by even one entry, so a
      // re-crawl re-queries OSV and can pick up a different advisory set —
      // which is exactly how a "cached" run stopped being reproducible.
      key: createHash("sha1").update(batch.join(",")).digest("hex"),
      method: "POST",
      body: {
        queries: batch.map((name) => ({ package: { name, ecosystem: "npm" } })),
      },
    });
    // Results are positional: results[i] corresponds to queries[i].
    batch.forEach((name, i) => {
      const vulns = response?.results?.[i]?.vulns ?? [];
      if (vulns.length) byPackage.set(name, vulns.map((v) => v.id));
    });
  });

  return byPackage;
}

export async function getAdvisory(osvId: string): Promise<OsvVuln | null> {
  return fetchJson<OsvVuln>({
    url: `${OSV}/vulns/${encodeURIComponent(osvId)}`,
    namespace: "osv-vuln",
    key: osvId,
    treat404AsNull: true,
  });
}

const SEVERITY_LABELS: Severity[] = ["CRITICAL", "HIGH", "MODERATE", "LOW"];

export function severityOf(vuln: OsvVuln): Severity {
  const label = vuln.database_specific?.severity?.toUpperCase();
  if (label && (SEVERITY_LABELS as string[]).includes(label)) return label as Severity;
  if (label === "MEDIUM") return "MODERATE"; // Some sources use NVD's wording.
  return "UNKNOWN";
}

export function cvssVectorOf(vuln: OsvVuln): string | null {
  const entry =
    vuln.severity?.find((s) => s.type === "CVSS_V4") ??
    vuln.severity?.find((s) => s.type === "CVSS_V3") ??
    vuln.severity?.[0];
  return entry?.score ?? null;
}

export function toVulnerabilityNode(vuln: OsvVuln): VulnerabilityNode {
  const advisory =
    vuln.references?.find((r) => r.type === "ADVISORY")?.url ??
    vuln.references?.find((r) => r.url)?.url ??
    null;
  return {
    osvId: vuln.id,
    aliases: vuln.aliases ?? [],
    severity: severityOf(vuln),
    cvssVector: cvssVectorOf(vuln),
    summary: (vuln.summary ?? "").trim() || "No summary provided by the advisory.",
    // Trimmed: the full markdown body can be long, and the UI links out for it.
    details: (vuln.details ?? "").trim().slice(0, 1200),
    publishedAt: vuln.published ?? null,
    referenceUrl: advisory,
  };
}

export type AffectedMatch = {
  version: string;
  /** Human-readable form of the range the advisory declares vulnerable. */
  vulnerableRange: string;
  fixedIn: string | null;
};

/**
 * Which of `candidateVersions` this advisory affects for `packageName`.
 *
 * Only `affected` entries whose ecosystem is npm and whose package name matches
 * are considered — advisories routinely carry entries for Debian, Alpine and
 * other ecosystems alongside the npm one.
 */
export function matchAffectedVersions(
  vuln: OsvVuln,
  packageName: string,
  candidateVersions: string[],
): AffectedMatch[] {
  const matches = new Map<string, AffectedMatch>();

  for (const affected of vuln.affected ?? []) {
    if (affected.package?.ecosystem !== "npm") continue;
    if (affected.package?.name !== packageName) continue;

    // Form 1: an explicit list of affected versions. Authoritative when present.
    if (affected.versions?.length) {
      const listed = new Set(affected.versions);
      for (const candidate of candidateVersions) {
        if (listed.has(candidate) && !matches.has(candidate)) {
          matches.set(candidate, {
            version: candidate,
            vulnerableRange: describeRanges(affected.ranges) ?? "listed explicitly by the advisory",
            fixedIn: firstFixed(affected.ranges),
          });
        }
      }
    }

    // Form 2: SEMVER ranges as introduced/fixed event pairs.
    for (const range of affected.ranges ?? []) {
      if (range.type !== "SEMVER") continue; // ECOSYSTEM/GIT ranges are not semver-comparable.
      for (const interval of toIntervals(range)) {
        for (const candidate of candidateVersions) {
          if (matches.has(candidate)) continue;
          if (semver.satisfies(candidate, interval.range, { includePrerelease: true })) {
            matches.set(candidate, {
              version: candidate,
              vulnerableRange: interval.range,
              fixedIn: interval.fixed,
            });
          }
        }
      }
    }
  }

  return [...matches.values()];
}

/**
 * OSV events are a flat, ordered stream: an `introduced` opens an interval and
 * the next `fixed` or `last_affected` closes it. A trailing `introduced` with no
 * close means "everything from here on is still vulnerable".
 */
function toIntervals(range: OsvRange): Array<{ range: string; fixed: string | null }> {
  const intervals: Array<{ range: string; fixed: string | null }> = [];
  let introduced: string | null = null;

  for (const event of range.events) {
    if (event.introduced !== undefined) {
      introduced = event.introduced === "0" ? "0.0.0" : event.introduced;
      continue;
    }
    if (introduced === null) continue; // Malformed stream; ignore the close.
    if (event.fixed !== undefined) {
      intervals.push({ range: `>=${introduced} <${event.fixed}`, fixed: event.fixed });
      introduced = null;
    } else if (event.last_affected !== undefined) {
      intervals.push({ range: `>=${introduced} <=${event.last_affected}`, fixed: null });
      introduced = null;
    }
  }

  if (introduced !== null) intervals.push({ range: `>=${introduced}`, fixed: null });
  return intervals;
}

function firstFixed(ranges: OsvRange[] | undefined): string | null {
  for (const range of ranges ?? []) {
    for (const event of range.events) {
      if (event.fixed) return event.fixed;
    }
  }
  return null;
}

function describeRanges(ranges: OsvRange[] | undefined): string | null {
  const parts = (ranges ?? [])
    .filter((r) => r.type === "SEMVER")
    .flatMap((r) => toIntervals(r).map((i) => i.range));
  return parts.length ? parts.join(" || ") : null;
}

export async function fetchAdvisories(osvIds: string[]): Promise<OsvVuln[]> {
  const fetched = await mapLimit(osvIds, 8, (id) => getAdvisory(id).catch(() => null));
  return fetched.filter((vuln): vuln is OsvVuln => vuln !== null);
}

/**
 * Collapse advisories that describe the same underlying issue.
 *
 * OSV frequently carries two GHSA records for one vulnerability — GHSA-35jh and
 * GHSA-r5fr are both CVE-2021-23337 in lodash, and each lists the other in its
 * aliases. Left alone, the UI would report six lodash vulnerabilities where
 * there are four, and a triage tool that inflates its own counts is worse than
 * no tool. Advisories are grouped into clusters by shared alias (union-find over
 * ids and aliases), and one representative is kept per cluster: the most
 * recently modified record, with ties broken by id so the result is stable
 * across runs.
 *
 * Returns the surviving advisories plus a map from every collapsed id to its
 * canonical id, so AFFECTS edges can be rewritten onto the survivor.
 */
export function dedupeByAliasCluster(advisories: OsvVuln[]): {
  canonical: OsvVuln[];
  canonicalIdOf: Map<string, string>;
} {
  const parent = new Map<string, string>();

  const find = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression, so repeated lookups stay flat.
    let walk = key;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };

  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const advisory of advisories) {
    find(advisory.id);
    for (const alias of advisory.aliases ?? []) union(advisory.id, alias);
  }

  const clusters = new Map<string, OsvVuln[]>();
  for (const advisory of advisories) {
    const root = find(advisory.id);
    const members = clusters.get(root) ?? [];
    members.push(advisory);
    clusters.set(root, members);
  }

  const canonical: OsvVuln[] = [];
  const canonicalIdOf = new Map<string, string>();

  for (const members of clusters.values()) {
    const winner = [...members].sort((a, b) => {
      const modifiedDiff = (b.modified ?? "").localeCompare(a.modified ?? "");
      return modifiedDiff !== 0 ? modifiedDiff : a.id.localeCompare(b.id);
    })[0];

    // The survivor inherits every alias in the cluster, including the ids of the
    // records it absorbed, so a search for the collapsed GHSA still finds it.
    const aliases = new Set<string>();
    for (const member of members) {
      if (member.id !== winner.id) aliases.add(member.id);
      for (const alias of member.aliases ?? []) aliases.add(alias);
      canonicalIdOf.set(member.id, winner.id);
    }
    aliases.delete(winner.id);

    canonical.push({ ...winner, aliases: [...aliases].sort() });
  }

  return { canonical, canonicalIdOf };
}
