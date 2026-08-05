import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { categoriseLicense } from "../scripts/lib/registry";

/**
 * SPDX expressions have to be decomposed rather than pattern-matched, and both
 * operators mean opposite things: OR is a choice, so the least restrictive operand
 * governs, while AND binds every operand at once.
 */
describe("categoriseLicense", () => {
  const cases: Array<[string, string]> = [
    ["MIT", "permissive"],
    ["Apache-2.0", "permissive"],
    ["BSD-3-Clause", "permissive"],
    ["ISC", "permissive"],
    ["CC0-1.0", "permissive"],
    // Attribution only, no source obligation.
    ["CC-BY-4.0", "permissive"],
    ["LGPL-2.1", "weak-copyleft"],
    ["MPL-2.0", "weak-copyleft"],
    ["GPL-2.0", "copyleft"],
    ["GPL-3.0-only", "copyleft"],
    ["AGPL-3.0", "network-copyleft"],
    ["UNLICENSED", "proprietary"],
    ["UNKNOWN", "unknown"],
    ["SEE LICENSE IN LICENSE.md", "unknown"],
  ];

  for (const [input, expected] of cases) {
    it(`categorises ${input} as ${expected}`, () => {
      assert.equal(categoriseLicense(input), expected);
    });
  }

  it("takes the permissive side of an OR expression", () => {
    // The licensee may choose BSD and incur no copyleft obligation, so reporting
    // this as copyleft is a false positive in the expensive direction.
    assert.equal(categoriseLicense("(BSD-3-Clause OR GPL-2.0)"), "permissive");
    assert.equal(categoriseLicense("(MIT OR Apache-2.0)"), "permissive");
  });

  it("takes the most restrictive side of an AND expression", () => {
    assert.equal(categoriseLicense("MIT AND GPL-3.0"), "copyleft");
    assert.equal(categoriseLicense("Apache-2.0 AND LGPL-3.0-or-later"), "weak-copyleft");
    assert.equal(categoriseLicense("Apache-2.0 AND LGPL-3.0-or-later AND MIT"), "weak-copyleft");
  });

  it("does not treat a version suffix as an operator", () => {
    // A hyphen is a word boundary, so a \bOR\b pattern matches the "or" inside
    // "-or-later" and shreds the identifier. Operators are whitespace-delimited.
    assert.equal(categoriseLicense("LGPL-3.0-or-later"), "weak-copyleft");
    assert.equal(categoriseLicense("GPL-3.0-or-later"), "copyleft");
    assert.equal(categoriseLicense("AGPL-3.0-or-later"), "network-copyleft");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    assert.equal(categoriseLicense("  mit  "), "permissive");
    assert.equal(categoriseLicense("agpl-3.0"), "network-copyleft");
  });
});
