import { read, readOne } from "../db";
import { MAX_TRAVERSAL_DEPTH, type Severity } from "../model";

/**
 * Vulnerability views: the graph walked in reverse.
 *
 * Everywhere else the question starts at an app and asks what it reaches. Here it
 * starts at an advisory and asks who is exposed — the same edges, traversed the
 * other way, with no additional index or denormalisation. That symmetry is the
 * plainest argument for the graph: in a relational schema "which apps does this
 * CVE affect" and "which CVEs affect this app" are two different recursive
 * queries over two different join orders.
 */

export type VulnerabilityListRow = {
  osvId: string;
  aliases: string[];
  severity: Severity;
  summary: string;
  publishedAt: string | null;
  /** Number of applications whose production tree contains an affected version. */
  appsReached: number;
  affectedVersions: number;
  /** Shallowest hop count across all apps: 1 means someone declared it directly. */
  minDepth: number;
  appSlugs: string[];
};

const VULNERABILITY_LIST = `
MATCH (vuln:Vulnerability)-[:AFFECTS]->(dep:Version)<-[reach:REACHES]-(app:App)
WITH vuln,
     count(DISTINCT app)     AS appsReached,
     count(DISTINCT dep)     AS affectedVersions,
     min(reach.depth)        AS minDepth,
     collect(DISTINCT app.slug) AS appSlugs
RETURN vuln.osvId      AS osvId,
       vuln.aliases    AS aliases,
       vuln.severity   AS severity,
       vuln.summary    AS summary,
       vuln.publishedAt AS publishedAt,
       appsReached,
       affectedVersions,
       minDepth,
       appSlugs
`;

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
  UNKNOWN: 4,
};

export async function getVulnerabilityList(): Promise<VulnerabilityListRow[]> {
  const rows = await read(VULNERABILITY_LIST, {}, (record) => ({
    osvId: record.osvId as string,
    aliases: (record.aliases ?? []) as string[],
    severity: record.severity as Severity,
    summary: record.summary as string,
    publishedAt: (record.publishedAt as string | null) ?? null,
    appsReached: record.appsReached as number,
    affectedVersions: record.affectedVersions as number,
    minDepth: record.minDepth as number,
    appSlugs: ((record.appSlugs ?? []) as string[]).sort(),
  }));

  // Ranked by blast radius first, then severity: a MODERATE reaching four apps
  // deserves attention before a CRITICAL sitting in one abandoned service.
  return rows.sort(
    (a, b) =>
      b.appsReached - a.appsReached ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
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
RETURN vuln.osvId      AS osvId,
       vuln.aliases    AS aliases,
       vuln.severity   AS severity,
       vuln.summary    AS summary,
       vuln.details    AS details,
       vuln.cvssVector AS cvssVector,
       vuln.publishedAt AS publishedAt,
       vuln.referenceUrl AS referenceUrl
`;

export async function getVulnerability(osvId: string): Promise<VulnerabilityDetail | null> {
  return readOne(VULNERABILITY_DETAIL, { osvId }, (record) => ({
    osvId: record.osvId as string,
    aliases: (record.aliases ?? []) as string[],
    severity: record.severity as Severity,
    summary: record.summary as string,
    details: (record.details as string) ?? "",
    cvssVector: (record.cvssVector as string | null) ?? null,
    publishedAt: (record.publishedAt as string | null) ?? null,
    referenceUrl: (record.referenceUrl as string | null) ?? null,
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
  /** The direct dependency to bump — the head of the chain. */
  entryPoint: string;
  entryRange: string;
};

/**
 * Reverse blast radius: every app this advisory reaches, and the path to it.
 *
 * This is the query the "who is exposed" page is built on, and it is the one that
 * would be most painful relationally. Starting from an advisory, it has to find
 * affected versions, then every app whose tree contains one, then reconstruct the
 * chain — three traversals in different directions, expressed as one pattern.
 */
const EXPOSED_APPS = `
MATCH (vuln:Vulnerability {osvId: $osvId})-[affects:AFFECTS]->(dep:Version)
MATCH (app:App)-[reach:REACHES]->(dep)

CALL {
  WITH app, dep
  MATCH (app)-[u:USES]->(root:Version)
  WHERE NOT u.dev
  MATCH p = (root)-[:DEPENDS_ON*0..${MAX_TRAVERSAL_DEPTH}]->(dep)
  RETURN [n IN nodes(p) | n.id] AS chain, u.range AS entryRange
  ORDER BY length(p) ASC
  LIMIT 1
}

RETURN app.slug   AS slug,
       app.name   AS name,
       app.kind   AS kind,
       dep.id     AS affectedVersionId,
       reach.depth AS depth,
       affects.vulnerableRange AS vulnerableRange,
       affects.fixedIn AS fixedIn,
       chain,
       entryRange
ORDER BY reach.depth ASC, app.slug
`;

export async function getExposedApps(osvId: string): Promise<ExposedApp[]> {
  return read(EXPOSED_APPS, { osvId }, (record) => {
    const chain = (record.chain ?? []) as string[];
    return {
      slug: record.slug as string,
      name: record.name as string,
      kind: record.kind as string,
      affectedVersionId: record.affectedVersionId as string,
      depth: record.depth as number,
      vulnerableRange: record.vulnerableRange as string,
      fixedIn: (record.fixedIn as string | null) ?? null,
      chain,
      entryPoint: chain[0] ?? (record.affectedVersionId as string),
      entryRange: (record.entryRange as string) ?? "",
    };
  });
}

export const VULNERABILITY_CYPHER = { VULNERABILITY_LIST, EXPOSED_APPS };
