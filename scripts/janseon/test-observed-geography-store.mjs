import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { semanticDigest } from "./canonical.mjs";
import { initializeGraphStore, importGraphEdition, readGraphEdition } from "./graph-store.mjs";
import { initializeObservedGeographyStore, importObservedGeographyEdition, readObservedGeographyEdition,
  observedGeographySemanticProjection, encodeObservedGeometryPayload } from "./observed-geography-store.mjs";

// Independently enumerated source census: 18 tables / 85 columns; no source geodata.
const COLUMNS = {
  boundary_geometry_source: "source_path sha256 collection_type",
  boundary_geometry_feature: "id ordinal feature_type geometry_type kind source_edition official_code official_name dong_id electoral_dong_id county_title_id gu_id name",
  boundary_geometry_property: "feature_id ordinal name",
  boundary_geometry_dong: "feature_id ordinal code",
  boundary_geometry_gu: "feature_id ordinal gu_ref",
  boundary_geometry_polygon: "feature_id ordinal",
  boundary_geometry_ring: "feature_id polygon_ordinal ordinal",
  boundary_geometry_point: "feature_id polygon_ordinal ring_ordinal ordinal longitude latitude",
  geography_spatial: "singleton edition baseDate authority legalSurveyCertification current2026Geometry archiveSha256",
  geography_spatial_geometry: "singleton path sha256 crs features",
  geography_county: "edition countyTitleId ordinal",
  geography_slot: "edition countyTitleId ordinal slotId dongId name jurisdictionGuRef electoralDongId fragmentId sourceEdition sourcePointer geometryVerified",
  geography_slot_source: "edition slotId ordinal ref",
  geography_slot_geometry: "edition slotId ordinal ref",
  geography_edition: "kind id electionDate seoulCompositionMatchesCurrentAppendix",
  geography_edition_source: "kind ordinal ref",
  geography_source_record: "ordinal id sha256 role",
  geography_evidence: "kind path sha256",
};
const central = source => "map_observed_" + ({ geography_edition: "electoral_edition",
  geography_edition_source: "electoral_source" }[source] ?? source.replace("boundary_geometry_", "boundary_").replace("geography_", ""));
const sha = value => createHash("sha256").update(value).digest("hex");
const request = input => ({ datasetId: input.expectedBinding.dataset_id, editionId: input.expectedBinding.edition_id, expectedBinding: input.expectedBinding });
const count = (db, table) => db.prepare("SELECT count(*) AS n FROM " + table).get().n;
const rejected = action => assert.throws(action, error => /^(E_OBSERVED_|ERR_SQLITE)/.test(error.code ?? "") || error instanceof TypeError);

