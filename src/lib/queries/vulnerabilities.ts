import { read, readOne } from "../db";
import { compareSeverity, toSeverity } from "../severity";
import type { Severity } from "../model";
import { SHORTEST_CHAIN_FROM_DECLARED } from "./fragments";

/**
 * Advisory views: the graph walked in reverse.
 *
 * Elsewhere a question starts at an application and asks what it reaches. Here it
 * starts at an advisory and asks who is exposed — the same relationships,
 * traversed the other way, with no extra index or denormalisation. Relationally
 * these are two different recursive queries over two different join orders, both
 * of which have to be maintained.
 */

export type VulnerabilityListRow = {
  osvId: string;
  aliases: string[];
  severity: Severity;
  summary: string;
  publishedAt: string | null;
  /** Applications whose production tree contains an affected version. */
  appsReached: number;
  affectedVersions: number;
  /** Shallowest hop count across those applications; 1 means declared directly. */
  minDepth: number;
  appSlugs: string[];
};

const VULNERABILITY_LIST = `
MATCH (vuln:Vulnerability)-[:AFFECTS]->(dep:Version)<-[reach:REACHES]-(app:App)
WITH vuln,
     count(DISTINCT app)        AS appsReached,
     count(DISTINCT dep)        AS affectedVersions,
     min(reach.depth)           AS minDepth,
     collect(DISTINCT app.slug) AS appSlugs
RETURN vuln.osvId       AS osvId,
       vuln.aliases     AS aliases,
       vuln.severity    AS severity,
       vuln.summary     AS summary,
       vuln.publishedAt AS publishedAt,
       appsReached, affectedVersions, minDepth, appSlugs
`;

export async function getVulnerabilityList(): Promise<VulnerabilityListRow[]> {
  const rows = await read(VULNERABILITY_LIST, {}, (row) => ({
    osvId: row.string("osvId"),
    aliases: row.strings("aliases"),
    severity: toSeverity(row.raw("severity")),
    summary: row.string("summary"),
    publishedAt: row.stringOrNull("publishedAt"),
    appsReached: row.count("appsReached"),
    affectedVersions: row.count("affectedVersions"),
    minDepth: row.count("minDepth"),
    appSlugs: row.strings("appSlugs").sort(),
  }));

  // Blast radius before severity: a moderate issue in a package several
  // applications share is a larger problem than a critical one in a single
  // abandoned service, and ranking by severity alone would bury it.
  return rows.sort(
    (a, b) =>
      b.appsReached - a.appsReached ||
      compareSeverity(a.severity, b.severity) ||
      a.osvId.localeCompare(b.osvId),
  );
}

export type VulnerabilityDetail = {
  osvId: string;
  aliases: string[];
  severity: Severity;
  summary: string;
  details: string;
  cvssVector: string | null;
  publishedAt: string | null;
  referenceUrl: string | null;
};

const VULNERABILITY_DETAIL = `
MATCH (vuln:Vulnerability {osvId: $osvId})
RETURN vuln.osvId        AS osvId,
       vuln.aliases      AS aliases,
       vuln.severity     AS severity,
       vuln.summary      AS summary,
       vuln.details      AS details,
       vuln.cvssVector   AS cvssVector,
       vuln.publishedAt  AS publishedAt,
       vuln.referenceUrl AS referenceUrl
`;

export async function getVulnerability(osvId: string): Promise<VulnerabilityDetail | null> {
  return readOne(VULNERABILITY_DETAIL, { osvId }, (row) => ({
    osvId: row.string("osvId"),
    aliases: row.strings("aliases"),
    severity: toSeverity(row.raw("severity")),
    summary: row.string("summary"),
    details: row.stringOrNull("details") ?? "",
    cvssVector: row.stringOrNull("cvssVector"),
    publishedAt: row.stringOrNull("publishedAt"),
    referenceUrl: row.stringOrNull("referenceUrl"),
  }));
}

export type ExposedApp = {
  slug: string;
  name: string;
  kind: string;
  affectedVersionId: string;
  depth: number;
  vulnerableRange: string;
  fixedIn: string | null;
  chain: string[];
  /** The declared dependency to bump — the head of the chain. */
  entryPoint: string;
  entryRange: string;
};

/**
 * Every application an advisory reaches, with the path to it.
 *
 * Three traversals in different directions expressed as one pattern: advisory to
 * affected versions, versions back to the applications containing them, then the
 * chain that carries each.
 */
const EXPOSED_APPS = `
MATCH (vuln:Vulnerability {osvId: $osvId})-[affects:AFFECTS]->(dep:Version)
MATCH (app:App)-[reach:REACHES]->(dep)
CALL {
${SHORTEST_CHAIN_FROM_DECLARED}
}
RETURN app.slug    AS slug,
       app.name    AS name,
       app.kind    AS kind,
       dep.id      AS affectedVersionId,
       reach.depth AS depth,
       affects.vulnerableRange AS vulnerableRange,
       affects.fixedIn AS fixedIn,
       chain, entryRange
ORDER BY reach.depth ASC, app.slug
`;

export async function getExposedApps(osvId: string): Promise<ExposedApp[]> {
  return read(EXPOSED_APPS, { osvId }, (row) => {
    const chain = row.strings("chain");
    const affectedVersionId = row.string("affectedVersionId");
    return {
      slug: row.string("slug"),
      name: row.string("name"),
      kind: row.string("kind"),
      affectedVersionId,
      depth: row.count("depth"),
      vulnerableRange: row.string("vulnerableRange"),
      fixedIn: row.stringOrNull("fixedIn"),
      chain,
      entryPoint: chain[0] ?? affectedVersionId,
      entryRange: row.stringOrNull("entryRange") ?? "",
    };
  });
}

export const VULNERABILITY_CYPHER = { VULNERABILITY_LIST, EXPOSED_APPS };
