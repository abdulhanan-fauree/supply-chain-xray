import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dedupeByAliasCluster, matchAffectedVersions, type OsvVuln } from "../scripts/lib/osv";

function advisory(overrides: Partial<OsvVuln> & { id: string }): OsvVuln {
  return { summary: "", aliases: [], affected: [], ...overrides };
}

function npmRange(name: string, introduced: string, fixed?: string): OsvVuln["affected"] {
  return [
    {
      package: { name, ecosystem: "npm" },
      ranges: [
        {
          type: "SEMVER",
          events: fixed ? [{ introduced }, { fixed }] : [{ introduced }],
        },
      ],
    },
  ];
}

describe("matchAffectedVersions", () => {
  it("matches versions inside a half-open range", () => {
    const vuln = advisory({ id: "GHSA-x", affected: npmRange("lodash", "3.7.0", "4.17.19") });
    const matches = matchAffectedVersions(vuln, "lodash", ["4.17.15", "4.17.19", "4.17.21"]);

    assert.deepEqual(
      matches.map((match) => match.version),
      ["4.17.15"],
    );
    // The fix boundary is exclusive: the fixed version is not itself affected.
    assert.equal(matches[0].fixedIn, "4.17.19");
    assert.equal(matches[0].vulnerableRange, ">=3.7.0 <4.17.19");
  });

  it("treats an introduced event with no fix as unbounded above", () => {
    const vuln = advisory({ id: "GHSA-y", affected: npmRange("left-pad", "1.0.0") });
    const matches = matchAffectedVersions(vuln, "left-pad", ["0.9.0", "1.0.0", "9.9.9"]);

    assert.deepEqual(
      matches.map((match) => match.version).sort(),
      ["1.0.0", "9.9.9"],
    );
    assert.equal(matches[0].fixedIn, null);
  });

  it("normalises the sentinel introduced version of 0", () => {
    const vuln = advisory({ id: "GHSA-z", affected: npmRange("ms", "0", "2.0.0") });
    const matches = matchAffectedVersions(vuln, "ms", ["0.7.1", "2.0.0"]);
    assert.deepEqual(
      matches.map((match) => match.version),
      ["0.7.1"],
    );
  });

  it("ignores affected entries for other ecosystems", () => {
    // Advisories routinely carry Debian and Alpine entries alongside the npm one.
    const vuln = advisory({
      id: "GHSA-multi",
      affected: [
        {
          package: { name: "lodash", ecosystem: "Debian:11" },
          ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }],
        },
      ],
    });
    assert.deepEqual(matchAffectedVersions(vuln, "lodash", ["4.17.15"]), []);
  });

  it("ignores affected entries for a different package", () => {
    const vuln = advisory({ id: "GHSA-other", affected: npmRange("not-lodash", "0") });
    assert.deepEqual(matchAffectedVersions(vuln, "lodash", ["4.17.15"]), []);
  });

  it("honours an explicit versions list", () => {
    const vuln = advisory({
      id: "GHSA-list",
      affected: [{ package: { name: "tar", ecosystem: "npm" }, versions: ["4.4.10"] }],
    });
    const matches = matchAffectedVersions(vuln, "tar", ["4.4.10", "6.0.0"]);
    assert.deepEqual(
      matches.map((match) => match.version),
      ["4.4.10"],
    );
  });

  it("skips non-semver range types it cannot compare", () => {
    const vuln = advisory({
      id: "GHSA-git",
      affected: [
        {
          package: { name: "thing", ecosystem: "npm" },
          ranges: [{ type: "GIT", events: [{ introduced: "abc123" }] }],
        },
      ],
    });
    assert.deepEqual(matchAffectedVersions(vuln, "thing", ["1.0.0"]), []);
  });
});

describe("dedupeByAliasCluster", () => {
  it("collapses records that alias each other", () => {
    // OSV ships two GHSA records for CVE-2021-23337, each listing the other.
    const first = advisory({
      id: "GHSA-35jh-r3h4-6jhm",
      aliases: ["CVE-2021-23337", "GHSA-r5fr-rjxr-66jc"],
      modified: "2026-07-08T00:00:00Z",
    });
    const second = advisory({
      id: "GHSA-r5fr-rjxr-66jc",
      aliases: ["CVE-2021-23337", "GHSA-35jh-r3h4-6jhm"],
      modified: "2025-08-12T00:00:00Z",
    });

    const { canonical, canonicalIdOf } = dedupeByAliasCluster([first, second]);

    assert.equal(canonical.length, 1);
    // The most recently modified record survives.
    assert.equal(canonical[0].id, "GHSA-35jh-r3h4-6jhm");
    // Both ids resolve to the survivor, so existing references still find it.
    assert.equal(canonicalIdOf.get("GHSA-r5fr-rjxr-66jc"), "GHSA-35jh-r3h4-6jhm");
    assert.equal(canonicalIdOf.get("GHSA-35jh-r3h4-6jhm"), "GHSA-35jh-r3h4-6jhm");
    // The survivor inherits the absorbed id as an alias.
    assert.ok(canonical[0].aliases?.includes("GHSA-r5fr-rjxr-66jc"));
  });

  it("groups transitively through a shared alias", () => {
    const records = [
      advisory({ id: "A", aliases: ["CVE-1"], modified: "2026-01-01T00:00:00Z" }),
      advisory({ id: "B", aliases: ["CVE-1"], modified: "2025-01-01T00:00:00Z" }),
      advisory({ id: "C", aliases: ["CVE-1"], modified: "2024-01-01T00:00:00Z" }),
    ];
    const { canonical } = dedupeByAliasCluster(records);
    assert.equal(canonical.length, 1);
    assert.equal(canonical[0].id, "A");
  });

  it("leaves unrelated records alone", () => {
    const records = [
      advisory({ id: "A", aliases: ["CVE-1"] }),
      advisory({ id: "B", aliases: ["CVE-2"] }),
    ];
    assert.equal(dedupeByAliasCluster(records).canonical.length, 2);
  });

  it("is stable when modified dates tie", () => {
    const records = [
      advisory({ id: "GHSA-b", aliases: ["CVE-9"], modified: "2026-01-01T00:00:00Z" }),
      advisory({ id: "GHSA-a", aliases: ["CVE-9"], modified: "2026-01-01T00:00:00Z" }),
    ];
    // Tie broken by id, so repeated runs produce the same dataset.
    assert.equal(dedupeByAliasCluster(records).canonical[0].id, "GHSA-a");
    assert.equal(dedupeByAliasCluster([...records].reverse()).canonical[0].id, "GHSA-a");
  });
});
