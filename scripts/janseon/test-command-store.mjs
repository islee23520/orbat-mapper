import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { centralInputs } from "./central-store-fixture.mjs";
import { importCentralEditions, readCentralSnapshot } from "./central-store.mjs";
import { initializeCommandStore, initializeCommandHead, acceptCommandPackage,
  readCommandEdition, exportCommandLog, replayCommandLog } from "./command-store.mjs";

const MODE = "janseon-command-store.v1", H = c => c.repeat(64);
const person = { datasetId: "synthetic:identity", editionId: "i1", entityKind: "person", sourceId: "person-a" };
const station = id => ({ datasetId: "synthetic:shared", editionId: "one", entityKind: "graph-station", sourceId: id });
function fixture(t, path = ":memory:") {
  const db = new DatabaseSync(path); t.after(() => { if (db.isOpen) db.close(); });
  initializeCommandStore(db);
  const input = centralInputs(); importCentralEditions(db, input, MODE);
  const central = Object.fromEntries(Object.entries(input).map(([kind, value]) => [kind, {
    datasetId: value.expectedBinding.dataset_id, editionId: value.expectedBinding.edition_id, expectedBinding: value.expectedBinding }]));
  const snapshot = readCentralSnapshot(db, central, MODE);
  const authored = { schema: "janseon-authored-edition.v1", datasetId: "synthetic:author", editionId: "baseline",
    baseCentralSemanticSha256: snapshot.centralSemanticSha256, identitySnapshotSha256: H("1"),
    entities: [{ ref: { datasetId: "synthetic:author", editionId: "baseline", entityKind: "authored-facility", sourceId: "facility-a" },
      geographicParentRef: null, location: { crs: "OGC:CRS84", coordinates: [127, 37] }, footprint: null }],
    geometries: [], edgeChanges: [], crosswalkChanges: [], assignments: [{ kind: "placement", subjectRef: person, valueRef: station("é") }], tombstones: [] };
  authored.semanticSha256 = semanticDigest(authored);
  const binding = { central, context: { schema: "janseon-authoring-context.v1", generationId: H("2"), mapSemanticSha256: H("3"),
    identitySnapshotSha256: H("1"), central: snapshot, authored, baseline: structuredClone(authored),
    identity: { snapshotSha256: H("1"), entities: [{ ref: person, affiliationRefs: [], affiliationStatus: "none" }] },
    referenceEntities: [], sourceReceipts: [], review: { receipt: { contentId: "baseline", sha256: H("4") }, inputSha256: H("0"), permittedKinds: [], sourceReceipts: [] }, replay: null } };
  initializeCommandHead(db, binding);
  return { db, binding };
}
function command(db, binding, id, value = null) {
  const current = readCommandEdition(db, binding);
  const targetEntityRefs = [person, ...(value ? [value] : [])].sort((a, b) => canonicalEncode(Object.values(a)) < canonicalEncode(Object.values(b)) ? -1 : 1);
  const commandPackage = { schema: "janseon-map-commands.v1", datasetId: binding.context.authored.datasetId,
    baseGeneration: current.generationId, expectedSemanticHash: current.mapSemanticSha256, identitySnapshotHash: H("1"), operationId: id,
    operations: [{ kind: "placement.set", editionId: current.authored.editionId, args: { personRef: person, stationRef: value }, targetEntityRefs }] };
  const review = { receipt: { contentId: "review-" + id, sha256: H("a") }, inputSha256: semanticDigest(commandPackage), permittedKinds: ["placement.set"], sourceReceipts: [] };
  return { binding, commandPackage, review };
}
const logCount = db => db.prepare("SELECT count(*) AS n FROM map_command_log").get().n;

