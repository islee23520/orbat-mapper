import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { graphSemanticProjection } from "./graph-store.mjs";
import { createReleaseManifest, validateReleaseManifest } from "./release-manifest.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const digest = label => sha("synthetic:" + label);
const ref = label => ({ contentId: "synthetic:" + label, sha256: digest(label) });
const editionRef = domain => ({ domain, datasetId: "synthetic:shared", editionId: "synthetic:one" });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byPath = (a, b) => compare(a.path, b.path);
const byEdition = (a, b) => compare(a.domain, b.domain) || compare(a.datasetId, b.datasetId) || compare(a.editionId, b.editionId);
const member = (path, kind, roles) => {
  const bytes = Buffer.from(JSON.stringify({ synthetic: path }) + "\n");
  return { path, target: path.split("/")[0], kind, sizeBytes: bytes.length, rawSha256: sha(bytes),
    visibility: "public", license: { id: "synthetic-license", textSha256: digest("license") },
    identitySnapshotSha256: digest("identity"), editionRefs: roles.map(editionRef).sort(byEdition) };
};

// Independent serializer for the fixture's JSON values, not the candidate hash API.
function expectedEncoding(value) {
  if (Array.isArray(value)) return "[" + value.map(expectedEncoding).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ":" + expectedEncoding(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

function fixture() {
  const editions = ["graph", "initial-state", "observed-geography"].map(domain => ({ ...editionRef(domain), semanticSha256: digest(domain) }));
  const members = [
    member("wiki/map-core.json", "map-core", ["graph"]),
    member("wiki/observed-geography.json", "observed-geography", ["observed-geography"]),
    member("wiki/spatial-assignments.json", "spatial-assignments", ["initial-state"]),
    member("wiki/station-bindings.json", "station-bindings", ["graph"]),
    member("wiki/underground-geometry.json", "underground-geometry", ["graph"]),
    member("game/world-graph.json", "world-graph", ["graph"]),
    member("game/map-topology.json", "map-topology", ["observed-geography"]),
    member("game/initial-world.json", "initial-world", ["graph", "initial-state"]),
    member("game/terrain-manifest.json", "terrain-manifest", ["observed-geography"]),
  ].sort(byPath);
  const semantic = { schema: "janseon-map-release-semantic.v1", projectionContract: "janseon-map-release-projection.v1",
    mapSemanticSha256: digest("map"), identitySnapshotSha256: digest("identity"), editions,
    domains: { graph: { semanticSha256: digest("graph"), editionRefs: [editionRef("graph")] },
      geometry: { semanticSha256: digest("geometry"), editionRefs: [editionRef("observed-geography")] },
      initialState: { semanticSha256: digest("state"), editionRefs: [editionRef("initial-state")] } },
    targets: ["wiki", "game"], targetAllowlists: { wiki: [], game: [] }, members };
  const provenance = { sourceCommit: "1".repeat(40),
    snapshot: { contentId: "synthetic:snapshot", databaseSha256: digest("database bytes"), mapSemanticSha256: semantic.mapSemanticSha256 },
    exporter: { revision: "2".repeat(40), version: "synthetic-v1" }, identityReceipt: ref("identity-receipt"),
    sourceReceipts: editions.map(value => ({ editionRef: editionRef(value.domain), receipt: ref(value.domain) })),
    approvalReceipts: [], budgetReceipt: ref("budget"), memberLocations: [] };
  const context = { expectedTargets: ["wiki", "game"], budget: { schema: "janseon-map-release-budget.v1",
    migrationReceipt: ref("migration"), members: [], maxTotalBytes: 1 } };
  const result = { input: { semantic, provenance }, context };
  inventories(result);
  return result;
}

// Synthetic measured byte lengths only, not a production budget policy.
function inventories(f) {
  const { semantic: s, provenance: p } = f.input;
  s.members.sort(byPath);
  s.targetAllowlists = Object.fromEntries(["wiki", "game"].map(target => [target, s.members.filter(m => m.target === target).map(m => m.path)]));
  p.approvalReceipts = [{ memberPaths: s.members.map(m => m.path), receipt: ref("approval") }];
  p.memberLocations = s.members.map(m => ({ path: m.path, storage: m.visibility === "protected" ? "protected-content" : "git",
    contentId: m.visibility === "protected" ? "synthetic:member" : null }));
  f.context.budget.members = s.members.map(m => ({ path: m.path, maxBytes: m.sizeBytes }));
  f.context.budget.maxTotalBytes = s.members.reduce((sum, m) => sum + m.sizeBytes, 0);
  bindBudget(f);
}
function bindBudget(f) { f.input.provenance.budgetReceipt.sha256 = sha(expectedEncoding(f.context.budget)); }
const create = f => createReleaseManifest(f.input, f.context);
function rejected(f, code) {
  assert.throws(() => create(f), { code });
  const manifest = { schema: "janseon-map-release.v1", mapReleaseId: digest("unverified R"), deliveryReceiptId: digest("unverified P"), ...f.input };
  assert.throws(() => validateReleaseManifest(manifest, f.context), { code });
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function reverseKeys(value, nullPrototype = false) {
  if (Array.isArray(value)) return value.map(v => reverseKeys(v, nullPrototype));
  if (!value || typeof value !== "object") return value;
  return Object.assign(nullPrototype ? Object.create(null) : {}, Object.fromEntries(Object.entries(value).reverse()
    .map(([key, item]) => [key, reverseKeys(item, nullPrototype)])));
}
function addEdition(f, domain, datasetId = "synthetic:shared", editionId = "synthetic:one") {
  const e = { domain, datasetId, editionId };
  f.input.semantic.editions.push({ ...e, semanticSha256: digest(JSON.stringify(e)) });
  f.input.semantic.editions.sort(byEdition);
  const d = domain === "graph" ? "graph" : domain === "initial-state" ? "initialState" : "geometry";
  f.input.semantic.domains[d].editionRefs.push({ ...e }); f.input.semantic.domains[d].editionRefs.sort(byEdition);
  f.input.provenance.sourceReceipts.push({ editionRef: { ...e }, receipt: ref("extra-edition") });
  f.input.provenance.sourceReceipts.sort((a, b) => byEdition(a.editionRef, b.editionRef));
  return e;
}
function addAsset(f, kind = "terrain") {
  const e = addEdition(f, kind);
  const asset = member(`game/${kind}/tiles/one.bin`, kind, [kind]);
  f.input.semantic.members.push(asset);
  f.input.semantic.members.find(m => m.kind === "terrain-manifest").editionRefs.push(e);
  f.input.semantic.members.find(m => m.kind === "terrain-manifest").editionRefs.sort(byEdition);
  inventories(f);
  return asset;
}

test("complete manifest has independent canonical R/P and detached output", () => {
  const f = fixture(), before = structuredClone(f);
  const semanticBytes = expectedEncoding(f.input.semantic);
  assert.equal(canonicalEncode(f.input.semantic), semanticBytes);
  const mapReleaseId = sha(semanticBytes);
  const preimage = { schema: "janseon-map-release.v1", mapReleaseId, ...f.input };
  const deliveryReceiptId = sha(expectedEncoding(preimage));
  const manifest = create(freeze(f));
  assert.deepEqual(manifest, { ...preimage, deliveryReceiptId });
  assert.deepEqual(validateReleaseManifest(manifest, f.context), { mapReleaseId, deliveryReceiptId });
  assert.deepEqual(f, before);
  assert.notEqual(sha(expectedEncoding(manifest)), deliveryReceiptId);
  const mutable = fixture(), detached = create(mutable), original = structuredClone(detached);
  mutable.input.semantic.members[0].license.id = "changed";
  mutable.input.provenance.approvalReceipts[0].memberPaths.pop();
  mutable.context.budget.members[0].maxBytes++;
  assert.deepEqual(detached, original);
  detached.semantic.members[1].license.id = "result-only";
  assert.equal(mutable.input.semantic.members[1].license.id, "synthetic-license");
});

test("record insertion order and null prototypes do not change identities", () => {
  const f = fixture(), expected = create(f);
  for (const nullPrototype of [false, true]) {
    const changed = reverseKeys(f, nullPrototype);
    assert.deepEqual(create(changed), expected);
    assert.deepEqual(validateReleaseManifest(reverseKeys(expected, nullPrototype), changed.context),
      { mapReleaseId: expected.mapReleaseId, deliveryReceiptId: expected.deliveryReceiptId });
  }
});

test("repacked DB delivery declarations under different S retain R and change P", () => {
  const f = fixture(), first = create(f);
  f.input.provenance.sourceCommit = "3".repeat(40);
  f.input.provenance.snapshot.contentId = "synthetic:repacked";
  f.input.provenance.snapshot.databaseSha256 = digest("repacked bytes");
  const second = create(f);
  assert.equal(first.mapReleaseId, second.mapReleaseId);
  assert.notEqual(first.deliveryReceiptId, second.deliveryReceiptId);
  assert.deepEqual(first.semantic, second.semantic);
  assert.deepEqual(validateReleaseManifest(second, f.context), { mapReleaseId: second.mapReleaseId, deliveryReceiptId: second.deliveryReceiptId });
});

test("each provenance field class changes only P", () => {
  const edits = [
    f => { f.input.provenance.sourceCommit = "3".repeat(40); },
    f => { f.input.provenance.snapshot.contentId = "synthetic:other"; },
    f => { f.input.provenance.snapshot.databaseSha256 = digest("other"); },
    f => { f.input.provenance.exporter.revision = "4".repeat(40); },
    f => { f.input.provenance.exporter.version = "synthetic-v2"; },
    f => { f.input.provenance.identityReceipt = ref("other-identity"); },
    f => { f.input.provenance.sourceReceipts[0].receipt = ref("other-source"); },
    f => { f.input.provenance.approvalReceipts[0].receipt = ref("other-approval"); },
    f => { f.input.provenance.budgetReceipt.contentId = "synthetic:other-budget"; },
    f => { f.input.provenance.memberLocations[0].storage = "git-lfs"; },
    f => { Object.assign(f.input.provenance.memberLocations[0], { storage: "protected-content", contentId: "synthetic:blob" }); },
    f => { f.context.budget.maxTotalBytes++; bindBudget(f); },
    f => { f.context.budget.members[0].maxBytes++; bindBudget(f); },
    f => { f.context.budget.migrationReceipt = ref("other-migration"); bindBudget(f); },
  ];
  const baseline = create(fixture());
  for (const edit of edits) {
    const f = fixture(); edit(f); const changed = create(f);
    assert.equal(changed.mapReleaseId, baseline.mapReleaseId);
    assert.notEqual(changed.deliveryReceiptId, baseline.deliveryReceiptId);
  }
});

test("semantic fields change R and P, with coupled references kept consistent", () => {
  const edits = [
    f => { f.input.semantic.mapSemanticSha256 = f.input.provenance.snapshot.mapSemanticSha256 = digest("map2"); },
    f => { f.input.semantic.identitySnapshotSha256 = digest("identity2"); f.input.semantic.members.forEach(m => { m.identitySnapshotSha256 = digest("identity2"); }); },
    f => { f.input.semantic.editions[0].semanticSha256 = f.input.semantic.domains.graph.semanticSha256 = digest("graph2"); },
    f => { f.input.semantic.editions[2].semanticSha256 = digest("observed2"); },
    f => { f.input.semantic.domains.geometry.semanticSha256 = digest("geometry2"); },
    f => { f.input.semantic.domains.initialState.semanticSha256 = digest("initial2"); },
    f => { f.input.semantic.members[0].rawSha256 = digest("payload2"); },
    f => { f.input.semantic.members[0].sizeBytes++; inventories(f); },
    f => { f.input.semantic.members[0].license.id = "synthetic-other-license"; },
    f => { f.input.semantic.members[0].license.textSha256 = digest("license2"); },
    f => { f.input.semantic.members[0].visibility = "protected"; inventories(f); },
    f => { addAsset(f); },
    f => {
      const old = "synthetic:one", next = "synthetic:two";
      const visit = value => { if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
        if (key === "editionId" && item === old) value[key] = next; else visit(item);
      } }; visit(f.input);
    },
  ];
  const baseline = create(fixture());
  for (const edit of edits) {
    const f = fixture(); edit(f); const changed = create(f);
    assert.notEqual(changed.mapReleaseId, baseline.mapReleaseId);
    assert.notEqual(changed.deliveryReceiptId, baseline.deliveryReceiptId);
  }
  const f = fixture(); const asset = addAsset(f); const first = create(f);
  asset.path = "game/terrain/tiles/two.bin"; inventories(f);
  assert.notEqual(create(f).mapReleaseId, first.mapReleaseId);
});

test("stored R/P tampering rejects without repair", () => {
  const f = fixture();
  for (const key of ["mapReleaseId", "deliveryReceiptId"]) {
    const manifest = create(f); manifest[key] = digest("tampered");
    assert.throws(() => validateReleaseManifest(manifest, f.context), { code: "E_RELEASE_DIGEST" });
    assert.equal(manifest[key], digest("tampered"));
  }
  const manifest = create(f); manifest.provenance.exporter.version = "changed";
  assert.throws(() => validateReleaseManifest(manifest, f.context), { code: "E_RELEASE_DIGEST" });
});

test("every object rejects missing keys and unknown self-grants", () => {
  const f = fixture(), manifest = create(f);
  function objects(value, path = []) {
    if (!value || typeof value !== "object") return [];
    const own = Array.isArray(value) ? [] : [path];
    return [...own, ...Object.entries(value).flatMap(([key, item]) => objects(item, [...path, key]))];
  }
  for (const root of ["manifest", "context"]) {
    const original = { manifest, context: f.context };
    for (const path of objects(original[root])) {
      const at = value => path.reduce((object, key) => object[key], value[root]);
      for (const key of [...Object.keys(at(original)), "approved"]) {
        const copy = structuredClone(original);
        if (key === "approved") at(copy).approved = true; else delete at(copy)[key];
        assert.throws(() => validateReleaseManifest(copy.manifest, copy.context), { code: "E_RELEASE_SHAPE" });
      }
    }
  }
  for (const key of ["mapReleaseId", "deliveryReceiptId", "schema", "allowUnsafe", "production", "authenticated"]) {
    const changed = fixture(); changed.input[key] = true; rejected(changed, "E_RELEASE_SHAPE");
  }
});

test("unsupported primitives and data representations fail before getters run", () => {
  let calls = 0;
  const getter = { get semantic() { calls++; return {}; } };
  const cycle = {}; cycle.self = cycle;
  const hidden = Object.defineProperty({}, "semantic", { value: {} });
  const extraArray = []; extraArray.extra = 1;
  const invalid = [undefined, null, 1, "text", () => {}, new Date(), new Map(), new Set(), new Uint8Array(),
    Object.create({ semantic: {} }), { [Symbol("key")]: 1 }, { toJSON() { calls++; return {}; } }, getter, cycle, hidden, Array(1), extraArray];
  for (const value of invalid) {
    const f = fixture(); f.input.semantic = value; rejected(f, "E_RELEASE_SHAPE");
  }
  const f = fixture(); Object.defineProperty(f.context.budget, "maxTotalBytes", { enumerable: true, get() { calls++; return 1; } });
  rejected(f, "E_RELEASE_SHAPE");
  assert.equal(calls, 0);
});

test("text, hash, commit, opaque reference and supported literal types are exact", () => {
  for (const value of ["", " \t", "a\0b", "a\nb", "a\x7fb", "\ud800", 42, null]) {
    const f = fixture(); f.input.semantic.editions[0].datasetId = value; rejected(f, "E_RELEASE_SHAPE");
  }
  for (const value of ["a".repeat(63), "A".repeat(64), "sha256:" + "a".repeat(64), 0, null]) {
    const f = fixture(); f.input.semantic.mapSemanticSha256 = value; rejected(f, "E_RELEASE_SHAPE");
  }
  for (const value of ["main", "HEAD", "a".repeat(39), "A".repeat(40), "a".repeat(64)]) {
    const f = fixture(); f.input.provenance.sourceCommit = value; rejected(f, "E_RELEASE_SHAPE");
  }
  for (const value of [".", "..", "/root", "a/b", "a\\b", "a%20b", "C:blob", "https://host/blob"]) {
    const f = fixture(); f.input.provenance.identityReceipt.contentId = value; rejected(f, "E_RELEASE_SHAPE");
  }
  for (const edit of [f => { f.input.semantic.schema = "future"; }, f => { f.input.semantic.projectionContract = "future"; },
    f => { f.input.semantic.members[0].kind = "plugin"; }, f => { f.input.semantic.editions[0].domain = "plugin"; },
    f => { f.input.semantic.members[0].target = "mobile"; }, f => { f.input.semantic.members[0].visibility = "approved"; },
    f => { f.input.provenance.memberLocations[0].storage = "http"; }, f => { f.context.budget.schema = "future"; },
    f => { f.input.provenance.memberLocations[0].contentId = "not-null"; }]) {
    const f = fixture(); edit(f); rejected(f, "E_RELEASE_SHAPE");
  }
});

test("unsafe relative paths reject without normalization", () => {
  const paths = ["", "/wiki/map-core.json", "//server/file", "C:/file", "../file", "wiki/../file", "wiki/./file", "wiki//file", "wiki/file/",
    "wiki\\file", "wiki/%2e%2e/file", "wiki/a%2fb", "wiki/a?x", "wiki/a#x", "wiki/a ", "wiki/a\n", "wiki/\u00e9", "Wiki/map-core.json",
    "wiki/a.", "wiki/con", "wiki/con.json", "wiki/prn.txt", "wiki/aux", "wiki/nul", "wiki/com1.bin", "wiki/lpt9.txt", "release-manifest.json"];
  for (const path of paths) {
    const f = fixture(); f.input.semantic.members[0].path = path; rejected(f, "E_RELEASE_PATH");
  }
  for (const kind of ["terrain", "roads", "buildings"]) {
    const f = fixture(); addAsset(f, kind); assert.doesNotThrow(() => create(f));
  }
});

test("each fixed member is mandatory even when every inventory agrees on its removal", () => {
  for (let index = 0; index < 9; index++) {
    const f = fixture(); f.input.semantic.members.splice(index, 1); inventories(f); rejected(f, "E_RELEASE_REFERENCE");
  }
  for (const path of ["wiki/other.json", "assets/terrain.bin", "game/data.sqlite", "game/receipt.json"]) {
    const f = fixture(), extra = member(path, "terrain", ["observed-geography"]);
    extra.target = path.startsWith("wiki/") ? "wiki" : "game";
    f.input.semantic.members.push(extra); inventories(f);
    rejected(f, "E_RELEASE_REFERENCE");
  }
});

test("target order, member kind, visibility and identity cannot contradict the release", () => {
  const edits = [
    f => { f.input.semantic.targets = ["wiki"]; }, f => { f.context.expectedTargets = ["wiki"]; },
    f => { f.input.semantic.targets.reverse(); }, f => { f.context.expectedTargets = ["wiki", "wiki"]; },
    f => { f.input.semantic.members[0].target = "wiki"; }, f => { f.input.semantic.members[0].kind = "map-core"; },
    f => { f.input.semantic.members.find(m => m.target === "wiki").visibility = "protected"; },
    f => { f.input.semantic.members[0].visibility = "protected"; },
    f => { f.input.semantic.members[0].identitySnapshotSha256 = digest("other-identity"); },
    f => { f.input.provenance.snapshot.mapSemanticSha256 = digest("other-map"); },
    f => { f.input.semantic.domains.graph.semanticSha256 = digest("other-graph"); },
  ];
  for (const edit of edits) { const f = fixture(); edit(f); rejected(f, "E_RELEASE_REFERENCE"); }
});

test("inventories reject duplicates, reversed order and missing or extra coverage", () => {
  const selectors = [
    f => f.input.semantic.members, f => f.input.semantic.editions, f => f.input.semantic.targetAllowlists.wiki,
    f => f.input.provenance.sourceReceipts, f => f.input.provenance.approvalReceipts[0].memberPaths,
    f => f.input.provenance.memberLocations, f => f.context.budget.members,
    f => f.input.semantic.members.find(m => m.kind === "initial-world").editionRefs,
  ];
  for (const select of selectors) for (const operation of [a => a.push(structuredClone(a[0])), a => a.reverse(), a => a.pop()]) {
    const f = fixture(); operation(select(f)); rejected(f, "E_RELEASE_REFERENCE");
  }
  for (const edit of [
    f => { f.input.provenance.approvalReceipts.push(structuredClone(f.input.provenance.approvalReceipts[0])); },
    f => { f.input.provenance.approvalReceipts[0].memberPaths = []; },
    f => { f.input.provenance.approvalReceipts[0].memberPaths.push("wiki/extra.json"); },
    f => { f.input.semantic.domains.graph.editionRefs.push(editionRef("graph")); },
    f => { f.input.semantic.editions.push({ ...f.input.semantic.editions[0], editionId: "synthetic:two" }); f.input.semantic.editions.sort(byEdition); },
    f => { f.input.semantic.domains.geometry.editionRefs = []; },
    f => { f.input.semantic.members[0].editionRefs = []; },
    f => { f.input.semantic.domains.geometry.editionRefs = [editionRef("graph")]; },
  ]) { const f = fixture(); edit(f); rejected(f, "E_RELEASE_REFERENCE"); }
  const f = fixture(), paths = f.input.semantic.members.map(m => m.path);
  f.input.provenance.approvalReceipts = [{ memberPaths: paths.slice(0, 4), receipt: ref("first") }, { memberPaths: paths.slice(4), receipt: ref("second") }];
  assert.doesNotThrow(() => create(f));
  f.input.provenance.approvalReceipts.reverse(); rejected(f, "E_RELEASE_REFERENCE");
});

test("edition namespace and full graph/state reference closure are enforced", () => {
  for (const edit of [
    f => { f.input.semantic.members[0].editionRefs[0].editionId = "synthetic:other"; },
    f => { f.input.semantic.members[0].editionRefs[0].datasetId = "synthetic:other"; },
    f => { f.input.semantic.members.find(m => m.kind === "world-graph").editionRefs.push(editionRef("initial-state")); },
    f => { f.input.semantic.members.find(m => m.kind === "initial-world").editionRefs.shift(); },
    f => { f.input.semantic.members.find(m => m.kind === "observed-geography").editionRefs = [editionRef("initial-state")]; },
    f => { addEdition(f, "legacy-atlas"); },
    f => { f.input.semantic.editions.push({ ...editionRef("terrain"), semanticSha256: digest("unused") }); },
  ]) { const f = fixture(); edit(f); rejected(f, "E_RELEASE_REFERENCE"); }
  const f = fixture(); const e = addEdition(f, "graph", "synthetic:second-graph");
  const world = f.input.semantic.members.find(m => m.kind === "world-graph");
  world.editionRefs.push(e); world.editionRefs.sort(byEdition);
  rejected(f, "E_RELEASE_REFERENCE"); // Initial world has not included the second graph.
  const initial = f.input.semantic.members.find(m => m.kind === "initial-world");
  initial.editionRefs.push(e); initial.editionRefs.sort(byEdition);
  assert.doesNotThrow(() => create(f));
});

test("distinct atlas/SGIS roles and Unicode identities remain distinct", () => {
  const f = fixture();
  const atlas = addEdition(f, "legacy-atlas");
  const topology = f.input.semantic.members.find(m => m.kind === "map-topology");
  topology.editionRefs.push(atlas); topology.editionRefs.sort(byEdition);
  assert.doesNotThrow(() => create(f));
  for (const datasetId of ["synthetic:\u00e9", "synthetic:e\u0301", "synthetic:a|b", "synthetic:a"]) {
    const e = addEdition(f, "legacy-atlas", datasetId, datasetId.endsWith("a") ? "b|c" : "c");
    topology.editionRefs.push(e); topology.editionRefs.sort(byEdition);
  }
  const first = create(f);
  assert.equal(f.input.semantic.editions.filter(e => e.domain === "legacy-atlas").length, 5);
  topology.editionRefs[0].editionId = "undeclared";
  rejected(f, "E_RELEASE_REFERENCE");
  const g = fixture();
  g.input.semantic.members[0].license.id = "\u00e9"; const composed = create(g);
  g.input.semantic.members[0].license.id = "e\u0301";
  assert.notEqual(create(g).mapReleaseId, composed.mapReleaseId);
  assert.equal(typeof first.mapReleaseId, "string");
});

test("numeric leaves reject coercion, fractions, unsafe values and negative zero", () => {
  for (const invalid of [0, -0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1", 1n, null, undefined]) {
    for (const set of [f => { f.input.semantic.members[0].sizeBytes = invalid; },
      f => { f.context.budget.members[0].maxBytes = invalid; }, f => { f.context.budget.maxTotalBytes = invalid; }]) {
      const f = fixture(); set(f); rejected(f, "E_RELEASE_SHAPE");
    }
  }
  const f = fixture();
  f.input.semantic.members[0].sizeBytes = Number.MAX_SAFE_INTEGER;
  f.context.budget.members[0].maxBytes = Number.MAX_SAFE_INTEGER;
  f.context.budget.maxTotalBytes = Number.MAX_SAFE_INTEGER; bindBudget(f);
  rejected(f, "E_RELEASE_BUDGET");
});

test("independent budget caps and canonical binding are mandatory", () => {
  const f = fixture(); assert.doesNotThrow(() => create(f)); // Exact measured boundary.
  for (const edit of [
    g => { g.input.semantic.members[0].sizeBytes++; },
    g => { g.context.budget.maxTotalBytes--; bindBudget(g); },
    g => { g.context.budget.members[0].maxBytes--; bindBudget(g); },
    g => { g.context.budget.maxTotalBytes++; },
    g => { g.input.provenance.budgetReceipt.sha256 = sha(JSON.stringify(g.context.budget, null, 2)); },
  ]) { const g = fixture(); edit(g); rejected(g, "E_RELEASE_BUDGET"); }
  delete f.context.budget; rejected(f, "E_RELEASE_SHAPE");
});

test("error category precedence is shape then path then references then budget then digest", () => {
  const f = fixture(); f.input.semantic.members[0].path = "../bad";
  f.input.semantic.members[1].sizeBytes = -1; rejected(f, "E_RELEASE_SHAPE");
  f.input.semantic.members[1].sizeBytes = 1; rejected(f, "E_RELEASE_PATH");
  f.input.semantic.members[0].path = "game/unknown.json"; rejected(f, "E_RELEASE_REFERENCE");
  const g = fixture(), manifest = create(g); manifest.mapReleaseId = digest("bad");
  g.context.budget.maxTotalBytes++;
  assert.throws(() => validateReleaseManifest(manifest, g.context), { code: "E_RELEASE_BUDGET" });
});

test("consistent forged declarations are structural success, never source or rights admission", () => {
  const f = fixture();
  f.input.semantic.members[0].rawSha256 = digest("forged-payload");
  f.input.provenance.approvalReceipts[0].receipt = ref("self-written-receipt");
  const manifest = create(f), result = validateReleaseManifest(manifest, f.context);
  assert.deepEqual(Object.keys(result).sort(), ["deliveryReceiptId", "mapReleaseId"]);
  assert.deepEqual(result, { mapReleaseId: manifest.mapReleaseId, deliveryReceiptId: manifest.deliveryReceiptId });
});

test("original graph source dates, hashes, WikiCommit and exclusion presence stay semantic", () => {
  const document = { schema: "seoul-world-graph-v2", districts: ["synthetic"], stations: [], edges: [], aliases: {},
    source: { original: "synthetic", railAdjacency: { revision: "synthetic", WikiCommit: "historical-synthetic",
      officialSource: { url: "https://example.invalid", retrievedAt: "2013-01-01", sha256: digest("original-source"), scope: "synthetic" },
      replacements: [], excluded: [{ reason: null }], hubIdentities: [] } } };
  const project = doc => graphSemanticProjection({ datasetId: "synthetic:shared", editionId: "synthetic:one", document: doc });
  const apply = doc => {
    const f = fixture(), graph = project(doc);
    f.input.semantic.editions[0].semanticSha256 = f.input.semantic.domains.graph.semanticSha256 = semanticDigest(graph);
    f.input.semantic.mapSemanticSha256 = f.input.provenance.snapshot.mapSemanticSha256 = semanticDigest({ graph, syntheticInitialState: null });
    return f;
  };
  const original = create(apply(document));
  for (const edit of [
    d => { d.source.railAdjacency.officialSource.retrievedAt = "2014-01-01"; },
    d => { d.source.railAdjacency.officialSource.sha256 = digest("other-original"); },
    d => { d.source.railAdjacency.WikiCommit = "other-historical-synthetic"; },
    d => { d.source.railAdjacency.excluded[0].reason = "original-evidence"; },
    d => { delete d.source.railAdjacency.excluded[0].reason; },
    d => { d.edges = [{ a: "synthetic:a", b: "synthetic:b" }]; },
  ]) {
    const changed = structuredClone(document); edit(changed);
    assert.notEqual(semanticDigest(project(changed)), semanticDigest(project(document)));
    assert.notEqual(create(apply(changed)).mapReleaseId, original.mapReleaseId);
  }
  const f = apply(document); f.input.provenance.sourceReceipts[0].receipt = ref("changed-import-actor-reason-receipt");
  assert.equal(create(f).mapReleaseId, original.mapReleaseId);
  assert.notEqual(create(f).deliveryReceiptId, original.deliveryReceiptId);
});
