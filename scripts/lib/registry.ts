/**
 * npm registry client.
 *
 * Three endpoints, each picked for a specific reason:
 *
 *   1. The *abbreviated* packument (`Accept: application/vnd.npm.install-v1+json`)
 *      gives the full version list and each version's dependencies. It is one to
 *      two orders of magnitude smaller than the full packument — for popular
 *      packages the full document can run to tens of megabytes — which is why
 *      the graph carries "releases behind latest" instead of publish dates.
 *
 *   2. The version document (`/<pkg>/<version>`) carries the licence for *that*
 *      version. A package's licence can change between releases, and the
 *      applications pinning old releases are exactly the ones the licence query
 *      is about, so reading it off the latest version would give the wrong
 *      answer where it matters most.
 *
 *   3. `/<pkg>/latest` carries the *current* maintainer list, description and
 *      repository. Current rather than historical by design: the trust query
 *      asks who could publish today, not who could when an old version shipped.
 */

import { fetchJson, mapLimit } from "./http";
import type { LicenseCategory, PackageNode, RepoNode } from "../../src/lib/model";

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org/downloads/point/last-week";

export type AbbreviatedVersion = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  deprecated?: string;
};

export type Packument = {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, AbbreviatedVersion>;
};

export type VersionDoc = {
  name: string;
  version: string;
  description?: string;
  license?: string | { type?: string };
  licenses?: Array<{ type?: string }> | { type?: string };
  homepage?: string;
  deprecated?: string;
  repository?: string | { url?: string; type?: string };
  maintainers?: Array<{ name?: string; email?: string }>;
};

export async function getPackument(name: string): Promise<Packument | null> {
  return fetchJson<Packument>({
    url: `${REGISTRY}/${encodePackageName(name)}`,
    namespace: "packument",
    key: name,
    headers: { accept: "application/vnd.npm.install-v1+json" },
    treat404AsNull: true,
  });
}

export async function getVersionDoc(name: string, version: string): Promise<VersionDoc | null> {
  return fetchJson<VersionDoc>({
    url: `${REGISTRY}/${encodePackageName(name)}/${encodeURIComponent(version)}`,
    namespace: "version",
    key: `${name}@${version}`,
    treat404AsNull: true,
  });
}

export async function getLatestDoc(name: string): Promise<VersionDoc | null> {
  return fetchJson<VersionDoc>({
    url: `${REGISTRY}/${encodePackageName(name)}/latest`,
    namespace: "latest",
    key: name,
    treat404AsNull: true,
  });
}

/**
 * Weekly download counts. The bulk endpoint accepts up to 128 comma-separated
 * names but rejects scoped packages, so those are fetched one at a time.
 */
export async function getWeeklyDownloads(names: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const scoped = names.filter((name) => name.startsWith("@"));
  const plain = names.filter((name) => !name.startsWith("@"));

  const batches: string[][] = [];
  for (let i = 0; i < plain.length; i += 100) batches.push(plain.slice(i, i + 100));

  await mapLimit(batches, 4, async (batch) => {
    const data = await fetchJson<Record<string, { downloads?: number } | null>>({
      url: `${DOWNLOADS_API}/${batch.join(",")}`,
      namespace: "downloads",
      key: `bulk-${batch[0]}-${batch.length}`,
      treat404AsNull: true,
    }).catch(() => null);
    if (!data) return;
    for (const [name, entry] of Object.entries(data)) {
      if (entry?.downloads != null) counts.set(name, entry.downloads);
    }
  });

  await mapLimit(scoped, 6, async (name) => {
    const data = await fetchJson<{ downloads?: number }>({
      url: `${DOWNLOADS_API}/${encodePackageName(name)}`,
      namespace: "downloads",
      key: name,
      treat404AsNull: true,
    }).catch(() => null);
    if (data?.downloads != null) counts.set(name, data.downloads);
  });

  return counts;
}

