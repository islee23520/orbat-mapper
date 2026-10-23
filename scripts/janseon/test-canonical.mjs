import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";

test("record insertion order does not change canonical bytes or digest", () => {
  const first = { stations: { b: { y: 2, x: 1 }, a: null }, edition: "test" };
  const second = { edition: "test", stations: { a: null, b: { x: 1, y: 2 } } };
  const expected = '{"edition":"test","stations":{"a":null,"b":{"x":1,"y":2}}}';

  assert.equal(canonicalEncode(first), expected);
  assert.equal(canonicalEncode(second), expected);
  assert.equal(semanticDigest(first), semanticDigest(second));
  assert.equal(semanticDigest(first), createHash("sha256").update(expected, "utf8").digest("hex"));
  assert.equal(
    semanticDigest({}),
    "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  );
});

test("keys sort ordinally rather than numerically or by locale", () => {
  const record = { "2": 2, "10": 10, a: 1, Z: 0, "\ue000": 3, "\ud800\udc00": 4 };
  assert.equal(
    canonicalEncode(record),
    '{"10":10,"2":2,"Z":0,"a":1,"\ud800\udc00":4,"\ue000":3}',
  );
});

test("arrays, paths, rings and ordered source entries retain order and duplicates", () => {
  const projection = {
    aliases: ["b", "a", "b", "c"],
    path: [[127, 37], [128, 38]],
    ring: [[0, 0], [1, 0], [1, 1], [0, 0]],
    sourceEntries: [["second", 2], ["first", 1]],
  };
  assert.deepEqual(JSON.parse(canonicalEncode(projection)), projection);
  for (const key of Object.keys(projection)) {
    const reordered = structuredClone(projection);
    reordered[key].reverse();
    assert.notEqual(semanticDigest(reordered), semanticDigest(projection));
  }
});

test("null is present and distinct from missing, false, zero and unknown", () => {
  assert.equal(canonicalEncode({ owner: null }), '{"owner":null}');
  const values = [{}, { owner: null }, { owner: false }, { owner: 0 }, { owner: "unknown" }];
  assert.equal(new Set(values.map(semanticDigest)).size, values.length);
  assert.throws(() => canonicalEncode({ owner: undefined }), TypeError);
  assert.throws(() => canonicalEncode([undefined]), TypeError);
});

test("changed graph edges and exact Unicode IDs change the digest", () => {
  const graph = { stations: ["\uc11c\uc6b8", "\uac00", "\u1100\u1161"], edges: [[0, 1]] };
  const changedEdge = structuredClone(graph);
  changedEdge.edges[0][1] = 2;
  const changedId = structuredClone(graph);
  changedId.stations[1] = "\u1100\u1161";

  assert.deepEqual(JSON.parse(canonicalEncode(graph)), graph);
  assert.notEqual(semanticDigest(graph), semanticDigest(changedEdge));
  assert.notEqual(semanticDigest(graph), semanticDigest(changedId));
  assert.notEqual(semanticDigest({ "\uac00": 1 }), semanticDigest({ "\u1100\u1161": 1 }));
});

test("string escaping preserves exact code units and never normalizes IDs", () => {
  const ids = [" id ", "ID", "id", "\ud800", "\ufffd", 'a"b\\c\n\u0000'];
  assert.deepEqual(JSON.parse(canonicalEncode(ids)), ids);
  assert.equal(new Set(ids.map((id) => semanticDigest({ id }))).size, ids.length);
});

test("finite numbers round-trip without losing negative zero", () => {
  const values = [0, -0, 1.25, Number.MIN_VALUE, Number.MAX_VALUE];
  assert.deepEqual(JSON.parse(canonicalEncode(values)), values);
  assert.notEqual(semanticDigest(-0), semanticDigest(0));
});

test("semantic exclusion is an explicit caller projection, never a field-name filter", () => {
  const semantic = { graph: { edges: [[0, 1]] }, sourceDate: "2013" };
  const first = { semantic, provenance: { databaseSha256: "bytes-a", timestamp: "run-a" } };
  const second = { semantic, provenance: { databaseSha256: "bytes-b", timestamp: "run-b" } };

  assert.equal(semanticDigest(first.semantic), semanticDigest(second.semantic));
  assert.notEqual(semanticDigest(first), semanticDigest(second));
  for (const key of ["timestamp", "provenance", "databaseSha256", "sourceCommit"]) {
    assert.notEqual(semanticDigest({ [key]: "a" }), semanticDigest({ [key]: "b" }));
  }
});

test("encoding does not mutate input or retain mutable references between calls", () => {
  const projection = { path: [[2, 1], [0, 0]], owner: null };
  const original = structuredClone(projection);
  const encoded = canonicalEncode(projection);
  const digest = semanticDigest(projection);
  assert.deepEqual(projection, original);

  projection.path[0][0] = 3;
  projection.owner = "person-a";
  assert.equal(encoded, canonicalEncode(original));
  assert.equal(digest, semanticDigest(original));
  assert.notEqual(encoded, canonicalEncode(projection));
  assert.notEqual(digest, semanticDigest(projection));

  const frozen = Object.freeze({ path: Object.freeze([2, 1]) });
  assert.equal(canonicalEncode(frozen), '{"path":[2,1]}');
});

test("null-prototype records and special property names encode as data", () => {
  const record = Object.create(null);
  record.__proto__ = { id: "a" };
  record.constructor = null;
  record.toJSON = "not a hook";
  assert.equal(
    canonicalEncode(record),
    '{"__proto__":{"id":"a"},"constructor":null,"toJSON":"not a hook"}',
  );
});

test("unsupported primitives, nonfinite numbers and runtime objects fail closed", () => {
  class Entity {}
  const unsupported = [
    undefined, NaN, Infinity, -Infinity, 1n, Symbol("id"), () => 1,
    new Date(0), new Map(), new Set(), new Uint8Array([1]), new Entity(),
    new Number(1), new String("id"), new Boolean(false), /id/,
    Object.create({ inherited: true }),
  ];
  for (const value of unsupported) {
    for (const projection of [value, { value }, [value]]) {
      assert.throws(() => canonicalEncode(projection), TypeError);
      assert.throws(() => semanticDigest(projection), TypeError);
    }
  }
});

test("cycles fail but repeated acyclic values remain valid", () => {
  const record = {};
  record.self = record;
  const array = [];
  array.push(array);
  const mixed = { items: [] };
  mixed.items.push(mixed);
  for (const value of [record, array, mixed]) {
    assert.throws(() => canonicalEncode(value), TypeError);
    assert.throws(() => semanticDigest(value), TypeError);
  }

  const shared = { id: "a" };
  assert.equal(canonicalEncode([shared, shared]), '[{"id":"a"},{"id":"a"}]');
});

test("sparse arrays and non-index array properties cannot silently disappear", () => {
  const extra = [1];
  extra.label = "extra";
  const disguisedHole = Array(1);
  disguisedHole.label = "not index zero";
  const hiddenIndex = [1];
  Object.defineProperty(hiddenIndex, "0", { enumerable: false });
  for (const value of [Array(1), [1, , 3], extra, disguisedHole, hiddenIndex]) {
    assert.throws(() => canonicalEncode(value), TypeError);
  }
});

test("accessors, serialization hooks, symbol and hidden properties are rejected", () => {
  let calls = 0;
  const getter = { get id() { calls++; return "id"; } };
  const arrayGetter = [1];
  Object.defineProperty(arrayGetter, "0", { get() { calls++; return 1; } });
  const hook = { toJSON() { calls++; return {}; } };
  const symbolKey = { [Symbol("id")]: 1 };
  const hidden = Object.defineProperty({}, "id", { value: "hidden" });
  for (const value of [getter, arrayGetter, hook, symbolKey, hidden]) {
    assert.throws(() => canonicalEncode(value), TypeError);
  }
  assert.equal(calls, 0);
});