function fixture(edition = "test-edition") {
  const rows = Object.fromEntries(Object.keys(COLUMNS).map(name => [name, []]));
  const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
  const outer = square(127, 37, 0.125), hole = square(127.03125, 37.03125, 0.03125);
  const features = [
    ["dong:\u00e9", "dong", { official_code: "001", official_name: "Alpha", dong_id: "\u00e9", electoral_dong_id: "electoral:A", county_title_id: "county:A", gu_id: "gu:A" }],
    ["dong:e\u0301", "dong", { official_code: "002", official_name: "Beta", dong_id: "e\u0301", electoral_dong_id: "electoral:B", county_title_id: "county:A", gu_id: "gu:B" }],
    ["county:A", "county", { county_title_id: "county:A", name: "County" }],
    ["gu:A", "gu", { gu_id: "gu:A", name: "A" }],
    ["gu:B", "gu", { gu_id: "gu:B", name: "B" }],
    ["city", "city", { official_code: "11", official_name: null }],
  ];
  const properties = { kind: "kind", source_edition: "sourceEdition", official_code: "officialCode", official_name: "officialName",
    dong_id: "dongId", electoral_dong_id: "electoralDongId", county_title_id: "countyTitleId", gu_id: "guId", name: "name" };
  for (const [ordinal, [id, kind, values]] of features.entries()) {
    const feature = { id, ordinal, feature_type: "Feature", geometry_type: ordinal === 1 ? "MultiPolygon" : "Polygon", kind,
      source_edition: edition, official_code: null, official_name: null, dong_id: null, electoral_dong_id: null,
      county_title_id: null, gu_id: null, name: null, ...values };
    rows.boundary_geometry_feature.push(feature);
    const names = ["kind", "sourceEdition", ...Object.keys(values).map(name => properties[name])];
    if (kind === "county") names.push("officialDongCodes", "jurisdictionGuRefs");
    if (kind === "city") names.push("officialDongCodes"); // Present empty list, not absent.
    names.forEach((name, ordinal) => rows.boundary_geometry_property.push({ feature_id: id, ordinal, name }));
    const polygons = ordinal === 1 ? [[outer, hole], [square(127.25, 37.25, 0.125)]] : [[outer, hole]];
    polygons.forEach((rings, polygon_ordinal) => {
      rows.boundary_geometry_polygon.push({ feature_id: id, ordinal: polygon_ordinal });
      rings.forEach((points, ring_ordinal) => {
        rows.boundary_geometry_ring.push({ feature_id: id, polygon_ordinal, ordinal: ring_ordinal });
        points.forEach(([longitude, latitude], ordinal) => rows.boundary_geometry_point.push({ feature_id: id, polygon_ordinal, ring_ordinal, ordinal, longitude, latitude }));
      });
    });
  }
  rows.boundary_geometry_dong = ["001", "002"].map((code, ordinal) => ({ feature_id: "county:A", ordinal, code }));
  rows.boundary_geometry_gu = ["gu:A", "gu:B"].map((gu_ref, ordinal) => ({ feature_id: "county:A", ordinal, gu_ref }));
  rows.boundary_geometry_source = [{ source_path: "synthetic/geometry.geojson", sha256: "a".repeat(64), collection_type: "FeatureCollection" }];
  rows.geography_spatial = [{ singleton: 1, edition, baseDate: "2025-06-30", authority: "official-SGIS-statistical-boundary",
    legalSurveyCertification: 0, current2026Geometry: 0, archiveSha256: "b".repeat(64) }];
  rows.geography_spatial_geometry = [{ singleton: 1, path: "synthetic/geometry.geojson", sha256: "a".repeat(64), crs: "OGC:CRS84", features: features.length }];
  rows.geography_county = [{ edition: "dated", countyTitleId: "county:A", ordinal: 0 }];
  rows.geography_slot = rows.boundary_geometry_feature.slice(0, 2).map((dong, ordinal) => ({ edition: "dated", countyTitleId: "county:A", ordinal,
    slotId: "slot:" + dong.dong_id, dongId: dong.dong_id, name: dong.official_name, jurisdictionGuRef: dong.gu_id,
    electoralDongId: dong.electoral_dong_id, fragmentId: null, sourceEdition: edition, sourcePointer: "/constituencies/0/electoralDongs/" + ordinal, geometryVerified: 1 }));
  for (const [index, slot] of rows.geography_slot.entries()) {
    rows.geography_slot_geometry.push({ edition: "dated", slotId: slot.slotId, ordinal: 0, ref: rows.boundary_geometry_feature[index].id });
    for (let ordinal = 0; ordinal < 2; ordinal++) rows.geography_slot_source.push({ edition: "dated", slotId: slot.slotId, ordinal, ref: "source:A" });
  }
  rows.geography_edition = [{ kind: "electoral", id: "election:2024", electionDate: "2024-04-10", seoulCompositionMatchesCurrentAppendix: 1 }];
  rows.geography_edition_source = [{ kind: "electoral", ordinal: 0, ref: "source:B" }];
  rows.geography_source_record = [{ ordinal: 2, id: "source:A", sha256: "c".repeat(64), role: "statutory-electoral-membership" },
    { ordinal: 7, id: "source:B", sha256: "d".repeat(64), role: "electoral-edition" }];
  rows.geography_evidence = [{ kind: "membership", path: "synthetic/membership.json", sha256: "e".repeat(64) },
    { kind: "spatial", path: "synthetic/spatial.json", sha256: "f".repeat(64) }];
  return rows;
}

function inputs(rows = fixture(), datasetId = "synthetic:geography") {
  const editionId = rows.geography_spatial[0].edition;
  const expectedBinding = { dataset_id: datasetId, edition_id: editionId,
    schema_contract: "janseon-observed-geography-store.v1", projection_contract: "janseon-observed-geography-semantic.v1",
    expected_projection_sha256: semanticDigest(observedGeographySemanticProjection({ datasetId, editionId, rows })),
    source_package_content_id: "synthetic-package", source_authentication_receipt_sha256: "1".repeat(64), source_revision: "synthetic-revision",
    source_reader_closure_sha256: "2".repeat(64), source_schema_closure_sha256: "3".repeat(64), field_disposition_sha256: "4".repeat(64),
    rights_receipt_content_id: "synthetic-not-approval", original_geometry_sha256: rows.boundary_geometry_source[0].sha256,
    original_spatial_sha256: rows.geography_evidence.find(row => row.kind === "spatial").sha256,
    original_membership_sha256: rows.geography_evidence.find(row => row.kind === "membership").sha256,
    original_geography_archive_sha256: "5".repeat(64) };
  return { rows, expectedBinding };
}

