import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./command-store-fixture.mjs";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { readCommandReleaseSource } from "./command-store.mjs";
import { buildMapRelease, verifyBuiltMapRelease } from "./build-map-release.mjs";
import { createReleaseManifest } from "./release-manifest.mjs";
const H = c => c.repeat(64), sha = value => createHash("sha256").update(value).digest("hex");
const paths = ["game/initial-world.json", "game/map-topology.json", "game/terrain-manifest.json", "game/world-graph.json",
  "wiki/map-core.json", "wiki/observed-geography.json", "wiki/spatial-assignments.json", "wiki/station-bindings.json", "wiki/underground-geometry.json"];
function request(t) {
  const directory = mkdtempSync(join(tmpdir(), "release-builder-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "source.sqlite"), f = fixture(t, databasePath);
  const source = readCommandReleaseSource(f.db, f.binding);
  const ref = (domain, value) => ({ domain, datasetId: value.datasetId, editionId: value.editionId });
  const sourceRows = [{ editionRef: ref("graph", source.central.graph), rowsSha256: semanticDigest(source.central.graph.document) },
    { editionRef: ref("initial-state", source.authored), rowsSha256: semanticDigest(source.authored) },
    { editionRef: ref("observed-geography", source.central.observedGeography), rowsSha256: semanticDigest(source.central.observedGeography.rows) }];
  const receipt = { contentId: "synthetic-receipt", sha256: H("a") };
  const budget = { schema: "janseon-map-release-budget.v1", migrationReceipt: receipt,
    members: paths.map(path => ({ path, maxBytes: 1000000 })), maxTotalBytes: 9000000 };
  const provenance = { sourceCommit: "1".repeat(40), snapshot: { contentId: "synthetic-snapshot",
    databaseSha256: sha(readFileSync(databasePath)), mapSemanticSha256: semanticDigest({ schema: "janseon-release-map.v1", central: source.central.centralSemanticSha256, authored: source.authored.semanticSha256 }) },
    exporter: { revision: "2".repeat(40), version: "synthetic-builder-v1" }, identityReceipt: receipt,
    sourceReceipts: sourceRows.map(row => ({ editionRef: row.editionRef, receipt: { contentId: row.editionRef.domain, sha256: row.rowsSha256 } })),
    approvalReceipts: [{ memberPaths: paths, receipt }], budgetReceipt: { contentId: "synthetic-budget", sha256: semanticDigest(budget) },
    memberLocations: paths.map(path => ({ path, storage: "git", contentId: null })) };
  return { databasePath, binding: f.binding, provenance, context: { expectedTargets: ["wiki", "game"], budget },
    license: { id: "synthetic", textSha256: H("b") }, sourceRows };
}
test("two complete typed builds are byte identical with independent R/P and source-row receipts", t => {
  const r = request(t), a = buildMapRelease(r), b = buildMapRelease(r);
  assert.deepEqual(Object.keys(a.members), paths); assert.equal(Object.keys(a.members).length, 9);
  assert.deepEqual(a.manifestBytes, b.manifestBytes);
  for (const path of paths) assert.deepEqual(a.members[path], b.members[path]);
  assert.equal(a.manifest.mapReleaseId, semanticDigest(a.manifest.semantic));
  const { deliveryReceiptId, ...withoutSelf } = a.manifest;
  assert.equal(deliveryReceiptId, semanticDigest(withoutSelf));
  assert.equal(a.sourceReceipt.memberOrigins.length, 9);
  assert.equal(JSON.parse(a.members["game/world-graph.json"]).stations.length, 2);
  assert.equal(JSON.parse(a.members["wiki/observed-geography.json"]).data.features.length, 4);
  assert.equal(JSON.parse(a.members["wiki/spatial-assignments.json"]).data.length, 1);
  assert.deepEqual(verifyBuiltMapRelease(a, r), { mapReleaseId: a.manifest.mapReleaseId, deliveryReceiptId: a.manifest.deliveryReceiptId });
});
test("provenance-only source revision changes P but not payload bytes or R", t => {
  const r = request(t), a = buildMapRelease(r); r.provenance.sourceCommit = "3".repeat(40);
  const b = buildMapRelease(r);
  assert.equal(a.manifest.mapReleaseId, b.manifest.mapReleaseId);
  assert.notEqual(a.manifest.deliveryReceiptId, b.manifest.deliveryReceiptId);
  assert.deepEqual(a.members, b.members);
});
test("missing member and rehashed payload forgery reject against actual typed source", t => {
  const r = request(t), a = buildMapRelease(r);
  delete a.members["wiki/map-core.json"];
  assert.throws(() => verifyBuiltMapRelease(a, r), { code: "E_BUILD_RELEASE" });
  const forged = buildMapRelease(r), path = "game/world-graph.json";
  forged.members[path] = Buffer.from('{"forged":true}\n');
  const member = forged.manifest.semantic.members.find(row => row.path === path);
  member.rawSha256 = sha(forged.members[path]); member.sizeBytes = forged.members[path].length;
  forged.manifest = createReleaseManifest({ semantic: forged.manifest.semantic, provenance: forged.manifest.provenance }, r.context);
  forged.manifestBytes = Buffer.from(canonicalEncode(forged.manifest) + "\n");
  assert.throws(() => verifyBuiltMapRelease(forged, r), { code: "E_BUILD_RELEASE" });
});
test("mixed editions tampered source bytes or row bindings and incomplete provenance reject", t => {
  { const r = request(t); r.binding.central.graph.editionId = "mixed"; assert.throws(() => buildMapRelease(r)); }
  { const r = request(t); r.provenance.snapshot.databaseSha256 = H("f"); assert.throws(() => buildMapRelease(r), { code: "E_BUILD_SOURCE_BYTES" }); }
  { const r = request(t); r.sourceRows[0].rowsSha256 = H("f"); assert.throws(() => buildMapRelease(r), { code: "E_BUILD_SOURCE_ROWS" }); }
  { const r = request(t); delete r.provenance.identityReceipt; assert.throws(() => buildMapRelease(r), { code: "E_RELEASE_SHAPE" }); }
  { const r = request(t); r.provenance.sourceReceipts.pop(); assert.throws(() => buildMapRelease(r), { code: "E_BUILD_SOURCE_RECEIPT" }); }
  { const r = request(t); r.provenance.sourceReceipts[0].receipt.sha256 = H("f"); assert.throws(() => buildMapRelease(r), { code: "E_BUILD_SOURCE_RECEIPT" }); }
});
test("WAL source requires an explicit checkpointed snapshot instead of hashing only database pages", t => {
  const r = request(t), db = new DatabaseSync(r.databasePath);
  try { db.exec("PRAGMA journal_mode=WAL"); } finally { db.close(); }
  r.provenance.snapshot.databaseSha256 = sha(readFileSync(r.databasePath));
  assert.throws(() => buildMapRelease(r), { code: "E_BUILD_CHECKPOINT_REQUIRED" });
});
