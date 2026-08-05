import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareVersions,
  formatVersionId,
  highestVersion,
  packageNameOf,
  parseVersionId,
} from "../src/lib/version-id";
import {
  compareSeverity,
  countSeverities,
  presentSeverities,
  toSeverity,
  worstSeverity,
} from "../src/lib/severity";
import { computeReachability } from "../scripts/lib/reachability";
import type { DependsOnEdge, UsesEdge } from "../src/lib/model";

describe("parseVersionId", () => {
  it("splits an unscoped id", () => {
    assert.deepEqual(parseVersionId("lodash@4.17.15"), { name: "lodash", version: "4.17.15" });
  });

  it("splits a scoped id on the last separator", () => {
    // The naive split("@") would return ["", "types/node", "22.10.2"].
    assert.deepEqual(parseVersionId("@types/node@22.10.2"), {
      name: "@types/node",
      version: "22.10.2",
    });
  });

  it("handles prerelease and build metadata in the version", () => {
    assert.deepEqual(parseVersionId("next@15.0.0-rc.1"), {
      name: "next",
      version: "15.0.0-rc.1",
    });
  });

  it("returns an empty version when the id carries none", () => {
    assert.deepEqual(parseVersionId("lodash"), { name: "lodash", version: "" });
    assert.deepEqual(parseVersionId("@scope/pkg"), { name: "@scope/pkg", version: "" });
  });

  it("round-trips through formatVersionId", () => {
    for (const id of ["lodash@4.17.15", "@types/node@22.10.2"]) {
      const { name, version } = parseVersionId(id);
      assert.equal(formatVersionId(name, version), id);
    }
  });

  it("exposes the package name directly", () => {
    assert.equal(packageNameOf("@img/sharp-libvips-darwin-arm64@1.2.4"), "@img/sharp-libvips-darwin-arm64");
  });
});

describe("compareVersions", () => {
  it("orders by numeric segment rather than lexically", () => {
    // A string compare would put 10 before 9.
    assert.ok(compareVersions("4.17.10", "4.17.9") > 0);
    assert.ok(compareVersions("1.0.0", "10.0.0") < 0);
    assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  });

  it("treats a missing segment as zero", () => {
    assert.equal(compareVersions("2.0", "2.0.0"), 0);
    assert.ok(compareVersions("2.0.1", "2.0") > 0);
  });

  it("picks the highest fix across a set, ignoring nulls", () => {
    assert.equal(highestVersion(["4.17.19", null, "4.18.0", "4.17.21"]), "4.18.0");
    assert.equal(highestVersion([null, null]), null);
    assert.equal(highestVersion([]), null);
  });
});

describe("severity", () => {
  it("ranks critical as most severe", () => {
    assert.ok(compareSeverity("CRITICAL", "HIGH") < 0);
    assert.ok(compareSeverity("LOW", "MODERATE") > 0);
    assert.equal(compareSeverity("HIGH", "HIGH"), 0);
  });

  it("maps NVD's MEDIUM onto MODERATE, whatever the casing", () => {
    assert.equal(toSeverity("MEDIUM"), "MODERATE");
    assert.equal(toSeverity("medium"), "MODERATE");
  });

  it("coerces unrecognised and missing labels to UNKNOWN", () => {
    assert.equal(toSeverity(undefined), "UNKNOWN");
    assert.equal(toSeverity(null), "UNKNOWN");
    assert.equal(toSeverity("SPICY"), "UNKNOWN");
  });

  it("finds the worst of a mixed list and ignores junk", () => {
    assert.equal(worstSeverity(["LOW", "CRITICAL", "MODERATE"]), "CRITICAL");
    assert.equal(worstSeverity([null, "HIGH", undefined]), "HIGH");
    assert.equal(worstSeverity([null, undefined]), null);
    assert.equal(worstSeverity([]), null);
  });

  it("counts levels and lists only those present, most severe first", () => {
    const counts = countSeverities(["HIGH", "LOW", "HIGH", "bogus"]);
    assert.equal(counts.HIGH, 2);
    assert.equal(counts.LOW, 1);
    assert.equal(counts.UNKNOWN, 1);
    assert.equal(counts.CRITICAL, 0);
    // UNKNOWN is deliberately excluded from the display order.
    assert.deepEqual(presentSeverities(counts), ["HIGH", "LOW"]);
  });
});

describe("computeReachability", () => {
  const uses = (appSlug: string, versionId: string, dev = false): UsesEdge => ({
    appSlug,
    versionId,
    range: "*",
    dev,
  });
  const depends = (from: string, to: string): DependsOnEdge => ({
    fromVersionId: from,
    toVersionId: to,
    range: "*",
    optional: false,
  });

  it("records a declared dependency at depth 1", () => {
    const reaches = computeReachability([uses("app", "a@1")], []);
    assert.deepEqual(reaches, [{ appSlug: "app", versionId: "a@1", depth: 1 }]);
  });

  it("increments depth along a chain", () => {
    const reaches = computeReachability(
      [uses("app", "a@1")],
      [depends("a@1", "b@1"), depends("b@1", "c@1")],
    );
    const byVersion = new Map(reaches.map((edge) => [edge.versionId, edge.depth]));
    assert.deepEqual([...byVersion], [
      ["a@1", 1],
      ["b@1", 2],
      ["c@1", 3],
    ]);
  });

  it("records the shortest depth when a node is reachable two ways", () => {
    // app -> a -> b -> target, and app -> target directly. Depth 1 must win.
    const reaches = computeReachability(
      [uses("app", "a@1"), uses("app", "target@1")],
      [depends("a@1", "b@1"), depends("b@1", "target@1")],
    );
    const target = reaches.find((edge) => edge.versionId === "target@1");
    assert.equal(target?.depth, 1);
  });

  it("terminates on a cycle", () => {
    const reaches = computeReachability(
      [uses("app", "a@1")],
      [depends("a@1", "b@1"), depends("b@1", "a@1")],
    );
    assert.equal(reaches.length, 2);
  });

  it("excludes dev dependencies and everything below them", () => {
    // npm installs the root project's devDependencies only, so a dev subtree is
    // not part of a production install tree at all.
    const reaches = computeReachability(
      [uses("app", "prod@1"), uses("app", "tooling@1", true)],
      [depends("tooling@1", "tooling-dep@1")],
    );
    assert.deepEqual(reaches.map((edge) => edge.versionId), ["prod@1"]);
  });

  it("keeps applications independent", () => {
    const reaches = computeReachability(
      [uses("one", "a@1"), uses("two", "b@1")],
      [depends("a@1", "shared@1"), depends("b@1", "shared@1")],
    );
    const shared = reaches.filter((edge) => edge.versionId === "shared@1");
    assert.equal(shared.length, 2);
    assert.deepEqual(shared.map((edge) => edge.appSlug).sort(), ["one", "two"]);
  });

  it("returns nothing for an application with only dev dependencies", () => {
    assert.deepEqual(computeReachability([uses("app", "only-dev@1", true)], []), []);
  });
});
