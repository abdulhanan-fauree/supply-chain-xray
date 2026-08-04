/**
 * Truth table for the SPDX expression categoriser.
 *
 * Every case here is a real license string that appeared in the crawled data or
 * a near neighbour of one. Two of them are regression tests for bugs this file
 * caught: "(BSD-3-Clause OR GPL-2.0)" was reported as copyleft when an OR
 * expression means the permissive side may simply be chosen, and
 * "LGPL-3.0-or-later" was shredded into nonsense because a hyphen counts as a
 * word boundary, so \bOR\b matched the "or" inside the version suffix.
 *
 * Run:  npm run check:licenses
 */

import { categoriseLicense } from "../lib/registry";
const cases: Array<[string, string]> = [
  ["MIT", "permissive"],
  ["Apache-2.0", "permissive"],
  ["CC-BY-4.0", "permissive"],
  ["CC0-1.0", "permissive"],
  ["(BSD-3-Clause OR GPL-2.0)", "permissive"],
  ["(MIT OR Apache-2.0)", "permissive"],
  ["LGPL-3.0-or-later", "weak-copyleft"],
  ["LGPL-2.1", "weak-copyleft"],
  ["MPL-2.0", "weak-copyleft"],
  ["Apache-2.0 AND LGPL-3.0-or-later", "weak-copyleft"],
  ["Apache-2.0 AND LGPL-3.0-or-later AND MIT", "weak-copyleft"],
  ["GPL-3.0-only", "copyleft"],
  ["GPL-2.0", "copyleft"],
  ["AGPL-3.0", "network-copyleft"],
  ["MIT AND GPL-3.0", "copyleft"],
  ["UNLICENSED", "proprietary"],
  ["UNKNOWN", "unknown"],
  ["SEE LICENSE IN LICENSE.md", "unknown"],
];
let bad = 0;
for (const [input, expected] of cases) {
  const actual = categoriseLicense(input);
  const ok = actual === expected;
  if (!ok) bad += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${input.padEnd(42)} -> ${actual}${ok ? "" : ` (expected ${expected})`}`);
}
console.log(bad ? `\n  ${bad} case(s) wrong\n` : "\n  all license expressions categorise correctly\n");
process.exit(bad ? 1 : 0);
