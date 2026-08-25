"use strict";

const assert = require("assert");
const ViewWindow = require("../lib/view-window");

function run() {
  const source = Array.from({ length: 125 }, (_unused, index) => index + 1);

  const first = ViewWindow.page(source, 0, 50);
  assert.deepStrictEqual(first.items, source.slice(0, 50));
  assert.deepStrictEqual(
    { total: first.total, pageIndex: first.pageIndex, pageCount: first.pageCount, start: first.start, end: first.end },
    { total: 125, pageIndex: 0, pageCount: 3, start: 1, end: 50 }
  );
  assert.strictEqual(first.hasPrevious, false);
  assert.strictEqual(first.hasNext, true);

  const last = ViewWindow.page(source, 99, 50);
  assert.deepStrictEqual(last.items, source.slice(100));
  assert.strictEqual(last.pageIndex, 2);
  assert.strictEqual(last.start, 101);
  assert.strictEqual(last.end, 125);
  assert.strictEqual(last.hasNext, false);

  const empty = ViewWindow.page([], -1, 0);
  assert.deepStrictEqual(empty.items, []);
  assert.strictEqual(empty.start, 0);
  assert.strictEqual(empty.end, 0);
  assert.strictEqual(empty.pageCount, 1);

  const tail = ViewWindow.tail(source, 20);
  assert.deepStrictEqual(tail.items, source.slice(105));
  assert.strictEqual(tail.total, 125);
  assert.strictEqual(tail.omitted, 105);

  console.log("view-window: OK");
}

run();
