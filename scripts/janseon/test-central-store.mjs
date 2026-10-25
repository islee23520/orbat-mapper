import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { centralInputs, graphInput, observedInput } from "./central-store-fixture.mjs";
import { semanticDigest } from "./canonical.mjs";
import { assertStoreSchema } from "./store-schema.mjs";
import { initializeGraphStore, importGraphEdition, readGraphEdition, encodeGraphPayload } from "./graph-store.mjs";
import { initializeObservedGeographyStore, importObservedGeographyEdition, readObservedGeographyEdition,
  observedGeographySemanticProjection, encodeObservedGeometryPayload } from "./observed-geography-store.mjs";
import { initializeCentralStore, importCentralEditions, readCentralSnapshot } from "./central-store.mjs";

const MODE = "janseon-central-store.v1";
const sha = value => createHash("sha256").update(value).digest("hex");
const request = input => ({ datasetId: input.expectedBinding.dataset_id, editionId: input.expectedBinding.edition_id, expectedBinding: input.expectedBinding });
const requests = pair => ({ graph: request(pair.graph), observedGeography: request(pair.observedGeography) });
const count = (db, table) => db.prepare("SELECT count(*) AS n FROM " + table).get().n;

const inputs = centralInputs;
function database(t, initialize = initializeCentralStore) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close()); initialize(db); return db;
}

