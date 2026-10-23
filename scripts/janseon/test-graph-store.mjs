import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { semanticDigest } from "./canonical.mjs";
import { initializeGraphStore, importGraphEdition, readGraphEdition,
  graphSemanticProjection, encodeGraphPayload } from "./graph-store.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const official = () => ({ url: "https://example.invalid/rail", retrievedAt: "test-date", sha256: "a".repeat(64), scope: "synthetic" });
const support = index => ({ index, a: "A", b: "C", mappedA: "A", mappedB: "C",
  classification: "synthetic", officialAdjacentSupport: [], skippedStopEvidence: [],
  openingEdgeSupport: [], endpointClassification: ["matched", "matched"],
  noSurfaceAdjacencyInference: true, evidence_refs: [] });

function fixture() {
  const exclusions = [
    { originalIndex: 20, original: { a: "A", b: "C" }, status: "excluded", reason: "retained evidence", support: support(20) },
    { originalIndex: 21, original: { a: "A", b: "C" }, status: "excluded", reason: null, support: support(21) },
    { originalIndex: 22, original: { a: "A", b: "C" }, status: "excluded", support: support(22) },
    { originalIndex: 23, original: { a: "A", b: "C" }, status: "excluded", missing: [], support: support(23) },
    { originalIndex: 24, original: { a: "A", b: "C" }, status: "excluded", missing: ["official:missing"], support: support(24) },
  ];
  exclusions[4].support.officialAdjacentSupport = ["source:one", "source:one"];
  exclusions[4].support.openingEdgeSupport = ["opening:unresolved"];
  exclusions[4].support.evidence_refs = [{ path: "synthetic/source", selector: "path[0]" }];
  exclusions[4].support.skippedStopEvidence = [{ lineId: "L", lineName: "Line", pathIndex: 0,
    codes: ["001", "002", "003"], stationIds: ["A", "official:missing", "C"],
    names: ["Alpha", "Missing", "Charlie"], skippedStops: 1 }];
  return { schema: "seoul-world-graph-v2", districts: ["D"],
    stations: ["A", "B", "C", "\u00e9", "e\u0301"].map((id, i) => ({ id, nameKo: id, nameEn: id, district: "D", lat: 37.125 + i, lon: 127.25 + i })),
    edges: [{ a: "A", b: "B" }, { a: "B", b: "C" }], aliases: { second: "B", first: "A" },
    source: { original: "synthetic source", railAdjacency: { revision: "synthetic-v1", officialSource: official(),
      WikiCommit: "historical-source", scope: "no inference",
      replacements: [{ originalIndex: 10, original: { a: "A", b: "C" }, status: "replaced",
        chain: ["A", "B", "C"], officialCodes: ["001", "002", "003"], lineId: "L",
        source: official(), physicalEvidenceBoundary: "synthetic only" }], excluded: exclusions,
      hubIdentities: [{ uid: "001", officialCodes: ["001", "002"], permanentIds: ["A", "B"], lineIds: ["L", "L"],
        evidence: [0, 2].map(stationIndex => ({ lineId: "L", lineName: "Line", code: "001", uid: "001", name: "Alpha", pathIndex: 0, stationIndex })),
        contract: "metadata only" }] } } };
}

function inputs(document = fixture(), edition = "test-edition") {
  const bytes = Buffer.from(JSON.stringify(document) + "\n");
  const expectedBinding = { dataset_id: "synthetic:graph", edition_id: edition,
    schema_contract: "janseon-graph-store.v1", projection_contract: "janseon-graph-semantic.v1", source_schema: document.schema,
    expected_source_sha256: sha(bytes), expected_document_sha256: sha(JSON.stringify(document)), expected_byte_length: bytes.length,
    source_package_content_id: "synthetic-package", source_authentication_receipt_sha256: "b".repeat(64),
    source_revision: "synthetic-revision", source_reader_sha256: "c".repeat(64), source_schema_sha256: "d".repeat(64),
    field_disposition_sha256: "e".repeat(64), game_source_manifest_sha256: "f".repeat(64), rights_receipt_content_id: "synthetic-rights" };
  const sourceReceipt = { singleton: 1, actor: "synthetic-test", reason: "not production authentication",
    source_sha256: expectedBinding.expected_source_sha256, document_sha256: expectedBinding.expected_document_sha256, byte_length: bytes.length };
  return { document, sourceReceipt, expectedBinding };
}

