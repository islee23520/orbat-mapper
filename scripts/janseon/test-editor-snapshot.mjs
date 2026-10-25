import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, command } from "./command-store-fixture.mjs";
import { acceptCommandPackage, readCommandEditorSource } from "./command-store.mjs";
import { semanticDigest } from "./canonical.mjs";
import { exportEditorSnapshot, verifyEditorSnapshot } from "./export-editor-snapshot.mjs";
const hash = b => createHash("sha256").update(b).digest("hex");
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "editor-snapshot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "central.sqlite"), f = fixture(t, databasePath);
  const source = readCommandEditorSource(f.db, f.binding);
  return { ...f, request: { databasePath, binding: f.binding,
    expectedHead: { datasetId: source.authored.datasetId, editionId: source.authored.editionId,
      generationId: source.head.generation_id, sequence: source.head.sequence,
      mapSemanticSha256: source.head.map_semantic_sha256, identitySnapshotSha256: source.identitySnapshotSha256 } } };
}
function corrupt(db, sql) {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
  for (const row of triggers) db.exec('DROP TRIGGER "' + row.name + '"');
  try { db.exec(sql); } finally { for (const row of triggers) db.exec(row.sql); }
}
test("two readonly exports are identical, complete, source ordered and do not change store bytes", t => {
  const f = setup(t), before = readFileSync(f.request.databasePath);
  const a = exportEditorSnapshot(f.request), b = exportEditorSnapshot(f.request);
  assert.deepEqual(a, b); assert.deepEqual(readFileSync(f.request.databasePath), before);
  assert.equal(a.descriptor.readonly, true); assert.equal(a.descriptor.head.sequence, 0);
  assert.deepEqual(Object.keys(a.files).sort(), ["edition.json", "references/authored.json", "references/central.json"]);
  const central = JSON.parse(a.files["references/central.json"]), authored = JSON.parse(a.files["references/authored.json"]);
  assert.equal(central.graph.document.stations.length, 2); assert.equal(central.graph.document.edges.length, 1);
  assert.equal(central.observedGeography.geometry.features.length, 4);
  assert.ok(central.observedGeography.rows.boundary_geometry_point.length > 0);
  assert.equal(authored.entities.length, 1); assert.equal(authored.assignments.length, 1);
  const source = readCommandEditorSource(f.db, f.binding);
  assert.deepEqual(central, source.central); assert.deepEqual(authored, source.authored);
  for (const member of a.descriptor.members) {
    assert.equal(member.rawSha256, hash(a.files[member.path]));
    assert.equal(member.sizeBytes, a.files[member.path].length);
    assert.equal(member.semanticSha256, semanticDigest(JSON.parse(a.files[member.path])));
  }
  assert.deepEqual(verifyEditorSnapshot(a, f.request), { generationId: f.request.expectedHead.generationId,
    editionId: f.request.expectedHead.editionId });
});
test("new accepted head invalidates stale request; refreshed pins include exact sequence and null assignment", t => {
  const f = setup(t); acceptCommandPackage(f.db, command(f.db, f.binding, "change"));
  assert.throws(() => exportEditorSnapshot(f.request), { code: "E_EDITOR_STALE_HEAD" });
  const s = readCommandEditorSource(f.db, f.binding);
  Object.assign(f.request.expectedHead, { generationId: s.head.generation_id, sequence: 1,
    editionId: s.authored.editionId, mapSemanticSha256: s.head.map_semantic_sha256 });
  const a = exportEditorSnapshot(f.request);
  assert.equal(a.descriptor.head.sequence, 1);
  assert.equal(JSON.parse(a.files["references/authored.json"]).assignments[0].valueRef, null);
});
test("mixed edition and identity requests reject rather than choosing another dataset", t => {
  const f = setup(t), mixed = structuredClone(f.request);
  mixed.binding.central.observedGeography.editionId = "other-edition";
  assert.throws(() => exportEditorSnapshot(mixed));
  const identity = structuredClone(f.request); identity.expectedHead.identitySnapshotSha256 = "f".repeat(64);
  assert.throws(() => exportEditorSnapshot(identity), { code: "E_EDITOR_STALE_HEAD" });
  const missing = structuredClone(f.request); delete missing.expectedHead.sequence;
  assert.throws(() => exportEditorSnapshot(missing), { code: "E_EDITOR_HEAD_SHAPE" });
});
test("missing, tampered and rehashed exported members reject against actual store", t => {
  const f = setup(t), a = exportEditorSnapshot(f.request);
  delete a.files["references/authored.json"];
  assert.throws(() => verifyEditorSnapshot(a, f.request), { code: "E_EDITOR_SNAPSHOT_MEMBER" });
  const forged = exportEditorSnapshot(f.request);
  forged.files["references/authored.json"] = Buffer.from('{}\n');
  const member = forged.descriptor.members.find(m => m.path === "references/authored.json");
  Object.assign(member, { rawSha256: hash(forged.files[member.path]), sizeBytes: forged.files[member.path].length, semanticSha256: semanticDigest({}) });
  assert.throws(() => verifyEditorSnapshot(forged, f.request), { code: "E_EDITOR_SNAPSHOT_MEMBER" });
});
test("tampered typed graph and corrupted ledger head fail with restored exact schema", t => {
  const graph = setup(t);
  corrupt(graph.db, "UPDATE map_graph_station SET lat=lat+1");
  assert.throws(() => exportEditorSnapshot(graph.request));
  const head = setup(t);
  corrupt(head.db, "UPDATE map_command_head SET sequence=2");
  assert.throws(() => exportEditorSnapshot(head.request), { code: "E_COMMAND_STORE_REPLAY" });
});