function database(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  initializeObservedGeographyStore(db); return db;
}

function corrupt(db, change) {
  const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'").all();
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
  for (const { name } of triggers) db.exec('DROP TRIGGER "' + name + '"');
  try { change(db); } finally {
    for (const { sql } of triggers) db.exec(sql);
    db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
  }
}

test("20 STRICT tables cover exactly 18 source families and 85 columns", t => {
  const db = database(t), input = inputs(), before = structuredClone(input);
  const result = importObservedGeographyEdition(db, input), read = readObservedGeographyEdition(db, request(input));
  assert.deepEqual(input, before);
  assert.deepEqual(read.rows, observedGeographySemanticProjection({ datasetId: input.expectedBinding.dataset_id,
    editionId: input.expectedBinding.edition_id, rows: input.rows }).rows);
  assert.equal(result.observedGeographySemanticSha256, input.expectedBinding.expected_projection_sha256);
  const tables = db.prepare("PRAGMA table_list").all().filter(row => row.name.startsWith("map_observed_"));
  assert.equal(tables.length, 20); assert.ok(tables.every(row => row.strict === 1));
  let count = 0;
  for (const [source, columns] of Object.entries(COLUMNS)) {
    const actual = db.prepare("PRAGMA table_info(" + central(source) + ")").all().map(row => row.name)
      .filter(name => !["dataset_id", "edition_id", "longitude_text", "latitude_text"].includes(name));
    assert.deepEqual(actual, columns.split(" "), source); count += actual.length;
  }
  assert.equal(count, 85); assert.equal(Object.keys(COLUMNS).length, 18);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.isTransaction, false);
  assert.deepEqual(encodeObservedGeometryPayload(read.geometry), Buffer.from(JSON.stringify(read.geometry) + "\n"));
});

test("rings, holes, Unicode, ordered references and property presence survive", t => {
  const db = database(t), input = inputs(); importObservedGeographyEdition(db, input);
  const { rows, geometry } = readObservedGeographyEdition(db, request(input));
  assert.equal(geometry.features[0].geometry.coordinates.length, 2);
  assert.equal(geometry.features[1].geometry.coordinates.length, 2);
  assert.equal(geometry.features[1].geometry.coordinates[0].length, 2);
  assert.deepEqual(geometry.features[0].geometry.coordinates[0][0], geometry.features[0].geometry.coordinates[0].at(-1));
  assert.notEqual(rows.geography_slot[0].dongId, rows.geography_slot[1].dongId);
  assert.deepEqual(geometry.features[2].properties.officialDongCodes, ["001", "002"]);
  assert.deepEqual(geometry.features[2].properties.jurisdictionGuRefs, ["gu:A", "gu:B"]);
  assert.equal(Object.hasOwn(geometry.features[3].properties, "officialName"), false);
  assert.equal(geometry.features[5].properties.officialName, null);
  assert.deepEqual(geometry.features[5].properties.officialDongCodes, []);
  assert.deepEqual(rows.geography_source_record.map(row => row.ordinal), [2, 7]);
  assert.equal(rows.geography_slot_source.filter(row => row.slotId === "slot:\u00e9").length, 2);
  assert.equal(rows.geography_edition[0].electionDate, "2024-04-10");
  assert.doesNotMatch(JSON.stringify(rows), /holderPersonId|kingdomStatus|private-sentinel|movementEdges/);
});