function database(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  initializeGraphStore(db);
  return db;
}
const request = input => ({ datasetId: input.expectedBinding.dataset_id, editionId: input.expectedBinding.edition_id, expectedBinding: input.expectedBinding });
const count = (db, table) => db.prepare("SELECT count(*) AS n FROM " + table).get().n;
const rejected = fn => assert.throws(fn, error => /^(E_GRAPH_|ERR_SQLITE)/.test(error.code ?? "") || error instanceof TypeError);

// Bypass only immutable triggers to construct corrupted files; restore their exact
// definitions before invoking the real reader. No production validation is mocked.
function corrupt(db, mutate) {
  const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'").all();
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
  for (const row of triggers) db.exec('DROP TRIGGER "' + row.name + '"');
  mutate(db);
  for (const row of triggers) db.exec(row.sql);
  db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
}

test("fresh schema has 26 strict tables and round-trips every typed graph family", t => {
  const db = database(t), input = inputs();
  const result = importGraphEdition(db, input), read = readGraphEdition(db, request(input));
  assert.deepEqual(read.document, input.document);
  assert.equal(JSON.stringify(read.document), JSON.stringify(input.document));
  assert.equal(result.graphSemanticSha256, semanticDigest(graphSemanticProjection({ ...request(input), document: input.document })));
  assert.equal(read.graphSemanticSha256, result.graphSemanticSha256);
  assert.deepEqual(encodeGraphPayload(read.document), Buffer.from(JSON.stringify(input.document) + "\n"));
  const tables = db.prepare("PRAGMA table_list").all().filter(row => row.name.startsWith("map_graph_"));
  assert.equal(tables.length, 26); assert.ok(tables.every(row => row.strict === 1));
  const sourceColumnCount = tables.filter(row => !["map_graph_binding", "map_graph_seal"].includes(row.name))
    .reduce((n, table) => n + db.prepare("PRAGMA table_info(" + table.name + ")").all()
      .filter(c => !["dataset_id", "edition_id", "entity_kind", "source_id"].includes(c.name)).length, 0);
  assert.equal(sourceColumnCount, 142);
  assert.equal(count(db, "map_graph_excluded_skipped_station"), 3);
  assert.equal(count(db, "map_graph_hub_evidence"), 2);
  assert.equal(db.prepare("SELECT value FROM map_graph_hub_official_code ORDER BY ordinal").get().value, "001");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.isTransaction, false);
});

test("missing, null, empty arrays, Unicode and repeated evidence remain distinct", t => {
  const db = database(t), input = inputs(); importGraphEdition(db, input);
  const { document } = readGraphEdition(db, request(input)), x = document.source.railAdjacency.excluded;
  assert.equal(x[0].reason, "retained evidence"); assert.equal(x[1].reason, null);
  assert.equal(Object.hasOwn(x[2], "reason"), false); assert.equal(Object.hasOwn(x[2], "missing"), false);
  assert.deepEqual(x[3].missing, []); assert.deepEqual(x[4].missing, ["official:missing"]);
  assert.deepEqual(x[4].support.officialAdjacentSupport, ["source:one", "source:one"]);
  assert.equal(document.stations.length, 5); assert.notEqual(document.stations[3].id, document.stations[4].id);
  assert.deepEqual(Object.keys(document.aliases), ["second", "first"]);
});