function disk(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "central-store-"));
  const connections = [];
  t.after(() => { for (const db of connections) if (db.isOpen) db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, "map.sqlite");
  return { path, open(options = {}) { const db = new DatabaseSync(path, options); connections.push(db); db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0"); return db; } };
}

// These wrappers delegate real SQL/results and transaction ownership; only the
// chosen exact statement boundary gains a fault or a synchronous interleaving.
function wrap(db, { exec, afterAll } = {}) {
  return { get isTransaction() { return db.isTransaction; },
    exec(sql) { if (exec) exec(sql); return db.exec(sql); },
    prepare(sql) {
      const statement = db.prepare(sql);
      return new Proxy(statement, { get(target, name) {
        if (name === "all" && afterAll) return (...args) => { const rows = target.all(...args); afterAll(sql); return rows; };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
}

function corrupt(db, action) {
  const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'").all();
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
  for (const row of triggers) db.exec('DROP TRIGGER "' + row.name + '"');
  try { action(db); } finally {
    for (const row of triggers) db.exec(row.sql);
    db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
  }
}

test("exact 46-table/138-trigger union imports and reads both domains on one connection", t => {
  const db = database(t), input = inputs(), original = structuredClone(input);
  const result = importCentralEditions(db, input), snapshot = readCentralSnapshot(db, requests(input));
  assert.deepEqual(input, original); assert.equal(result.schema, "janseon-central-import.v1");
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
  assert.equal(objects.length, 184); assert.equal(objects.filter(row => row.type === "trigger").length, 138);
  const tables = db.prepare("PRAGMA table_list").all().filter(row => row.name.startsWith("map_"));
  assert.equal(tables.length, 46); assert.ok(tables.every(row => row.strict));
  for (const [prefix, expected, extra] of [["map_graph_", 142, ["map_graph_binding", "map_graph_seal"]], ["map_observed_", 85, ["map_observed_binding", "map_observed_seal"]]]) {
    const columns = tables.filter(row => row.name.startsWith(prefix) && !extra.includes(row.name)).reduce((sum, row) => sum + db.prepare("PRAGMA table_info(" + row.name + ")").all().filter(column => !["dataset_id", "edition_id", "entity_kind", "source_id", "longitude_text", "latitude_text"].includes(column.name)).length, 0);
    assert.equal(columns, expected);
  }
  const graph = database(t, initializeGraphStore), observed = database(t, initializeObservedGeographyStore);
  importGraphEdition(graph, input.graph); importObservedGeographyEdition(observed, input.observedGeography);
  assert.deepEqual(snapshot.graph, readGraphEdition(graph, request(input.graph)));
  assert.deepEqual(snapshot.observedGeography, readObservedGeographyEdition(observed, request(input.observedGeography)));
  assert.deepEqual(encodeGraphPayload(snapshot.graph.document), encodeGraphPayload(input.graph.document));
  assert.deepEqual(encodeObservedGeometryPayload(snapshot.observedGeography.geometry), encodeObservedGeometryPayload(readObservedGeographyEdition(observed, request(input.observedGeography)).geometry));
  assert.equal(db.isTransaction, false); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("default domain APIs stay standalone-strict and explicit modes cannot accept partial unions", t => {
  const db = database(t), input = inputs(); importCentralEditions(db, input);
  for (const [read, imp, requestValue, inputValue, other] of [[readGraphEdition, importGraphEdition, request(input.graph), input.graph, "janseon-observed-geography-store.v1"],
    [readObservedGeographyEdition, importObservedGeographyEdition, request(input.observedGeography), input.observedGeography, "janseon-graph-store.v1"]]) {
    for (const mode of [undefined, other, true, {}, "future"]) {
      assert.throws(() => read(db, requestValue, mode)); assert.throws(() => imp(db, inputValue, mode));
    }
    assert.throws(() => imp(db, { ...inputValue, trusted: true }, MODE));
  }
  for (const init of [initializeGraphStore, initializeObservedGeographyStore]) {
    const partial = database(t, init); assert.throws(() => assertStoreSchema(partial, MODE), { code: "E_STORE_SCHEMA" });
    assert.throws(() => initializeCentralStore(partial), { code: "E_CENTRAL_SCHEMA" });
    assert.throws(() => importCentralEditions(partial, input), { code: "E_CENTRAL_SCHEMA" });
  }
  for (const mode of [undefined, null, false, {}, "future"]) assert.throws(() => assertStoreSchema(db, mode), { code: "E_STORE_SCHEMA" });
  for (const options of [{}, { graph: input.graph }, { ...input, mode: MODE }]) assert.throws(() => importCentralEditions(db, options));
  assert.throws(() => initializeGraphStore(db), { code: "E_GRAPH_SCHEMA" });
  assert.throws(() => initializeObservedGeographyStore(db), { code: "E_OBSERVED_SCHEMA" });
});

test("every explicit schema mutation and third namespace fails both union domain boundaries", t => {
  for (const sql of ["CREATE TABLE other(x TEXT)", "CREATE TABLE map_graph_fake(x TEXT)", "CREATE INDEX other ON map_graph_station(lat)",
    "CREATE VIEW other AS SELECT 1", "CREATE TRIGGER extra AFTER INSERT ON map_graph_binding BEGIN SELECT 1; END",
    "ALTER TABLE map_observed_slot ADD COLUMN unknown TEXT", "DROP TRIGGER map_observed_seal_immutable_INSERT",
    "DROP TRIGGER map_graph_seal_immutable_UPDATE; CREATE TRIGGER map_graph_seal_immutable_UPDATE BEFORE UPDATE ON map_graph_seal BEGIN SELECT 1; END",
    "CREATE TEMP TABLE other(x TEXT)", "ATTACH DATABASE ':memory:' AS other", "PRAGMA foreign_keys=OFF"]) {
    const db = database(t), input = inputs(); importCentralEditions(db, input); db.exec(sql);
    assert.throws(() => readCentralSnapshot(db, requests(input)), { code: "E_CENTRAL_SCHEMA" });
    assert.throws(() => importCentralEditions(db, inputs("two")), { code: "E_CENTRAL_SCHEMA" });
    assert.throws(() => readGraphEdition(db, request(input.graph), MODE), { code: "E_GRAPH_SCHEMA" });
    assert.throws(() => readObservedGeographyEdition(db, request(input.observedGeography), MODE), { code: "E_OBSERVED_SCHEMA" });
    assert.throws(() => importGraphEdition(db, graphInput("two"), MODE), { code: "E_GRAPH_SCHEMA" });
    assert.throws(() => importObservedGeographyEdition(db, observedInput("two"), MODE), { code: "E_OBSERVED_SCHEMA" });
    assert.equal(db.isTransaction, false);
  }
  const db = database(t); db.exec("DROP TABLE map_observed_boundary_point");
  assert.throws(() => assertStoreSchema(db, MODE), { code: "E_STORE_SCHEMA" });
});

test("fixed SQL parser rejects all unconsumed DDL, duplicate names and malformed trigger grammar", async () => {
  const original = fs.readFileSync;
  const sql = original(new URL("./graph-schema.sql", import.meta.url), "utf8");
  const changes = [text => text + "\nCREATE VIEW hidden AS SELECT 1;", text => text + "\nPRAGMA foreign_keys=OFF;",
    text => text + "\nSELECT 1;", text => text + "\n/* unsupported block comment */",
    text => text + "\nCREATE TABLE map_graph_binding (x TEXT) STRICT;",
    text => text + "\nCREATE TABLE map_graph_incomplete (x TEXT",
    text => text.replace("BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;", "BEGIN SELECT 1; END;"),
    text => text.replace("CREATE TABLE map_graph_import", "CREATE INDEX map_graph_import"),
    text => text.replace("END;", "END; UNKNOWN;"),
  ];
  for (const [index, change] of changes.entries()) {
    try {
      fs.readFileSync = (path, ...args) => String(path).endsWith("/graph-schema.sql") ? change(sql) : original(path, ...args);
      syncBuiltinESMExports();
      await assert.rejects(import(new URL("./store-schema.mjs?invalid=" + index, import.meta.url)), { code: "E_STORE_SCHEMA" });
    } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  }
});

test("fresh union DDL rolls back second-block, final-check and COMMIT failures", t => {
  for (const caller of [false, true]) for (const stage of ["second", "assert", "commit"]) {
    const db = new DatabaseSync(":memory:"); t.after(() => db.close()); db.exec("PRAGMA foreign_keys=ON");
    if (caller) db.exec("BEGIN; SAVEPOINT caller");
    let fired = false;
    const wrapped = wrap(db, { exec(sql) {
      const match = stage === "second" ? sql.includes("CREATE TABLE map_observed_binding")
        : stage === "commit" ? sql === (caller ? "RELEASE map_schema_install" : "COMMIT") : false;
      if (!fired && match) { fired = true; throw Error("injected " + stage); }
    }, afterAll(sql) { if (!fired && stage === "assert" && sql.startsWith("SELECT type, name, sql")) { fired = true; throw Error("injected assert"); } } });
    assert.throws(() => initializeCentralStore(wrapped), /injected/); assert.equal(fired, true);
    assert.equal(count(db, "sqlite_schema"), 0); assert.equal(db.isTransaction, caller);
    if (caller) db.exec("ROLLBACK TO caller; RELEASE caller; COMMIT");
  }
  const db = new DatabaseSync(":memory:"); t.after(() => db.close()); db.exec("PRAGMA foreign_keys=ON; BEGIN; SAVEPOINT caller");
  initializeCentralStore(db); db.exec("ROLLBACK TO caller; RELEASE caller; COMMIT"); assert.equal(count(db, "sqlite_schema"), 0);
});

test("second-domain shape, digest, duplicate and admission failures roll back the first import", t => {
  for (const caller of [false, true]) for (const fault of ["shape", "digest", "duplicate", "admission"]) {
    const db = database(t), prior = inputs(); importCentralEditions(db, prior);
    const before = readCentralSnapshot(db, requests(prior));
    if (caller) { db.exec("BEGIN; SAVEPOINT caller"); importCentralEditions(db, inputs("caller-work")); }
    const input = inputs("two");
    if (fault === "shape") input.observedGeography.rows.geography_slot[0].holderPersonId = "forbidden";
    if (fault === "digest") input.observedGeography.expectedBinding.expected_projection_sha256 = "0".repeat(64);
    if (fault === "duplicate") input.observedGeography = prior.observedGeography;
    if (fault === "admission") input.observedGeography.expectedBinding.dataset_id = "seoul-observed-geography";
    assert.throws(() => importCentralEditions(db, input));
    assert.equal(db.isTransaction, caller); assert.equal(count(db, "map_graph_seal"), caller ? 2 : 1);
    assert.equal(count(db, "map_observed_seal"), caller ? 2 : 1);
    assert.deepEqual(readCentralSnapshot(db, requests(prior)), before);
    if (caller) { db.exec("ROLLBACK TO caller; RELEASE caller; COMMIT"); assert.equal(count(db, "map_graph_seal"), 1); }
  }
});

test("late readback and central COMMIT errors leave no partial pair and preserve caller ownership", t => {
  for (const caller of [false, true]) {
    const db = database(t), prior = inputs(); importCentralEditions(db, prior);
    if (caller) db.exec("BEGIN; SAVEPOINT caller");
    let fired = false;
    const wrapped = wrap(db, { exec(sql) {
      if (!fired && sql === (caller ? "RELEASE map_central_import" : "COMMIT")) { fired = true; throw Error("commit fault"); }
    } });
    assert.throws(() => importCentralEditions(wrapped, inputs("two")), /commit fault/);
    assert.equal(fired, true); assert.equal(count(db, "map_graph_seal"), 1); assert.equal(count(db, "map_observed_seal"), 1);
    assert.equal(db.isTransaction, caller);
    if (caller) db.exec("ROLLBACK TO caller; RELEASE caller; COMMIT");
    corrupt(db, connection => connection.exec("UPDATE map_observed_slot_geometry SET ref='missing'"));
    assert.throws(() => importCentralEditions(db, inputs("late")), { code: "E_GRAPH_INTEGRITY" });
    assert.equal(count(db, "map_graph_seal"), 1); assert.equal(count(db, "map_observed_seal"), 1); assert.equal(db.isTransaction, false);
  }
});

test("an actual deferred foreign-key COMMIT failure rolls back the entire owned import", t => {
  const db = database(t);
  let injected = false;
  const wrapped = wrap(db, { exec(sql) {
    if (sql !== "COMMIT" || injected) return;
    injected = true;
    // Insert a genuinely deferred violation after readback, before real COMMIT.
    // This is test-only boundary injection, not simulated commit failure.
    for (const table of ["map_observed_binding", "map_observed_boundary_point"]) {
      const row = { ...db.prepare("SELECT * FROM " + table + " LIMIT 1").get(), edition_id: "unsealed-fault" };
      const names = Object.keys(row);
      db.prepare("INSERT INTO " + table + " (" + names.join(",") + ") VALUES (" + names.map(() => "?").join(",") + ")").run(...Object.values(row));
    }
  } });
  assert.throws(() => importCentralEditions(wrapped, inputs()), /FOREIGN KEY constraint failed/);
  assert.equal(injected, true); assert.equal(db.isTransaction, false);
  for (const table of ["map_graph_binding", "map_observed_binding", "map_graph_seal", "map_observed_seal"]) assert.equal(count(db, table), 0);
});

test("production observed pins are not an admission capability in union mode", t => {
  const db = database(t), prior = inputs(); importCentralEditions(db, prior);
  const candidate = inputs("sgis-20250630"), binding = candidate.observedGeography.expectedBinding;
  Object.assign(binding, { dataset_id: "seoul-observed-geography",
    original_geometry_sha256: "6a393cefb7cc257f001042acb8715e5d721b320e14eba723f15857197edaa5e4",
    original_spatial_sha256: "389b1eabee54cddc965dd523c3b831cdc60ea72d180cab908295c3359a8045ad",
    original_membership_sha256: "5c082aad68af1145dca138d8bf048a9b16e5a13b8618aa7c8c2e79bfc3db74f1" });
  assert.throws(() => importObservedGeographyEdition(db, candidate.observedGeography, MODE), { code: "E_OBSERVED_ADMISSION" });
  assert.throws(() => importCentralEditions(db, candidate), { code: "E_OBSERVED_ADMISSION" });
  assert.equal(count(db, "map_graph_seal"), 1); assert.equal(count(db, "map_observed_seal"), 1);
  assert.equal(readCentralSnapshot(db, requests(prior)).graph.editionId, "one");
});

test("union mode retains immutable replacement and row-move guards in both namespaces", t => {
  const db = database(t), input = inputs(); importCentralEditions(db, input);
  assert.equal(db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
  const before = db.serialize();
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
    if (!count(db, name)) continue;
    for (const sql of ["UPDATE " + name + " SET edition_id='other'", "DELETE FROM " + name,
      "INSERT INTO " + name + " SELECT * FROM " + name, "REPLACE INTO " + name + " SELECT * FROM " + name,
      "INSERT OR REPLACE INTO " + name + " SELECT * FROM " + name]) {
      assert.throws(() => db.exec(sql), /immutable/); assert.deepEqual(db.serialize(), before);
    }
  }
  db.exec("PRAGMA foreign_keys=OFF");
  for (const table of ["map_graph_station", "map_observed_boundary_feature"]) {
    const row = { ...db.prepare("SELECT * FROM " + table + " LIMIT 1").get(), edition_id: "unsealed" };
    const keys = Object.keys(row); db.prepare("INSERT INTO " + table + " (" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")").run(...Object.values(row));
    assert.throws(() => db.exec("UPDATE " + table + " SET edition_id='one' WHERE edition_id='unsealed'"), /immutable/);
  }
});

test("cross-domain names never satisfy foreign keys and restored schema cannot hide corrupted facts", t => {
  for (const sql of ["UPDATE map_observed_slot_geometry SET ref='e' || char(769)",
    "UPDATE map_graph_station SET edition_id='missing' WHERE ordinal=0",
    "UPDATE map_observed_boundary_point SET longitude_text='127.000'",
    "UPDATE map_observed_source_record SET sha256='bad'", "DELETE FROM map_graph_seal", "DELETE FROM map_observed_seal",
    "UPDATE map_graph_station SET lat=38 WHERE ordinal=0"]) {
    const db = database(t), input = inputs(); importCentralEditions(db, input);
    corrupt(db, connection => connection.exec(sql)); assertStoreSchema(db, MODE);
    assert.throws(() => readCentralSnapshot(db, requests(input))); assert.equal(db.isTransaction, false);
  }
  const db = database(t), input = inputs(); importCentralEditions(db, input);
  const result = readCentralSnapshot(db, requests(input));
  assert.equal(result.graph.datasetId, result.observedGeography.datasetId);
  assert.equal(result.graph.document.stations[0].id, result.observedGeography.geometry.features[0].id);
  assert.equal(result.graph.document.stations.length, 2); assert.equal(result.observedGeography.geometry.features.length, 4);
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
    for (const fk of db.prepare("PRAGMA foreign_key_list(" + name + ")").all()) assert.equal(name.startsWith("map_graph_"), fk.table.startsWith("map_graph_"));
  }
});

test("read-only reopen and caller read transactions use one connection without source fallback", t => {
  const file = disk(t), writer = file.open(); initializeCentralStore(writer); const input = inputs(); importCentralEditions(writer, input); writer.close();
  const db = file.open({ readOnly: true }), operations = [];
  const guarded = wrap(db, { exec(sql) { operations.push(sql); assert.match(sql, /^(BEGIN|SAVEPOINT|RELEASE|COMMIT|ROLLBACK)/); } });
  const originalRead = fs.readFileSync, originalParse = JSON.parse;
  try {
    fs.readFileSync = () => { throw Error("source filesystem forbidden"); }; syncBuiltinESMExports(); JSON.parse = () => { throw Error("JSON parse forbidden"); };
    assert.equal(readCentralSnapshot(guarded, requests(input)).graph.document.stations.length, 2);
    db.exec("BEGIN; SAVEPOINT caller"); readCentralSnapshot(guarded, requests(input)); assert.equal(db.isTransaction, true);
    assert.throws(() => readCentralSnapshot(guarded, { ...requests(input), observedGeography: request(observedInput("missing")) }));
    assert.equal(db.isTransaction, true); db.exec("ROLLBACK TO caller; RELEASE caller; COMMIT");
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); JSON.parse = originalParse; }
  assert.equal(operations[0], "BEGIN"); assert.equal(operations.includes("BEGIN IMMEDIATE"), false);
});

test("WAL interleaving cannot mix an observed edition committed between the two domain reads", t => {
  const file = disk(t), a = file.open(); a.exec("PRAGMA journal_mode=WAL"); initializeCentralStore(a);
  const initial = inputs(); importCentralEditions(a, initial); const b = file.open();
  const late = observedInput("late"); let interleaved = false;
  const reader = wrap(a, { afterAll(sql) {
    if (!interleaved && sql.startsWith("SELECT graph_semantic_sha256 FROM map_graph_seal")) {
      interleaved = true; importObservedGeographyEdition(b, late, MODE);
    }
  } });
  const selection = { graph: request(initial.graph), observedGeography: request(late) };
  assert.throws(() => readCentralSnapshot(reader, selection), { code: "E_OBSERVED_BINDING" });
  assert.equal(interleaved, true); assert.equal(a.isTransaction, false);
  assert.equal(readCentralSnapshot(a, selection).observedGeography.editionId, "late");
  let unrelated = false;
  const stable = wrap(a, { afterAll(sql) { if (!unrelated && sql.startsWith("SELECT graph_semantic_sha256 FROM map_graph_seal")) {
    unrelated = true; importCentralEditions(b, inputs("unrelated"));
  } } });
  assert.deepEqual(readCentralSnapshot(stable, requests(initial)), readCentralSnapshot(a, requests(initial)));
  assert.equal(unrelated, true);
});

test("one database writer lock propagates SQLITE_BUSY without a partial pair or retry", t => {
  const file = disk(t), a = file.open(); initializeCentralStore(a); const b = file.open();
  a.exec("BEGIN IMMEDIATE");
  assert.throws(() => importCentralEditions(b, inputs()), error => error.errcode === 5);
  assert.equal(b.isTransaction, false); assert.equal(count(b, "map_graph_binding"), 0); assert.equal(count(b, "map_observed_binding"), 0);
  a.exec("ROLLBACK"); importCentralEditions(b, inputs()); assert.equal(count(b, "map_graph_seal"), 1);
});

test("pair semantics change with facts or selectors but not provenance or repacked bytes", t => {
  const db = database(t), input = inputs(); importCentralEditions(db, input);
  const before = readCentralSnapshot(db, requests(input)), bytes = db.serialize();
  db.exec("PRAGMA page_size=8192; VACUUM"); assert.notEqual(sha(db.serialize()), sha(bytes));
  assert.deepEqual(readCentralSnapshot(db, requests(input)), before);
  const other = database(t), changed = inputs();
  changed.graph.expectedBinding.source_revision = "delivery-two"; changed.observedGeography.expectedBinding.source_revision = "delivery-two";
  importCentralEditions(other, changed); assert.equal(readCentralSnapshot(other, requests(changed)).centralSemanticSha256, before.centralSemanticSha256);
  const next = inputs("two"); importCentralEditions(db, next);
  assert.notEqual(readCentralSnapshot(db, requests(next)).centralSemanticSha256, before.centralSemanticSha256);
  const altered = inputs(); altered.observedGeography.rows.geography_spatial[0].baseDate = "2025-07-01";
  altered.observedGeography.expectedBinding.expected_projection_sha256 = semanticDigest(observedGeographySemanticProjection({ datasetId: "synthetic:shared", editionId: "one", rows: altered.observedGeography.rows }));
  const facts = database(t); importCentralEditions(facts, altered);
  assert.notEqual(readCentralSnapshot(facts, requests(altered)).centralSemanticSha256, before.centralSemanticSha256);
});