test("malformed typed shapes, geometry, joins and unconsumed rows reject before writes", t => {
  const db = database(t);
  const changes = [
    r => { r.unknown = []; }, r => { r.geography_slot[0].holderPersonId = "private-sentinel"; },
    r => { delete r.geography_slot[0].fragmentId; }, r => { r.geography_slot[0].fragmentId = "fragment"; },
    r => { r.geography_slot[0].geometryVerified = 0; }, r => { r.geography_slot[0].edition = "current"; },
    r => { r.geography_county[0].edition = "current"; }, r => { r.geography_edition[0].kind = "currentLaw"; },
    r => { r.geography_evidence.push({ ...r.geography_evidence[0], kind: "rights" }); },
    r => { r.geography_spatial_geometry[0].crs = "EPSG:4326"; }, r => { r.geography_spatial[0].current2026Geometry = 1; },
    r => { r.geography_spatial[0].edition = "other"; }, r => { r.geography_spatial[0].baseDate = "unknown"; },
    r => { r.boundary_geometry_feature[0].geometry_type = "Point"; }, r => { r.boundary_geometry_feature[0].geometry_type = "LineString"; },
    r => { r.boundary_geometry_feature[1].geometry_type = "Polygon"; }, r => { r.boundary_geometry_feature[0].kind = "political"; },
    r => { r.boundary_geometry_feature[0].source_edition = "other"; }, r => { r.boundary_geometry_feature[0].official_name = "mismatch"; },
    r => { r.boundary_geometry_feature[0].official_code = "002"; }, r => { r.boundary_geometry_feature[0].name = "hidden"; },
    r => { r.boundary_geometry_property[0].name = "unknown"; }, r => { r.boundary_geometry_property[1].name = "kind"; },
    r => { r.boundary_geometry_property[0].ordinal = 99; }, r => { r.boundary_geometry_property.pop(); },
    r => { r.boundary_geometry_dong[0].code = "unknown"; }, r => { r.boundary_geometry_gu[0].gu_ref = "unknown"; },
    r => { r.boundary_geometry_gu.push({ feature_id: "missing", ordinal: 0, gu_ref: "gu:A" }); },
    r => { r.boundary_geometry_polygon[0].ordinal = 5; }, r => { r.boundary_geometry_polygon = []; },
    r => { r.boundary_geometry_ring = []; }, r => { r.boundary_geometry_ring[0].polygon_ordinal = 7; },
    r => { r.boundary_geometry_point[0].longitude += 0.5; }, r => { r.boundary_geometry_point[0].latitude = 127; },
    r => { r.boundary_geometry_point[0].longitude = -181; }, r => { r.boundary_geometry_point[0].longitude = NaN; },
    r => { r.boundary_geometry_point[0].longitude = Infinity; }, r => { r.boundary_geometry_point[0].longitude = -0; },
    r => { r.boundary_geometry_point[0].z = 0; }, r => { r.boundary_geometry_point[0].ring_ordinal = 99; },
    r => { r.boundary_geometry_point.splice(1, 1); }, r => { r.boundary_geometry_point[0].ordinal = 9; },
    r => { r.boundary_geometry_point.push({ ...r.boundary_geometry_point[0] }); },
    r => { r.geography_slot[0].jurisdictionGuRef = "unknown"; }, r => { r.geography_slot[0].countyTitleId = "unknown"; },
    r => { r.geography_slot[0].dongId = r.geography_slot[1].dongId; }, r => { r.geography_slot.pop(); },
    r => { r.geography_slot_source[0].ref = "unknown"; }, r => { r.geography_slot_geometry[0].ref = "city"; },
    r => { r.geography_edition_source[0].kind = "current"; }, r => { r.geography_source_record.push({ ordinal: 10, id: "unused", sha256: "a".repeat(64), role: "extra" }); },
    r => { r.geography_source_record[0].ordinal = 7; }, r => { r.geography_source_record[0].sha256 = "wrong"; },
    r => { r.geography_slot[0].name = "\ud800"; }, r => { r.geography_slot[0].name = "bad\0name"; },
    r => { delete r.boundary_geometry_point[0]; }, r => { r.boundary_geometry_point.extra = 1; },
    r => { r.boundary_geometry_feature[0].ordinal = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const change of changes) {
    const input = inputs(); change(input.rows);
    rejected(() => importObservedGeographyEdition(db, input));
    assert.equal(count(db, "map_observed_binding"), 0);
  }
});

test("binding is exact and production cannot be admitted by forged receipt or copied pins", t => {
  const db = database(t);
  for (const change of [
    i => { i.expectedBinding.authenticated = true; }, i => { delete i.expectedBinding.source_revision; },
    i => { i.expectedBinding.source_reader_closure_sha256 = "x"; }, i => { i.expectedBinding.source_package_content_id = "/private/path"; },
    i => { i.expectedBinding.rights_receipt_content_id = "C:private"; }, i => { i.expectedBinding.schema_contract = "future"; },
    i => { i.expectedBinding.expected_projection_sha256 = "0".repeat(64); },
    i => { i.expectedBinding.original_geometry_sha256 = "0".repeat(64); },
    i => { i.expectedBinding.original_spatial_sha256 = "0".repeat(64); },
    i => { i.expectedBinding.dataset_id = "seoul-observed-geography"; },
  ]) { const input = inputs(); change(input); rejected(() => importObservedGeographyEdition(db, input)); }
  const production = inputs(); production.expectedBinding.dataset_id = "seoul-observed-geography";
  production.expectedBinding.edition_id = "sgis-20250630";
  production.expectedBinding.original_geometry_sha256 = "6a393cefb7cc257f001042acb8715e5d721b320e14eba723f15857197edaa5e4";
  assert.throws(() => importObservedGeographyEdition(db, production), { code: "E_OBSERVED_ADMISSION" });
  assert.equal(count(db, "map_observed_binding"), 0);
  const input = inputs(); importObservedGeographyEdition(db, input);
  rejected(() => readObservedGeographyEdition(db, { ...request(input), editionId: "absent" }));
  rejected(() => readObservedGeographyEdition(db, { ...request(input), expectedBinding: { ...input.expectedBinding, source_revision: "stale" } }));
});

test("reserved SGIS projection checks exact 426/48/25/1 counts and all original source pins without admitting it", t => {
  // Fabricated identifiers and square geometry only; never actual source rows.
  const rows = fixture("sgis-20250630"), base = structuredClone(rows);
  for (const name of Object.keys(rows)) if (name.startsWith("boundary_geometry_") && name !== "boundary_geometry_source") rows[name] = [];
  for (const name of ["geography_county", "geography_slot", "geography_slot_source", "geography_slot_geometry"]) rows[name] = [];
  function feature(id, kind, values) {
    const template = base.boundary_geometry_feature.find(row => row.kind === kind);
    const row = { ...template, ...values, id, ordinal: rows.boundary_geometry_feature.length, geometry_type: "Polygon" };
    rows.boundary_geometry_feature.push(row);
    for (const property of base.boundary_geometry_property.filter(p => p.feature_id === template.id)) {
      rows.boundary_geometry_property.push({ ...property, feature_id: id });
    }
    rows.boundary_geometry_polygon.push({ feature_id: id, ordinal: 0 });
    rows.boundary_geometry_ring.push({ feature_id: id, polygon_ordinal: 0, ordinal: 0 });
    for (const point of base.boundary_geometry_point.filter(p => p.feature_id === template.id && p.polygon_ordinal === 0 && p.ring_ordinal === 0)) {
      rows.boundary_geometry_point.push({ ...point, feature_id: id });
    }
  }
  for (let i = 0; i < 25; i++) feature("fabricated:gu:" + i, "gu", { gu_id: "fabricated:gu:" + i, name: "Gu " + i });
  for (let i = 0; i < 48; i++) {
    const id = "fabricated:county:" + i;
    feature(id, "county", { county_title_id: id, name: "County " + i });
    rows.geography_county.push({ edition: "dated", countyTitleId: id, ordinal: i });
  }
  const countyMembers = new Map();
  for (let i = 0; i < 426; i++) {
    const county = "fabricated:county:" + i % 48, gu = "fabricated:gu:" + i % 25;
    const id = "fabricated:dong:" + i, code = "code:" + i, slot = "fabricated:slot:" + i;
    const members = countyMembers.get(county) ?? []; countyMembers.set(county, members);
    const ordinal = members.length; members.push({ code, gu });
    feature(id, "dong", { official_code: code, official_name: "Dong " + i, dong_id: id,
      electoral_dong_id: "fabricated:electoral:" + i, county_title_id: county, gu_id: gu });
    rows.geography_slot.push({ edition: "dated", countyTitleId: county, ordinal, slotId: slot, dongId: id, name: "Dong " + i,
      jurisdictionGuRef: gu, electoralDongId: "fabricated:electoral:" + i, fragmentId: null, sourceEdition: "sgis-20250630",
      sourcePointer: "/fabricated/" + i, geometryVerified: 1 });
    rows.geography_slot_source.push({ edition: "dated", slotId: slot, ordinal: 0, ref: "source:A" });
    rows.geography_slot_geometry.push({ edition: "dated", slotId: slot, ordinal: 0, ref: id });
  }
  for (const [county, members] of countyMembers) {
    members.forEach(({ code }, ordinal) => rows.boundary_geometry_dong.push({ feature_id: county, ordinal, code }));
    [...new Set(members.map(row => row.gu))].forEach((gu_ref, ordinal) => rows.boundary_geometry_gu.push({ feature_id: county, ordinal, gu_ref }));
  }
  feature("fabricated:city", "city", {});
  const pins = {
    geometry: ["data/geography/boundaries/seoul-sgis-20250630.geojson", "6a393cefb7cc257f001042acb8715e5d721b320e14eba723f15857197edaa5e4"],
    membership: ["data/geography/elections/sources/seoul-constituency-membership.json", "5c082aad68af1145dca138d8bf048a9b16e5a13b8618aa7c8c2e79bfc3db74f1"],
    spatial: ["data/geography/elections/sources/seoul-sgis-20250630.json", "389b1eabee54cddc965dd523c3b831cdc60ea72d180cab908295c3359a8045ad"],
  };
  Object.assign(rows.boundary_geometry_source[0], { source_path: pins.geometry[0], sha256: pins.geometry[1] });
  Object.assign(rows.geography_spatial_geometry[0], { path: pins.geometry[0], sha256: pins.geometry[1], features: 500 });
  for (const row of rows.geography_evidence) Object.assign(row, { path: pins[row.kind][0], sha256: pins[row.kind][1] });
  const project = value => observedGeographySemanticProjection({ datasetId: "seoul-observed-geography", editionId: "sgis-20250630", rows: value });
  assert.equal(project(rows).rows.boundary_geometry_feature.length, 500);
  for (const mutate of [r => { r.geography_spatial[0].baseDate = "2026-06-30"; },
    r => { r.boundary_geometry_source[0].sha256 = r.geography_spatial_geometry[0].sha256 = "0".repeat(64); },
    r => { r.geography_evidence[0].sha256 = "0".repeat(64); }, r => { r.geography_evidence[1].sha256 = "0".repeat(64); },
    r => { r.geography_evidence[0].path = "wrong"; }, r => { r.geography_slot.pop(); }]) {
    const changed = structuredClone(rows); mutate(changed); rejected(() => project(changed));
  }
  const input = inputs(rows, "seoul-observed-geography");
  assert.throws(() => importObservedGeographyEdition(database(t), input), { code: "E_OBSERVED_ADMISSION" });
});

test("immutable guards protect all 20 tables including REPLACE and row moves", t => {
  const db = database(t), input = inputs(); importObservedGeographyEdition(db, input);
  assert.equal(db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
  const bytes = db.serialize();
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
    assert.ok(count(db, name), name);
    for (const sql of ["UPDATE " + name + " SET edition_id='unsealed'", "DELETE FROM " + name,
      "INSERT INTO " + name + " SELECT * FROM " + name, "INSERT OR REPLACE INTO " + name + " SELECT * FROM " + name,
      "REPLACE INTO " + name + " SELECT * FROM " + name]) {
      assert.throws(() => db.exec(sql), /immutable observed edition/); assert.deepEqual(db.serialize(), bytes);
    }
  }
  const next = inputs(fixture("second")); importObservedGeographyEdition(db, next);
  assert.equal(count(db, "map_observed_seal"), 2);
  rejected(() => importObservedGeographyEdition(db, input));
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("INSERT INTO map_observed_boundary_dong SELECT dataset_id,'unsealed',feature_id,ordinal,code FROM map_observed_boundary_dong WHERE edition_id='test-edition'");
  assert.throws(() => db.exec("UPDATE map_observed_boundary_dong SET edition_id='test-edition' WHERE edition_id='unsealed'"), /immutable observed edition/);
});

test("savepoint ownership and late rollback preserve caller state and existing editions", t => {
  const db = database(t), first = inputs();
  db.exec("BEGIN; SAVEPOINT caller"); importObservedGeographyEdition(db, first);
  rejected(() => importObservedGeographyEdition(db, first));
  importObservedGeographyEdition(db, inputs(fixture("second")));
  assert.equal(db.isTransaction, true); assert.equal(count(db, "map_observed_seal"), 2);
  db.exec("ROLLBACK TO caller; RELEASE caller; COMMIT"); assert.equal(count(db, "map_observed_seal"), 0);
  importObservedGeographyEdition(db, first);
  corrupt(db, connection => connection.exec("UPDATE map_observed_boundary_point SET ring_ordinal=99 WHERE ordinal=0 AND ring_ordinal=0"));
  for (const caller of [false, true]) {
    if (caller) db.exec("BEGIN; SAVEPOINT caller");
    rejected(() => importObservedGeographyEdition(db, inputs(fixture("late"))));
    assert.equal(db.isTransaction, caller); assert.equal(count(db, "map_observed_binding"), 1);
    assert.equal(count(db, "map_observed_seal"), 1);
    if (caller) db.exec("ROLLBACK TO caller; RELEASE caller; ROLLBACK");
  }
  const fresh = new DatabaseSync(":memory:"); t.after(() => fresh.close());
  fresh.exec("PRAGMA foreign_keys=ON; BEGIN; SAVEPOINT caller"); initializeObservedGeographyStore(fresh);
  fresh.exec("ROLLBACK TO caller; RELEASE caller; COMMIT");
  assert.equal(count(fresh, "sqlite_schema"), 0);
});

test("schema drift, extra namespaces and disabled FKs fail closed", t => {
  for (const sql of ["CREATE TABLE other(x TEXT)", "CREATE VIEW other AS SELECT 1", "CREATE TEMP TABLE other(x TEXT)",
    "ATTACH DATABASE ':memory:' AS other", "PRAGMA foreign_keys=OFF", "ALTER TABLE map_observed_slot ADD COLUMN unknown TEXT",
    "DROP TRIGGER map_observed_seal_immutable_INSERT"]) {
    const db = database(t), input = inputs(); importObservedGeographyEdition(db, input); db.exec(sql);
    rejected(() => readObservedGeographyEdition(db, request(input)));
    rejected(() => importObservedGeographyEdition(db, inputs(fixture("other"))));
  }
  const db = database(t); rejected(() => initializeObservedGeographyStore(db));
});

test("SQL constraints and composite references reject direct malformed rows", t => {
  const db = database(t), input = inputs(); importObservedGeographyEdition(db, input);
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all()) db.exec('DROP TRIGGER "' + name + '"');
  for (const sql of ["UPDATE map_observed_boundary_point SET ring_ordinal=999", "UPDATE map_observed_slot_geometry SET edition_id='missing'",
    "UPDATE map_observed_slot SET fragmentId='unknown'", "UPDATE map_observed_county SET edition='current'",
    "UPDATE map_observed_boundary_point SET ordinal=-1", "UPDATE map_observed_boundary_point SET latitude=127",
    "UPDATE map_observed_boundary_feature SET geometry_type='Point'", "UPDATE map_observed_electoral_edition SET electionDate=NULL",
    "INSERT INTO map_observed_source_record SELECT * FROM map_observed_source_record"]) {
    assert.throws(() => db.exec(sql), error => error.code === "ERR_SQLITE_ERROR");
  }
});