test("typed boundary rejects malformed fields, unsupported values and dangling identities without writes", t => {
  const db = database(t);
  const mutations = [
    d => { d.extra = true; }, d => { delete d.stations[0].lon; }, d => { d.stations[0].nameEn = null; },
    d => { d.schema = "future"; }, d => { d.stations[0].lat = NaN; }, d => { d.stations[0].lat = -0; },
    d => { d.stations[0].nameKo = "\ud800"; }, d => { d.stations[0].nameKo = "bad\0text"; },
    d => { delete d.edges[0]; }, d => { d.edges.extra = 1; }, d => { d.stations.push({ ...d.stations[0] }); },
    d => { d.districts.push("D"); }, d => { d.edges.push({ a: "B", b: "A" }); }, d => { d.edges[0].b = "A"; },
    d => { d.edges[0].b = "official:missing"; }, d => { d.aliases.first = "absent"; }, d => { d.stations[0].district = "absent"; },
    d => { d.source.railAdjacency.replacements[0].chain[1] = "absent"; },
    d => { d.source.railAdjacency.hubIdentities[0].permanentIds.push("absent"); },
    d => { d.source.railAdjacency.hubIdentities.push(structuredClone(d.source.railAdjacency.hubIdentities[0])); },
    d => { d.source.railAdjacency.excluded[0].originalIndex = 10; },
    d => { d.source.railAdjacency.excluded[0].missing = []; },
    d => { d.source.railAdjacency.excluded[2].reason = null; },
    d => { d.source.railAdjacency.excluded[4].missing = null; },
    d => { delete d.source.railAdjacency.excluded[0].support.openingEdgeSupport; },
    d => { d.source.railAdjacency.excluded[0].support.noSurfaceAdjacencyInference = 1; },
    d => { d.source.railAdjacency.hubIdentities[0].evidence[0].stationIndex = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const mutate of mutations) {
    const d = fixture(); mutate(d); rejected(() => importGraphEdition(db, inputs(d)));
    assert.equal(count(db, "map_graph_binding"), 0); assert.equal(count(db, "map_graph_root"), 0);
  }
});

test("binding is caller supplied, exact, versioned, and enforces initial production pins", t => {
  const db = database(t);
  for (const mutate of [
    i => { i.expectedBinding.authenticated = true; }, i => { delete i.expectedBinding.source_revision; },
    i => { i.expectedBinding.expected_source_sha256 = "g".repeat(64); },
    i => { i.expectedBinding.source_package_content_id = "/private/path"; },
    i => { i.sourceReceipt.actor = " "; }, i => { i.sourceReceipt.document_sha256 = "0".repeat(64); },
    i => { i.expectedBinding.dataset_id = "seoul-world-graph"; },
    i => { i.expectedBinding.dataset_id = "other-production-dataset"; },
    i => { i.expectedBinding.projection_contract = "future"; },
  ]) { const i = inputs(); mutate(i); rejected(() => importGraphEdition(db, i)); }
  const production = inputs();
  Object.assign(production.expectedBinding, { dataset_id: "seoul-world-graph",
    edition_id: "source-sha256:46985afccc2d3f2b5e4e3152254d30bc023d0688d63745a951a9be0f6ebf097d",
    expected_source_sha256: "46985afccc2d3f2b5e4e3152254d30bc023d0688d63745a951a9be0f6ebf097d",
    expected_document_sha256: "0af399f295580d8f768594100c0a430621f15db0eb3b30e4581a8c07aa465c29", expected_byte_length: 217947 });
  Object.assign(production.sourceReceipt, { source_sha256: production.expectedBinding.expected_source_sha256,
    document_sha256: production.expectedBinding.expected_document_sha256, byte_length: 217947 });
  rejected(() => importGraphEdition(db, production)); assert.equal(count(db, "map_graph_binding"), 0);
  const input = inputs(); importGraphEdition(db, input);
  const wrong = request(input); wrong.expectedBinding = { ...wrong.expectedBinding, source_revision: "wrong" };
  rejected(() => readGraphEdition(db, wrong)); rejected(() => readGraphEdition(db, { ...request(input), editionId: "absent" }));
});

test("immutable triggers cover writes and moves into or out of sealed editions", t => {
  const db = database(t), input = inputs(); importGraphEdition(db, input);
  const before = sha(db.serialize());
  for (const sql of ["UPDATE map_graph_station SET lat=1", "DELETE FROM map_graph_edge",
    "UPDATE map_graph_binding SET source_revision='changed'", "UPDATE map_graph_seal SET graph_semantic_sha256='x'",
    "DELETE FROM map_graph_seal", "UPDATE map_graph_station SET edition_id='unsealed'"])
    assert.throws(() => db.exec(sql), /immutable graph/);
  for (const table of ["map_graph_root", "map_graph_import", "map_graph_station"]) {
    assert.throws(() => db.exec("INSERT INTO " + table + " SELECT * FROM " + table), /immutable graph/);
  }
  assert.equal(sha(db.serialize()), before);
  const row = { ...db.prepare("SELECT * FROM map_graph_station WHERE ordinal=0").get(), edition_id: "unsealed" };
  db.exec("PRAGMA foreign_keys=OFF");
  const keys = Object.keys(row);
  db.prepare("INSERT INTO map_graph_station (" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")").run(...Object.values(row));
  assert.throws(() => db.exec("UPDATE map_graph_station SET edition_id='test-edition' WHERE edition_id='unsealed'"), /immutable graph/);
});

test("seal replacement rejects with default recursive triggers and preserves the valid edition", t => {
  const db = database(t), input = inputs();
  assert.equal(db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
  importGraphEdition(db, input);
  const before = readGraphEdition(db, request(input));
  const sealBytes = () => db.prepare("SELECT hex(dataset_id) AS dataset, hex(edition_id) AS edition, hex(graph_semantic_sha256) AS digest FROM map_graph_seal").all();
  const originalSeal = sealBytes(), originalDatabase = db.serialize();
  for (const insert of ["INSERT OR REPLACE", "REPLACE"]) {
    assert.throws(() => db.prepare(insert + " INTO map_graph_seal (dataset_id, edition_id, graph_semantic_sha256) VALUES (?, ?, ?)")
      .run(input.expectedBinding.dataset_id, input.expectedBinding.edition_id, "0".repeat(64)), /immutable graph seal/);
    assert.deepEqual(sealBytes(), originalSeal);
    assert.deepEqual(db.serialize(), originalDatabase);
    assert.deepEqual(readGraphEdition(db, request(input)), before);
  }
  assert.equal(db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
  const next = inputs(fixture(), "next-edition");
  importGraphEdition(db, next);
  assert.deepEqual(readGraphEdition(db, request(next)).document, next.document);
  assert.equal(count(db, "map_graph_seal"), 2);
});

test("replacement into every other sealed table is already blocked by its insert guard", t => {
  const db = database(t), input = inputs(); importGraphEdition(db, input);
  assert.equal(db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
  const before = db.serialize();
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'map_graph_seal' ORDER BY name").all();
  assert.equal(tables.length, 25);
  for (const { name } of tables) {
    assert.ok(count(db, name) > 0, name);
    for (const insert of ["INSERT OR REPLACE", "REPLACE"]) {
      assert.throws(() => db.exec(insert + " INTO " + name + " SELECT * FROM " + name), /immutable graph edition/);
      assert.deepEqual(db.serialize(), before, insert + " " + name);
    }
  }
  assert.deepEqual(readGraphEdition(db, request(input)).document, input.document);
});

test("caller transaction and savepoint survive successful and failed imports", t => {
  const db = database(t), first = inputs(), second = inputs(fixture(), "second");
  db.exec("BEGIN; SAVEPOINT caller"); importGraphEdition(db, first);
  assert.equal(db.isTransaction, true);
  rejected(() => importGraphEdition(db, first)); assert.equal(count(db, "map_graph_seal"), 1);
  importGraphEdition(db, second); assert.equal(count(db, "map_graph_seal"), 2);
  db.exec("ROLLBACK TO caller; RELEASE caller; COMMIT"); assert.equal(count(db, "map_graph_seal"), 0);
  // A late readback failure must roll back all rows of the new edition only.
  importGraphEdition(db, first);
  corrupt(db, d => d.exec("UPDATE map_graph_hub_evidence SET hub_ordinal=99"));
  db.exec("BEGIN");
  assert.throws(() => importGraphEdition(db, inputs(fixture(), "bad")), error => error.code === "E_GRAPH_INTEGRITY");
  assert.equal(db.isTransaction, true);
  assert.equal(count(db, "map_graph_binding"), 1);
  assert.equal(count(db, "map_graph_seal"), 1); db.exec("ROLLBACK");
  assert.throws(() => importGraphEdition(db, inputs(fixture(), "bad-owned")), error => error.code === "E_GRAPH_INTEGRITY");
  assert.equal(db.isTransaction, false); assert.equal(count(db, "map_graph_binding"), 1);
});

test("SQL keys, types, presence checks and namespaced foreign keys reject invalid rows", t => {
  const db = database(t), input = inputs(); importGraphEdition(db, input);
  const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all();
  for (const { name } of triggers) db.exec('DROP TRIGGER "' + name + '"');
  for (const sql of [
    "INSERT INTO map_graph_station SELECT * FROM map_graph_station",
    "UPDATE map_graph_station SET ordinal=-1 WHERE ordinal=0",
    "UPDATE map_graph_station SET ordinal='not integer' WHERE ordinal=0",
    "UPDATE map_graph_station SET station_id='B',source_id='B' WHERE ordinal=0",
    "UPDATE map_graph_alias SET alias_key='second',source_id='second' WHERE ordinal=1",
    "UPDATE map_graph_edge SET endpoint_b='absent' WHERE ordinal=0",
    "UPDATE map_graph_excluded_skipped_code SET skipped_ordinal=99",
    "UPDATE map_graph_excluded SET reason=NULL WHERE ordinal=0",
    "UPDATE map_graph_excluded SET missing_presence='present' WHERE ordinal=0",
    "UPDATE map_graph_hub_evidence SET edition_id='other'",
  ]) assert.throws(() => db.exec(sql), error => error.code === "ERR_SQLITE_ERROR");
});

test("reader rejects corrupted values, counts, presence, identities and complete ordered children", t => {
  const mutations = [
    "DELETE FROM map_graph_station WHERE ordinal=4",
    "UPDATE map_graph_station SET lat=1 WHERE ordinal=0",
    "UPDATE map_graph_station SET lat_text='37.1250' WHERE ordinal=0",
    "UPDATE map_graph_alias SET ordinal=5 WHERE ordinal=1",
    "UPDATE map_graph_excluded SET reason_presence='missing', reason=NULL WHERE ordinal=0",
    "UPDATE map_graph_excluded SET missing_presence='missing' WHERE ordinal=3",
    "UPDATE map_graph_excluded SET reason='not null' WHERE ordinal=1",
    "UPDATE map_graph_excluded SET support_no_surface_adjacency_inference=2 WHERE ordinal=0",
    "UPDATE map_graph_excluded_skipped_code SET ordinal=4 WHERE ordinal=2",
    "UPDATE map_graph_excluded_skipped_station SET skipped_ordinal=99",
    "UPDATE map_graph_hub_evidence SET hub_ordinal=99",
    "UPDATE map_graph_edge SET endpoint_b='missing' WHERE ordinal=0",
    "UPDATE map_graph_station SET source_id='forged' WHERE ordinal=0",
    "UPDATE map_graph_import SET document_sha256='" + "0".repeat(64) + "'",
    "UPDATE map_graph_seal SET graph_semantic_sha256='" + "0".repeat(64) + "'",
    "DELETE FROM map_graph_seal",
  ];
  for (const sql of mutations) {
    const db = database(t), input = inputs(); importGraphEdition(db, input);
    corrupt(db, d => d.exec(sql)); rejected(() => readGraphEdition(db, request(input)));
  }
});

test("schema drift, disabled FKs, nonempty initialization and attached namespaces fail closed", t => {
  const db = database(t), input = inputs(); importGraphEdition(db, input);
  rejected(() => initializeGraphStore(db));
  db.exec("PRAGMA foreign_keys=OFF"); rejected(() => readGraphEdition(db, request(input))); db.exec("PRAGMA foreign_keys=ON");
  db.exec("CREATE TABLE foreign_data(value TEXT)"); rejected(() => readGraphEdition(db, request(input))); db.exec("DROP TABLE foreign_data");
  db.exec("ALTER TABLE map_graph_station ADD COLUMN unknown TEXT"); rejected(() => readGraphEdition(db, request(input)));
  const attached = database(t); attached.exec("ATTACH DATABASE ':memory:' AS other"); rejected(() => importGraphEdition(attached, inputs()));
});

test("same IDs are separate per edition; cross-edition child references cannot satisfy a parent", t => {
  const db = database(t), first = inputs(), second = inputs(fixture(), "second");
  importGraphEdition(db, first); importGraphEdition(db, second);
  assert.equal(count(db, "map_graph_station"), 10);
  assert.deepEqual(readGraphEdition(db, request(first)).document, readGraphEdition(db, request(second)).document);
  corrupt(db, d => d.exec("UPDATE map_graph_excluded_skipped_code SET edition_id='absent' WHERE edition_id='second'"));
  rejected(() => readGraphEdition(db, request(second)));
});

test("semantic hashing preserves source order and evidence while excluding import provenance", t => {
  const original = inputs(), firstDb = database(t); importGraphEdition(firstDb, original);
  const baseline = readGraphEdition(firstDb, request(original)).graphSemanticSha256;
  for (const mutate of [
    d => { d.edges[0].b = "C"; },
    d => { d.aliases = { first: "A", second: "B" }; },
    d => { d.source.railAdjacency.replacements[0].officialCodes.reverse(); },
    d => { d.source.railAdjacency.hubIdentities[0].evidence.reverse(); },
    d => { d.source.railAdjacency.excluded[0].reason = "changed"; },
    d => { d.source.railAdjacency.officialSource.retrievedAt = "another date"; },
    d => {
      const { support: evidence, ...fields } = d.source.railAdjacency.excluded[2];
      d.source.railAdjacency.excluded[2] = { ...fields, reason: null, support: evidence };
    },
  ]) {
    const document = fixture(); mutate(document); const input = inputs(document), db = database(t);
    const result = importGraphEdition(db, input); assert.notEqual(result.graphSemanticSha256, baseline);
  }
  const changed = inputs(); changed.sourceReceipt.actor = "another actor";
  changed.expectedBinding.source_revision = "another source-delivery revision";
  const db = database(t); assert.equal(importGraphEdition(db, changed).graphSemanticSha256, baseline);
});

test("repacking and reversed physical insertion retain semantic identity and payload", t => {
  const db = database(t), input = inputs(); importGraphEdition(db, input);
  const before = readGraphEdition(db, request(input)), bytes = db.serialize();
  corrupt(db, d => {
    const rows = d.prepare("SELECT * FROM map_graph_hub_evidence ORDER BY ordinal DESC").all();
    d.exec("DELETE FROM map_graph_hub_evidence");
    for (const row of rows) {
      const keys = Object.keys(row);
      d.prepare("INSERT INTO map_graph_hub_evidence (" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")").run(...Object.values(row));
    }
  });
  db.exec("PRAGMA page_size=8192; VACUUM");
  assert.notEqual(sha(db.serialize()), sha(bytes));
  const after = readGraphEdition(db, request(input));
  assert.equal(after.graphSemanticSha256, before.graphSemanticSha256);
  assert.deepEqual(encodeGraphPayload(after.document), encodeGraphPayload(before.document));
});