/** Scoped names contain a slash, which must survive as a path separator. */
function encodePackageName(name: string): string {
  return name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1).split("/")[0])}/${encodeURIComponent(
        name.split("/")[1] ?? "",
      )}`
    : encodeURIComponent(name);
}

/** The registry has accumulated four different shapes for the license field. */
export function normaliseLicense(doc: VersionDoc | null): string {
  if (!doc) return "UNKNOWN";
  const { license, licenses } = doc;
  if (typeof license === "string" && license.trim()) return license.trim();
  if (license && typeof license === "object" && license.type) return license.type;
  if (Array.isArray(licenses) && licenses[0]?.type) return licenses[0].type;
  if (licenses && !Array.isArray(licenses) && licenses.type) return licenses.type;
  return "UNKNOWN";
}

/**
 * Bucket a licence by the obligation it imposes on whoever distributes software
 * that links it. That is the axis the obligations query reports on: an AGPL
 * dependency four hops down a web application is a legal event, an Apache-2.0 one
 * is not.
 */
export function categoriseLicense(spdxId: string): LicenseCategory {
  const id = spdxId.trim().toUpperCase().replace(/^\(|\)$/g, "");
  if (id === "UNKNOWN" || id === "" || /^SEE LICENSE/.test(id)) return "unknown";

  // SPDX expressions are decomposed rather than pattern-matched whole, because
  // the two operators mean opposite things. "(BSD-3-Clause OR GPL-2.0)" is a
  // choice — the licensee may take the BSD side and incur no copyleft obligation
  // — so the least restrictive operand governs. "AND" binds every operand at
  // once, so the most restrictive one does.
  //
  // Operators are whitespace-delimited, not word-boundary-delimited: a hyphen is
  // a word boundary, so a \bOR\b pattern matches the "or" inside
  // "LGPL-3.0-or-later" and splits it into unrecognisable fragments. Both cases
  // are covered by tests/licenses.test.ts.
  if (/\s+OR\s+/.test(id)) {
    return leastRestrictive(id.split(/\s+OR\s+/).map(categoriseLicense));
  }
  if (/\s+AND\s+/.test(id)) {
    return mostRestrictive(id.split(/\s+AND\s+/).map(categoriseLicense));
  }

  if (/AGPL/.test(id)) return "network-copyleft";
  if (/LGPL/.test(id)) return "weak-copyleft";
  if (/GPL-[23]/.test(id)) return "copyleft";
  if (/MPL|EPL|CDDL|EUPL|OSL/.test(id)) return "weak-copyleft";
  if (/UNLICENSED|PROPRIETARY|COMMERCIAL/.test(id)) return "proprietary";
  // CC-BY requires attribution but imposes no source obligation, so against the
  // question this categorisation answers it belongs with the permissive set.
  if (/MIT|APACHE|BSD|ISC|UNLICENSE|CC0|CC-BY|WTFPL|ZLIB|PYTHON|ARTISTIC|BLUEOAK|POSTGRE/.test(id)) {
    return "permissive";
  }
  return "unknown";
}

/** Obligation strength, weakest first. */
const RESTRICTIVENESS: LicenseCategory[] = [
  "permissive",
  "unknown",
  "weak-copyleft",
  "copyleft",
  "network-copyleft",
  "proprietary",
];

function leastRestrictive(categories: LicenseCategory[]): LicenseCategory {
  return categories.reduce((best, next) =>
    RESTRICTIVENESS.indexOf(next) < RESTRICTIVENESS.indexOf(best) ? next : best,
  );
}

function mostRestrictive(categories: LicenseCategory[]): LicenseCategory {
  return categories.reduce((worst, next) =>
    RESTRICTIVENESS.indexOf(next) > RESTRICTIVENESS.indexOf(worst) ? next : worst,
  );
}

/** Pull host/owner/name out of the many forms npm accepts for `repository`. */
export function parseRepo(doc: VersionDoc | null): RepoNode | null {
  const repository = doc?.repository;
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) return null;

  const match = raw.match(
    /(?:github|gitlab|bitbucket)\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/i,
  );
  if (!match) return null;

  const host = raw.includes("gitlab.com")
    ? "gitlab.com"
    : raw.includes("bitbucket.org")
      ? "bitbucket.org"
      : "github.com";
  const [, owner, name] = match;
  return { id: `${host}/${owner}/${name}`, host, owner, name };
}

export function repoUrl(repo: RepoNode | null): string | null {
  return repo ? `https://${repo.host}/${repo.owner}/${repo.name}` : null;
}

export function packageNodeFrom(
  name: string,
  latest: VersionDoc | null,
  packument: Packument | null,
  downloads: number | null,
): PackageNode {
  const repo = parseRepo(latest);
  return {
    name,
    description: latest?.description?.trim() || null,
    latestVersion: packument?.["dist-tags"]?.latest ?? latest?.version ?? null,
    weeklyDownloads: downloads,
    deprecated: Boolean(latest?.deprecated),
    repoUrl: repoUrl(repo),
    homepage: latest?.homepage?.trim() || null,
  };
}