test("restored-schema corruption cannot bypass typed readback, full consumption or seals", t => {
  for (const sql of ["UPDATE map_observed_boundary_point SET longitude=1 WHERE ordinal=0",
    "UPDATE map_observed_boundary_point SET longitude_text='127.000' WHERE ordinal=0",
    "UPDATE map_observed_boundary_ring SET ordinal=99 WHERE ordinal=1",
    "UPDATE map_observed_boundary_property SET name='unknown' WHERE ordinal=0",
    "UPDATE map_observed_boundary_feature SET official_name='changed' WHERE kind='dong'",
    "UPDATE map_observed_source_record SET sha256='bad'", "DELETE FROM map_observed_seal",
    "UPDATE map_observed_seal SET observed_semantic_sha256='" + "0".repeat(64) + "'",
    "DELETE FROM map_observed_boundary_point WHERE feature_id='city' AND ring_ordinal=1; DELETE FROM map_observed_boundary_ring WHERE feature_id='city' AND ordinal=1",
    "UPDATE map_observed_boundary_point SET edition_id='missing' WHERE ordinal=0"]) {
    const db = database(t), input = inputs(); importObservedGeographyEdition(db, input);
    corrupt(db, connection => connection.exec(sql)); rejected(() => readObservedGeographyEdition(db, request(input)));
  }
});

