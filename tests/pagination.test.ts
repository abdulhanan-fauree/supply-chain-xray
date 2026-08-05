import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { paginate } from "../src/components/pagination";

const items = Array.from({ length: 107 }, (_, index) => index + 1);

describe("paginate", () => {
  it("returns the first page by default", () => {
    const page = paginate(items, undefined, 25);
    assert.equal(page.pageNumber, 1);
    assert.equal(page.pageCount, 5);
    assert.deepEqual(page.items.slice(0, 3), [1, 2, 3]);
    assert.equal(page.firstIndex, 1);
    assert.equal(page.lastIndex, 25);
  });

  it("slices an interior page", () => {
    const page = paginate(items, "2", 25);
    assert.equal(page.items[0], 26);
    assert.equal(page.firstIndex, 26);
    assert.equal(page.lastIndex, 50);
  });

  it("returns a partial final page", () => {
    const page = paginate(items, "5", 25);
    assert.equal(page.items.length, 7);
    assert.equal(page.firstIndex, 101);
    assert.equal(page.lastIndex, 107);
  });

  // A hand-edited or stale URL should render a real page, not an error or a blank
  // list, so every out-of-range input clamps into the valid interval.
  it("clamps a page number above the last page", () => {
    assert.equal(paginate(items, "999", 25).pageNumber, 5);
  });

  it("clamps zero and negative page numbers to the first page", () => {
    assert.equal(paginate(items, "0", 25).pageNumber, 1);
    assert.equal(paginate(items, "-3", 25).pageNumber, 1);
  });

  it("falls back to the first page for non-numeric input", () => {
    assert.equal(paginate(items, "banana", 25).pageNumber, 1);
    assert.equal(paginate(items, "", 25).pageNumber, 1);
  });

  it("reports one page and zero indices for an empty result set", () => {
    const page = paginate([], "3", 25);
    assert.equal(page.pageCount, 1);
    assert.equal(page.total, 0);
    assert.equal(page.firstIndex, 0);
    assert.equal(page.lastIndex, 0);
    assert.deepEqual(page.items, []);
  });

  it("handles a result set smaller than one page", () => {
    const page = paginate([1, 2, 3], undefined, 25);
    assert.equal(page.pageCount, 1);
    assert.equal(page.lastIndex, 3);
  });

  it("handles an exact multiple of the page size", () => {
    const page = paginate(Array.from({ length: 50 }, (_, i) => i), "2", 25);
    assert.equal(page.pageCount, 2);
    assert.equal(page.items.length, 25);
    assert.equal(page.lastIndex, 50);
  });
});