for (const syntax of ["INSERT OR REPLACE", "REPLACE", "UPSERT"]) {
  for (const conflict of ["sequence", "operation_id", "generation_id"]) {
    test(`${syntax} log conflict on ${conflict} fails without deleting history or changing head`, t => {
      const f = fixture(t);
      f.db.exec("PRAGMA recursive_triggers=OFF");
      assert.equal(f.db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
      acceptCommandPackage(f.db, command(f.db, f.binding, "first"));
      const history = f.db.prepare("SELECT * FROM map_command_log ORDER BY sequence").all();
      const head = f.db.prepare("SELECT * FROM map_command_head").get();
      const row = { ...history[0], sequence: 2, operation_id: "second", generation_id: H("e"),
        base_generation: head.generation_id, base_edition_id: head.edition_id, input_sha256: H("f") };
      row[conflict] = history[0][conflict];
      const columns = Object.keys(row);
      const suffix = syntax === "UPSERT" ? ` ON CONFLICT(dataset_id,${conflict}) DO UPDATE SET input_sha256=excluded.input_sha256` : "";
      const sql = `${syntax === "UPSERT" ? "INSERT" : syntax} INTO map_command_log (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})${suffix}`;
      assert.throws(() => f.db.prepare(sql).run(...Object.values(row)), /E_COMMAND_STORE_(?:IMMUTABLE|STALE)/u);
      assert.deepEqual(f.db.prepare("SELECT * FROM map_command_log ORDER BY sequence").all(), history);
      assert.deepEqual(f.db.prepare("SELECT * FROM map_command_head").get(), head);
    });
  }
  test(`${syntax} head conflict fails without resetting accepted state`, t => {
    const f = fixture(t);
    f.db.exec("PRAGMA recursive_triggers=OFF");
    assert.equal(f.db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
    acceptCommandPackage(f.db, command(f.db, f.binding, "first"));
    const history = f.db.prepare("SELECT * FROM map_command_log ORDER BY sequence").all();
    const head = f.db.prepare("SELECT * FROM map_command_head").get();
    const suffix = syntax === "UPSERT" ? " ON CONFLICT(dataset_id) DO UPDATE SET sequence=excluded.sequence,generation_id=excluded.generation_id,edition_id=excluded.edition_id,map_semantic_sha256=excluded.map_semantic_sha256,context_sha256=excluded.context_sha256" : "";
    const sql = `${syntax === "UPSERT" ? "INSERT" : syntax} INTO map_command_head VALUES(?,?,?,?,?,?)${suffix}`;
    assert.throws(() => f.db.prepare(sql).run(head.dataset_id, 0, H("a"), "reset", H("b"), H("c")), /E_COMMAND_STORE_(?:IMMUTABLE|STALE)/u);
    assert.deepEqual(f.db.prepare("SELECT * FROM map_command_log ORDER BY sequence").all(), history);
    assert.deepEqual(f.db.prepare("SELECT * FROM map_command_head").get(), head);
  });
}

for (const syntax of ["INSERT OR REPLACE", "REPLACE"]) {
  for (const table of ["map_command_log", "map_command_head"]) {
    test(`${syntax} explicit rowid aliases cannot replace ${table}`, t => {
      const f = fixture(t);
      f.db.exec("PRAGMA recursive_triggers=OFF");
      assert.equal(f.db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
      acceptCommandPackage(f.db, command(f.db, f.binding, "first"));
      const history = f.db.prepare("SELECT * FROM map_command_log ORDER BY sequence").all();
      const head = f.db.prepare("SELECT * FROM map_command_head").get();
      const row = table === "map_command_log" ? { ...history[0], sequence: 2, operation_id: "fresh", generation_id: H("e"),
        base_generation: head.generation_id, base_edition_id: head.edition_id } : { ...head, dataset_id: "other", sequence: 0 };
      for (const alias of ["rowid", "_rowid_", "oid"]) {
        const columns = [alias, ...Object.keys(row)];
        assert.throws(() => f.db.prepare(`${syntax} INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
          .run(1, ...Object.values(row)), /has no column named (?:rowid|_rowid_|oid)/u);
        assert.deepEqual(f.db.prepare("SELECT * FROM map_command_log ORDER BY sequence").all(), history);
        assert.deepEqual(f.db.prepare("SELECT * FROM map_command_head").get(), head);
      }
    });
  }
}

test("schema-discovered every primary and unique conflict target preserves both tables", t => {
  const f = fixture(t);
  f.db.exec("PRAGMA recursive_triggers=OFF");
  assert.equal(f.db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
  acceptCommandPackage(f.db, command(f.db, f.binding, "first"));
  const history = f.db.prepare("SELECT * FROM map_command_log ORDER BY sequence").all();
  const head = f.db.prepare("SELECT * FROM map_command_head").get();
  const targets = [];
  for (const table of ["map_command_log", "map_command_head"]) {
    assert.equal(f.db.prepare("PRAGMA table_list").all().find(r => r.name === table).wr, 1);
    for (const index of f.db.prepare(`PRAGMA index_list(${table})`).all().filter(r => r.unique)) {
      const columns = f.db.prepare(`PRAGMA index_info('${index.name}')`).all().map(r => r.name);
      targets.push([table, columns]);
      for (const syntax of ["INSERT OR REPLACE", "REPLACE", "UPSERT"]) {
        const original = table === "map_command_log" ? history[0] : head;
        const row = table === "map_command_log" ? { ...original, sequence: 2, operation_id: "fresh", generation_id: H("e"),
          base_generation: head.generation_id, base_edition_id: head.edition_id, input_sha256: H("f") }
          : { ...original, dataset_id: "other", sequence: 0, generation_id: H("f"), context_sha256: H("e") };
        for (const column of columns) row[column] = original[column];
        const field = table === "map_command_log" ? "input_sha256" : "context_sha256";
        const suffix = syntax === "UPSERT" ? ` ON CONFLICT(${columns.join(",")}) DO UPDATE SET ${field}=excluded.${field}` : "";
        assert.throws(() => f.db.prepare(`${syntax === "UPSERT" ? "INSERT" : syntax} INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})${suffix}`)
          .run(...Object.values(row)), /E_COMMAND_STORE_(?:IMMUTABLE|STALE)/u);
        assert.deepEqual(f.db.prepare("SELECT * FROM map_command_log ORDER BY sequence").all(), history);
        assert.deepEqual(f.db.prepare("SELECT * FROM map_command_head").get(), head);
      }
    }
  }
  assert.equal(targets.length, 4);
});

test("atomic acceptance, immutable rows, exact duplicate and deterministic exported replay across fresh clones", t => {
  const a = fixture(t), b = fixture(t);
  const first = command(a.db, a.binding, "first");
  const accepted = acceptCommandPackage(a.db, first);
  assert.equal(accepted.newEdition.assignments[0].valueRef, null);
  acceptCommandPackage(a.db, command(a.db, a.binding, "second", station("é")));
  assert.deepEqual(acceptCommandPackage(a.db, first), { ...accepted, replayed: true });
  assert.equal(logCount(a.db), 2);
  const exported = exportCommandLog(a.db, a.binding);
  replayCommandLog(b.db, { binding: b.binding, package: JSON.parse(JSON.stringify(exported)) });
  assert.deepEqual(readCommandEdition(b.db, b.binding), readCommandEdition(a.db, a.binding));
  assert.deepEqual(exportCommandLog(b.db, b.binding), exported);
  assert.equal(readCommandEdition(b.db, b.binding).authored.entities.length, 1);
  for (const sql of ["UPDATE map_command_log SET operation_id='tampered'", "DELETE FROM map_command_log", "DELETE FROM map_command_head"])
    assert.throws(() => a.db.exec(sql), /E_COMMAND_STORE_IMMUTABLE/u);
});

test("stale generation, tampered duplicate, wrong review and reversed replay do not advance head", t => {
  const a = fixture(t), clone = fixture(t), first = command(a.db, a.binding, "first"), stale = command(a.db, a.binding, "stale");
  acceptCommandPackage(a.db, first);
  assert.throws(() => acceptCommandPackage(a.db, stale), { code: "E_COMMAND_STALE" });
  const tampered = structuredClone(first); tampered.commandPackage.operations[0].args.stationRef = station("é");
  assert.throws(() => acceptCommandPackage(a.db, tampered), { code: "E_COMMAND_REPLAY" });
  const wrong = command(a.db, a.binding, "wrong"); wrong.review.inputSha256 = H("f");
  assert.throws(() => acceptCommandPackage(a.db, wrong), { code: "E_COMMAND_REVIEW" });
  acceptCommandPackage(a.db, command(a.db, a.binding, "second", station("é")));
  const exported = exportCommandLog(a.db, a.binding); exported.commands.reverse();
  assert.throws(() => replayCommandLog(clone.db, { binding: clone.binding, package: exported }), /E_COMMAND_(?:STALE|BINDING)/u);
  assert.equal(logCount(clone.db), 0); assert.equal(logCount(a.db), 2);
});

test("rollback after append and before CAS leaves neither acceptance nor changed state", t => {
  const f = fixture(t), before = readCommandEdition(f.db, f.binding), pkg = command(f.db, f.binding, "rollback");
  const wrapped = { get isTransaction() { return f.db.isTransaction; }, exec: sql => f.db.exec(sql),
    prepare(sql) { if (sql.startsWith("UPDATE map_command_head")) throw Error("injected CAS failure"); return f.db.prepare(sql); } };
  assert.throws(() => acceptCommandPackage(wrapped, pkg), /injected CAS failure/u);
  assert.equal(logCount(f.db), 0); assert.deepEqual(readCommandEdition(f.db, f.binding), before);
  assert.equal(f.db.isTransaction, false);
});

test("two connections reject a live concurrent writer and then its stale-base candidate", t => {
  const directory = mkdtempSync(join(tmpdir(), "command-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "central.sqlite"), a = fixture(t, path), b = new DatabaseSync(path);
  t.after(() => b.close()); b.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
  const first = command(a.db, a.binding, "winner"), second = command(b, a.binding, "loser");
  let barrierReached = false;
  const wrapped = { get isTransaction() { return a.db.isTransaction; }, exec(sql) {
    a.db.exec(sql);
    if (sql === "BEGIN IMMEDIATE") {
      barrierReached = true;
      assert.throws(() => acceptCommandPackage(b, second), /database is locked/u);
      assert.equal(b.isTransaction, false);
    }
  }, prepare: sql => a.db.prepare(sql) };
  acceptCommandPackage(wrapped, first);
  assert.equal(barrierReached, true);
  assert.throws(() => acceptCommandPackage(b, second), { code: "E_COMMAND_STALE" });
  assert.equal(logCount(b), 1);
});

test("invalid operation and mismatched central baseline leave log empty", t => {
  const f = fixture(t), invalid = command(f.db, f.binding, "invalid"); invalid.commandPackage.operations[0].kind = "geometry.drag-observed";
  assert.throws(() => acceptCommandPackage(f.db, invalid), { code: "E_COMMAND_KIND" });
  const altered = structuredClone(f.binding); altered.context.identitySnapshotSha256 = H("f");
  assert.throws(() => readCommandEdition(f.db, altered), { code: "E_COMMAND_STORE_BINDING" });
  assert.equal(logCount(f.db), 0);
});