test("semantic facts change identity while delivery receipts and physical layout do not", t => {
  const input = inputs(), db = database(t); importObservedGeographyEdition(db, input);
  const before = readObservedGeographyEdition(db, request(input)), bytes = db.serialize();
  for (const change of [r => { r.geography_spatial[0].baseDate = "2025-07-01"; },
    r => { r.geography_edition[0].electionDate = "2024-04-11"; },
    r => { r.geography_spatial[0].archiveSha256 = "9".repeat(64); },
    r => { r.geography_source_record[0].sha256 = "9".repeat(64); },
    r => { const p = r.boundary_geometry_property.filter(row => row.feature_id === "city"); [p[0].ordinal, p[1].ordinal] = [p[1].ordinal, p[0].ordinal]; },
    r => { r.boundary_geometry_feature.at(-1).official_name = "City"; },
    r => { for (const p of r.boundary_geometry_point) p.longitude += 0.125; },
  ]) {
    const rows = fixture(); change(rows); const changed = inputs(rows), other = database(t);
    assert.notEqual(importObservedGeographyEdition(other, changed).observedGeographySemanticSha256, before.observedGeographySemanticSha256);
  }
  const changed = inputs(); changed.expectedBinding.source_revision = "another-delivery";
  changed.expectedBinding.original_geography_archive_sha256 = "9".repeat(64);
  changed.expectedBinding.source_package_content_id = "other-package";
  assert.equal(importObservedGeographyEdition(database(t), changed).observedGeographySemanticSha256, before.observedGeographySemanticSha256);
  corrupt(db, connection => {
    const points = connection.prepare("SELECT * FROM map_observed_boundary_point ORDER BY ordinal DESC").all();
    connection.exec("DELETE FROM map_observed_boundary_point");
    for (const row of points) {
      const names = Object.keys(row);
      connection.prepare("INSERT INTO map_observed_boundary_point (" + names.join(",") + ") VALUES (" + names.map(() => "?").join(",") + ")").run(...Object.values(row));
    }
  });
  db.exec("PRAGMA page_size=8192; VACUUM"); assert.notEqual(sha(db.serialize()), sha(bytes));
  const after = readObservedGeographyEdition(db, request(input));
  assert.equal(after.observedGeographySemanticSha256, before.observedGeographySemanticSha256);
  assert.deepEqual(encodeObservedGeometryPayload(after.geometry), encodeObservedGeometryPayload(before.geometry));
  const reversed = inputs(); Object.values(reversed.rows).forEach(rows => rows.reverse());
  assert.equal(importObservedGeographyEdition(database(t), reversed).observedGeographySemanticSha256, before.observedGeographySemanticSha256);
});

test("file reopen reconstructs without source filesystem or JSON parsing", t => {
  const directory = fs.mkdtempSync(join(tmpdir(), "observed-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "synthetic.sqlite"), input = inputs();
  const writer = new DatabaseSync(path); initializeObservedGeographyStore(writer); importObservedGeographyEdition(writer, input); writer.close();
  const db = new DatabaseSync(path, { readOnly: true }); t.after(() => db.close()); db.exec("PRAGMA foreign_keys=ON");
  const readFile = fs.readFileSync, parse = JSON.parse;
  let result;
  try {
    fs.readFileSync = () => { throw Error("filesystem forbidden"); }; syncBuiltinESMExports();
    JSON.parse = () => { throw Error("JSON parser forbidden"); };
    const guarded = { prepare(sql) { assert.match(sql, /^(SELECT|PRAGMA) /); assert.doesNotMatch(sql, /archive|source_file/); return db.prepare(sql); } };
    result = readObservedGeographyEdition(guarded, request(input));
  } finally { fs.readFileSync = readFile; syncBuiltinESMExports(); JSON.parse = parse; }
  assert.equal(result.geometry.features.length, 6);
  assert.throws(() => db.exec("CREATE TABLE forbidden(x TEXT)"), /readonly|read-only/i);
});

test("separate graph and observed connections remain independent, not a combined MAP_DB", t => {
  const graph = new DatabaseSync(":memory:"); t.after(() => graph.close()); initializeGraphStore(graph);
  const document = { schema: "seoul-world-graph-v2", districts: [], stations: [], edges: [], aliases: {},
    source: { original: "synthetic", railAdjacency: { revision: "test", officialSource: { url: "https://example.invalid", retrievedAt: "test", sha256: "a".repeat(64), scope: "synthetic" },
      WikiCommit: "test", scope: "synthetic", replacements: [], excluded: [], hubIdentities: [] } } };
  const bytes = Buffer.from(JSON.stringify(document) + "\n");
  const expectedBinding = { dataset_id: "synthetic:graph", edition_id: "test", schema_contract: "janseon-graph-store.v1", projection_contract: "janseon-graph-semantic.v1",
    source_schema: document.schema, expected_source_sha256: sha(bytes), expected_document_sha256: sha(JSON.stringify(document)), expected_byte_length: bytes.length,
    source_package_content_id: "test", source_authentication_receipt_sha256: "b".repeat(64), source_revision: "test", source_reader_sha256: "c".repeat(64),
    source_schema_sha256: "d".repeat(64), field_disposition_sha256: "e".repeat(64), game_source_manifest_sha256: "f".repeat(64), rights_receipt_content_id: "test" };
  importGraphEdition(graph, { document, expectedBinding, sourceReceipt: { singleton: 1, actor: "test", reason: "synthetic",
    source_sha256: sha(bytes), document_sha256: sha(JSON.stringify(document)), byte_length: bytes.length } });
  const graphRequest = { datasetId: "synthetic:graph", editionId: "test", expectedBinding };
  const before = graph.serialize(), observed = database(t), input = inputs(); importObservedGeographyEdition(observed, input);
  const values = { graph: readGraphEdition(graph, graphRequest), observed: readObservedGeographyEdition(observed, request(input)) };
  assert.equal(values.observed.geometry.features.length, 6); assert.deepEqual(values.graph.document, document);
  rejected(() => initializeObservedGeographyStore(graph));
  assert.throws(() => initializeGraphStore(observed), { code: "E_GRAPH_SCHEMA" });
  assert.deepEqual(graph.serialize(), before); assert.deepEqual(readGraphEdition(graph, graphRequest).document, document);
});
