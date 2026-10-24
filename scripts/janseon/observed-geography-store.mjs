/*
Adapted from seoul-dengoku-wiki/scripts/cast-sqlite/{geography-store,boundary-geometries}.{sql,mjs}
https://github.com/islee23520/seoul-dengoku-wiki/tree/50ae1e930981d3115847f723d366bbb9e3247ec0
Modified: allowlisted observed editions, typed geometry validation and immutable seals.

Copyright (c) 2026 iz (ilseob lee)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { assertStoreSchema, initializeStoreSchema } from "./store-schema.mjs";

// Fixed source allowlist, not a caller-extensible schema registry.
const TABLES = [
  [
    "boundary_geometry_source",
    "boundary_source",
    "source_path sha256 collection_type",
    "source_path"
  ],
  [
    "boundary_geometry_feature",
    "boundary_feature",
    "id ordinal feature_type geometry_type kind source_edition official_code? official_name? dong_id? electoral_dong_id? county_title_id? gu_id? name?",
    "ordinal"
  ],
  [
    "boundary_geometry_property",
    "boundary_property",
    "feature_id ordinal name",
    "feature_id ordinal"
  ],
  [
    "boundary_geometry_dong",
    "boundary_dong",
    "feature_id ordinal code",
    "feature_id ordinal"
  ],
  [
    "boundary_geometry_gu",
    "boundary_gu",
    "feature_id ordinal gu_ref",
    "feature_id ordinal"
  ],
  [
    "boundary_geometry_polygon",
    "boundary_polygon",
    "feature_id ordinal",
    "feature_id ordinal"
  ],
  [
    "boundary_geometry_ring",
    "boundary_ring",
    "feature_id polygon_ordinal ordinal",
    "feature_id polygon_ordinal ordinal"
  ],
  [
    "boundary_geometry_point",
    "boundary_point",
    "feature_id polygon_ordinal ring_ordinal ordinal longitude latitude",
    "feature_id polygon_ordinal ring_ordinal ordinal"
  ],
  [
    "geography_spatial",
    "spatial",
    "singleton edition baseDate authority legalSurveyCertification current2026Geometry archiveSha256",
    "singleton"
  ],
  [
    "geography_spatial_geometry",
    "spatial_geometry",
    "singleton path sha256 crs features",
    "singleton"
  ],
  [
    "geography_county",
    "county",
    "edition countyTitleId ordinal",
    "edition ordinal"
  ],
  [
    "geography_slot",
    "slot",
    "edition countyTitleId ordinal slotId dongId name jurisdictionGuRef electoralDongId fragmentId? sourceEdition sourcePointer geometryVerified",
    "edition countyTitleId ordinal"
  ],
  [
    "geography_slot_source",
    "slot_source",
    "edition slotId ordinal ref",
    "edition slotId ordinal"
  ],
  [
    "geography_slot_geometry",
    "slot_geometry",
    "edition slotId ordinal ref",
    "edition slotId ordinal"
  ],
  [
    "geography_edition",
    "electoral_edition",
    "kind id electionDate? seoulCompositionMatchesCurrentAppendix?",
    "kind"
  ],
  [
    "geography_edition_source",
    "electoral_source",
    "kind ordinal ref",
    "kind ordinal"
  ],
  [
    "geography_source_record",
    "source_record",
    "ordinal id sha256 role",
    "ordinal"
  ],
  [
    "geography_evidence",
    "evidence",
    "kind path sha256",
    "kind"
  ]
];
const BINDING_KEYS = ["dataset_id","edition_id","schema_contract","projection_contract","expected_projection_sha256","source_package_content_id","source_authentication_receipt_sha256","source_revision","source_reader_closure_sha256","source_schema_closure_sha256","field_disposition_sha256","rights_receipt_content_id","original_geometry_sha256","original_spatial_sha256","original_membership_sha256","original_geography_archive_sha256"];

const INTEGERS = new Set("ordinal polygon_ordinal ring_ordinal singleton legalSurveyCertification current2026Geometry features geometryVerified seoulCompositionMatchesCurrentAppendix".split(" "));
const SCALARS = { kind: "kind", sourceEdition: "source_edition", officialCode: "official_code",
  officialName: "official_name", dongId: "dong_id", electoralDongId: "electoral_dong_id",
  countyTitleId: "county_title_id", guId: "gu_id", name: "name" };
const SOURCES = {
  geometry: ["data/geography/boundaries/seoul-sgis-20250630.geojson", "6a393cefb7cc257f001042acb8715e5d721b320e14eba723f15857197edaa5e4"],
  spatial: ["data/geography/elections/sources/seoul-sgis-20250630.json", "389b1eabee54cddc965dd523c3b831cdc60ea72d180cab908295c3359a8045ad"],
  membership: ["data/geography/elections/sources/seoul-constituency-membership.json", "5c082aad68af1145dca138d8bf048a9b16e5a13b8618aa7c8c2e79bfc3db74f1"],
};
const fail = (code, detail) => { throw Object.assign(new Error(`${code}: ${detail}`), { code }); };
const requireThat = (value, detail) => { if (!value) fail("E_OBSERVED_INTEGRITY", detail); };
const text = value => typeof value === "string" && value.isWellFormed() && !value.includes("\0");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const columnsOf = spec => spec.split(" ").map(name => name.replace("?", ""));
const key = (...values) => JSON.stringify(values);
const quote = name => '"' + name + '"';

function exact(value, names, label) {
  canonicalEncode(value);
  if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    fail("E_OBSERVED_SHAPE", label);
  }
}

function unique(values, label) {
  requireThat(new Set(values).size === values.length, "duplicate " + label);
  return new Set(values);
}

function sameSet(left, right, label) {
  const a = unique(left, label), b = unique(right, label);
  requireThat(a.size === b.size && [...a].every(value => b.has(value)), label);
}

function dense(rows, label) {
  requireThat(rows.every((row, index) => row.ordinal === index), label + " ordinals");
  return rows;
}

function single(rows, label) {
  requireThat(rows.length === 1, label + " singleton");
  return rows[0];
}

function orderedRows(input) {
  exact(input, TABLES.map(([source]) => source), "tables");
  const result = {};
  for (const [source, , spec, order] of TABLES) {
    if (!Array.isArray(input[source])) fail("E_OBSERVED_SHAPE", source);
    const names = columnsOf(spec);
    const rows = input[source].map(row => {
      exact(row, names, source);
      for (const token of spec.split(" ")) {
        const name = token.replace("?", ""), value = row[name];
        if (token.endsWith("?") && value === null) continue;
        const valid = INTEGERS.has(name) ? Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
          : ["longitude", "latitude"].includes(name) ? typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)
            : text(value);
        if (!valid) fail("E_OBSERVED_SHAPE", source + "." + name);
      }
      return Object.fromEntries(names.map(name => [name, row[name]]));
    });
    const orderKeys = order.split(" ");
    // SQLite BINARY orders UTF-8 bytes, not locale or normalized strings.
    rows.sort((a, b) => {
      for (const name of orderKeys) {
        const difference = typeof a[name] === "number" ? a[name] - b[name]
          : Buffer.compare(Buffer.from(a[name]), Buffer.from(b[name]));
        if (difference) return difference;
      }
      return 0;
    });
    unique(rows.map(row => key(...orderKeys.map(name => row[name]))), source + " order key");
    result[source] = rows;
  }
  return result;
}

function inspect(rows, datasetId, editionId) {
  requireThat(text(datasetId) && datasetId.length && text(editionId) && editionId.length, "namespace");
  const spatial = single(rows.geography_spatial, "spatial");
  const geometrySource = single(rows.geography_spatial_geometry, "spatial geometry");
  const boundary = single(rows.boundary_geometry_source, "boundary source");
  const electoral = single(rows.geography_edition, "electoral edition");
  requireThat(spatial.singleton === 1 && geometrySource.singleton === 1, "singleton value");
  requireThat(spatial.edition === editionId && /^\d{4}-\d{2}-\d{2}$/.test(spatial.baseDate), "spatial edition/date");
  requireThat(spatial.authority === "official-SGIS-statistical-boundary"
    && spatial.legalSurveyCertification === 0 && spatial.current2026Geometry === 0 && hash(spatial.archiveSha256), "spatial authority");
  requireThat(geometrySource.crs === "OGC:CRS84" && geometrySource.path === boundary.source_path
    && geometrySource.sha256 === boundary.sha256 && hash(boundary.sha256)
    && boundary.collection_type === "FeatureCollection", "geometry source/CRS");
  requireThat(electoral.kind === "electoral" && electoral.id.length > 0 && typeof electoral.electionDate === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(electoral.electionDate)
    && [0, 1].includes(electoral.seoulCompositionMatchesCurrentAppendix), "electoral edition");
  sameSet(rows.geography_evidence.map(row => row.kind), ["membership", "spatial"], "evidence kinds");
  for (const row of rows.geography_evidence) requireThat(hash(row.sha256) && row.path.length > 0, "evidence");

  const features = dense(rows.boundary_geometry_feature, "feature");
  requireThat(features.length > 0 && features.length === geometrySource.features, "feature count");
  unique(features.map(row => row.id), "feature id");
  const consumed = new Map(TABLES.map(([source]) => [source, new Set()]));
  function children(table, owner) {
    const found = rows[table].filter(row => Object.entries(owner).every(([name, value]) => row[name] === value));
    found.forEach(row => consumed.get(table).add(row));
    return dense(found, table);
  }
  const geometry = { type: "FeatureCollection", features: features.map(feature => {
    requireThat(feature.id.length > 0 && feature.feature_type === "Feature"
      && ["Polygon", "MultiPolygon"].includes(feature.geometry_type)
      && ["dong", "county", "gu", "city"].includes(feature.kind)
      && feature.source_edition === editionId, "feature shape/edition");
    const owner = { feature_id: feature.id };
    const properties = children("boundary_geometry_property", owner);
    const names = unique(properties.map(row => row.name), "property");
    requireThat(names.has("kind") && names.has("sourceEdition"), "required properties");
    const codes = children("boundary_geometry_dong", owner).map(row => row.code);
    const gus = children("boundary_geometry_gu", owner).map(row => row.gu_ref);
    requireThat((names.has("officialDongCodes") || !codes.length)
      && (names.has("jurisdictionGuRefs") || !gus.length), "hidden list");
    for (const [name, column] of Object.entries(SCALARS)) {
      requireThat(names.has(name) || feature[column] === null, "hidden scalar " + name);
    }
    const entries = properties.map(({ name }) => {
      requireThat(Object.hasOwn(SCALARS, name) || ["officialDongCodes", "jurisdictionGuRefs"].includes(name), "unknown property");
      return [name, name === "officialDongCodes" ? codes : name === "jurisdictionGuRefs" ? gus : feature[SCALARS[name]]];
    });
    const polygons = children("boundary_geometry_polygon", owner);
    requireThat(polygons.length > 0 && (feature.geometry_type !== "Polygon" || polygons.length === 1), "polygon multiplicity");
    const coordinates = polygons.map(polygon => {
      const ringRows = children("boundary_geometry_ring", { ...owner, polygon_ordinal: polygon.ordinal });
      requireThat(ringRows.length > 0, "empty polygon");
      return ringRows.map(ring => {
        const points = children("boundary_geometry_point", { ...owner, polygon_ordinal: polygon.ordinal, ring_ordinal: ring.ordinal });
        requireThat(points.length >= 4, "short ring");
        for (const point of points) requireThat(point.longitude >= -180 && point.longitude <= 180
          && point.latitude >= -90 && point.latitude <= 90, "coordinate axes/range");
        requireThat(points[0].longitude === points.at(-1).longitude && points[0].latitude === points.at(-1).latitude, "unclosed ring");
        return points.map(point => [point.longitude, point.latitude]);
      });
    });
    return { type: "Feature", id: feature.id, properties: Object.fromEntries(entries),
      geometry: { type: feature.geometry_type, coordinates: feature.geometry_type === "Polygon" ? coordinates[0] : coordinates } };
  }) };

  const byId = new Map(geometry.features.map(feature => [feature.id, feature]));
  const dongs = features.filter(row => row.kind === "dong"), counties = features.filter(row => row.kind === "county");
  const gus = features.filter(row => row.kind === "gu"), cities = features.filter(row => row.kind === "city");
  requireThat(dongs.length > 0 && counties.length > 0 && gus.length > 0 && cities.length === 1, "feature kinds");
  requireThat(cities[0].official_code === "11", "city code");
  for (const column of ["dong_id", "electoral_dong_id", "official_code"]) {
    unique(dongs.map(row => row[column]), "dong " + column);
    requireThat(dongs.every(row => text(row[column]) && row[column].length), "dong identity");
  }
  const guIds = unique(gus.map(row => row.gu_id), "gu id");
  requireThat(gus.every(row => text(row.gu_id) && row.gu_id.length), "gu identity");
  const dongCodes = new Set(dongs.map(row => row.official_code));
  for (const row of rows.boundary_geometry_dong) requireThat(dongCodes.has(row.code), "official dong reference");
  for (const row of rows.boundary_geometry_gu) requireThat(guIds.has(row.gu_ref), "jurisdiction gu reference");
  for (const feature of features) {
    const required = { dong: ["officialCode", "officialName", "dongId", "electoralDongId", "countyTitleId", "guId"],
      county: ["countyTitleId", "name", "officialDongCodes", "jurisdictionGuRefs"],
      gu: ["guId", "name"], city: ["officialCode"] }[feature.kind];
    const properties = byId.get(feature.id).properties;
    requireThat(required.every(name => Object.hasOwn(properties, name) && properties[name] !== null), "kind properties");
    if (feature.kind === "county") requireThat(feature.county_title_id === feature.id, "county identity");
  }
  const countyRows = dense(rows.geography_county, "county");
  requireThat(countyRows.every(row => row.edition === "dated"), "dated county filter");
  sameSet(countyRows.map(row => row.countyTitleId), counties.map(row => row.id), "county coverage");
  unique(rows.geography_slot.map(row => row.slotId), "slot id");
  const seenDongs = [];
  for (const county of countyRows) {
    const slots = children("geography_slot", { edition: "dated", countyTitleId: county.countyTitleId });
    requireThat(slots.length > 0, "empty county");
    const assigned = slots.map(slot => {
      requireThat(slot.slotId.length > 0 && slot.sourceEdition === editionId && slot.fragmentId === null
        && slot.geometryVerified === 1 && slot.sourcePointer.startsWith("/"), "dated slot shape");
      const dong = dongs.find(row => row.dong_id === slot.dongId);
      requireThat(dong && dong.electoral_dong_id === slot.electoralDongId && dong.county_title_id === county.countyTitleId
        && dong.gu_id === slot.jurisdictionGuRef && guIds.has(slot.jurisdictionGuRef)
        && dong.official_name === slot.name, "slot/dong join");
      seenDongs.push(dong.id);
      const owner = { edition: "dated", slotId: slot.slotId };
      const refs = children("geography_slot_geometry", owner);
      requireThat(refs.length === 1 && refs[0].ref === dong.id, "slot geometry");
      requireThat(children("geography_slot_source", owner).length > 0, "slot source");
      return dong;
    });
    const properties = byId.get(county.countyTitleId).properties;
    sameSet(properties.officialDongCodes, assigned.map(row => row.official_code), "county codes");
    sameSet(properties.jurisdictionGuRefs, [...new Set(assigned.map(row => row.gu_id))], "county gu refs");
  }
  sameSet(seenDongs, dongs.map(row => row.id), "dong coverage");
  const electoralRefs = children("geography_edition_source", { kind: "electoral" });
  requireThat(electoralRefs.length > 0, "electoral sources");
  const referenced = new Set([...rows.geography_slot_source, ...electoralRefs].map(row => row.ref));
  sameSet(rows.geography_source_record.map(row => row.id), [...referenced], "source closure");
  for (const row of rows.geography_source_record) requireThat(row.id.length > 0 && hash(row.sha256) && row.role.length > 0, "source record");
  for (const table of ["boundary_geometry_property", "boundary_geometry_dong", "boundary_geometry_gu",
    "boundary_geometry_polygon", "boundary_geometry_ring", "boundary_geometry_point", "geography_slot",
    "geography_slot_geometry", "geography_slot_source", "geography_edition_source"]) {
    requireThat(consumed.get(table).size === rows[table].length, "unconsumed rows " + table);
  }
  if (datasetId === "seoul-observed-geography") {
    requireThat(editionId === "sgis-20250630" && spatial.baseDate === "2025-06-30", "initial edition pins");
    requireThat(dongs.length === 426 && counties.length === 48 && gus.length === 25 && features.length === 500, "initial counts");
    requireThat(boundary.source_path === SOURCES.geometry[0] && boundary.sha256 === SOURCES.geometry[1], "initial geometry pin");
    for (const kind of ["membership", "spatial"]) {
      const row = rows.geography_evidence.find(row => row.kind === kind);
      requireThat(row.path === SOURCES[kind][0] && row.sha256 === SOURCES[kind][1], "initial evidence pin");
    }
  } else requireThat(datasetId.startsWith("synthetic:") && datasetId.length > 10, "unsupported dataset");
  return geometry;
}

function validateBinding(binding) {
  exact(binding, BINDING_KEYS, "binding");
  for (const name of BINDING_KEYS) {
    if (!text(binding[name]) || !binding[name].length || (name.endsWith("_sha256") && !hash(binding[name]))) fail("E_OBSERVED_BINDING", name);
  }
  if (binding.schema_contract !== "janseon-observed-geography-store.v1"
      || binding.projection_contract !== "janseon-observed-geography-semantic.v1") fail("E_OBSERVED_BINDING", "contracts");
  for (const name of ["source_package_content_id", "rights_receipt_content_id"]) {
    if (/[\\/]/.test(binding[name]) || /^[A-Za-z]:/.test(binding[name]) || [".", ".."].includes(binding[name])) fail("E_OBSERVED_BINDING", "opaque reference");
  }
  // No receipt supplied by a caller can enable real production admission in this unit.
  if (!binding.dataset_id.startsWith("synthetic:") || binding.dataset_id.length <= 10) fail("E_OBSERVED_ADMISSION", "production admission is not implemented");
}

function boundProjection(rows, binding) {
  const projection = observedGeographySemanticProjection({ datasetId: binding.dataset_id, editionId: binding.edition_id, rows });
  const digest = semanticDigest(projection);
  requireThat(digest === binding.expected_projection_sha256, "independent projection binding");
  requireThat(rows.boundary_geometry_source[0].sha256 === binding.original_geometry_sha256, "geometry receipt");
  for (const kind of ["membership", "spatial"]) requireThat(rows.geography_evidence.find(row => row.kind === kind).sha256
    === binding[`original_${kind}_sha256`], "evidence receipt");
  return digest;
}

function schemaBoundary(db, mode) {
  if (!["janseon-observed-geography-store.v1", "janseon-central-store.v1"].includes(mode)) fail("E_OBSERVED_SCHEMA", "unsupported schema mode");
  try { assertStoreSchema(db, mode); } catch (error) {
    if (error.code === "E_STORE_SCHEMA") fail("E_OBSERVED_SCHEMA", error.message);
    throw error;
  }
}

function transaction(db, action) {
  const started = !db.isTransaction;
  if (started) db.exec("BEGIN IMMEDIATE");
  db.exec("SAVEPOINT map_observed_write");
  try {
    const result = action();
    db.exec(started ? "COMMIT" : "RELEASE map_observed_write");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO map_observed_write; RELEASE map_observed_write");
    if (started) db.exec("ROLLBACK");
    throw error;
  }
}

function insert(db, table, row) {
  const names = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map(name => row[name]));
}

/** Fresh standalone schema; central-store installs the explicit two-domain union. */
export function initializeObservedGeographyStore(db) {
  try { initializeStoreSchema(db, "janseon-observed-geography-store.v1"); } catch (error) {
    if (error.code === "E_STORE_SCHEMA") fail("E_OBSERVED_SCHEMA", error.message);
    throw error;
  }
}

/** The caller independently authenticates expectedBinding. This unit admits synthetic datasets only. */
export function importObservedGeographyEdition(db, options, schemaMode = "janseon-observed-geography-store.v1") {
  exact(options, ["rows", "expectedBinding"], "import options");
  const binding = options.expectedBinding;
  validateBinding(binding);
  const rows = orderedRows(options.rows);
  const digest = boundProjection(rows, binding);
  return transaction(db, () => {
    schemaBoundary(db, schemaMode);
    insert(db, "map_observed_binding", binding);
    for (const [source, suffix] of TABLES) for (const row of rows[source]) {
      insert(db, "map_observed_" + suffix, { dataset_id: binding.dataset_id, edition_id: binding.edition_id, ...row,
        ...(suffix === "boundary_point" ? { longitude_text: JSON.stringify(row.longitude), latitude_text: JSON.stringify(row.latitude) } : {}) });
    }
    insert(db, "map_observed_seal", { dataset_id: binding.dataset_id, edition_id: binding.edition_id, observed_semantic_sha256: digest });
    readObservedGeographyEdition(db, { datasetId: binding.dataset_id, editionId: binding.edition_id, expectedBinding: binding }, schemaMode);
    return { datasetId: binding.dataset_id, editionId: binding.edition_id, observedGeographySemanticSha256: digest };
  });
}

/** Typed SELECT reconstruction; no source database, filesystem fallback or authority grant. */
export function readObservedGeographyEdition(db, options, schemaMode = "janseon-observed-geography-store.v1") {
  exact(options, ["datasetId", "editionId", "expectedBinding"], "read options");
  const { datasetId, editionId, expectedBinding: binding } = options;
  validateBinding(binding);
  if (datasetId !== binding.dataset_id || editionId !== binding.edition_id) fail("E_OBSERVED_BINDING", "requested edition");
  schemaBoundary(db, schemaMode);
  const bindings = db.prepare("SELECT * FROM map_observed_binding WHERE dataset_id=? AND edition_id=?").all(datasetId, editionId);
  if (bindings.length !== 1 || canonicalEncode({ ...bindings[0] }) !== canonicalEncode(binding)) fail("E_OBSERVED_BINDING", "stored binding");
  requireThat(!db.prepare("PRAGMA foreign_key_check").all().length
    && db.prepare("PRAGMA integrity_check").all().every(row => row.integrity_check === "ok"), "SQLite integrity");
  const input = {};
  for (const [source, suffix, spec, order] of TABLES) {
    const names = columnsOf(spec);
    input[source] = db.prepare(`SELECT * FROM map_observed_${suffix} WHERE dataset_id=? AND edition_id=? ORDER BY ${order.split(" ").map(quote).join(",")}`)
      .all(datasetId, editionId).map(row => {
        if (suffix === "boundary_point") requireThat(JSON.stringify(row.longitude) === row.longitude_text
          && JSON.stringify(row.latitude) === row.latitude_text, "coordinate text");
        return Object.fromEntries(names.map(name => [name, row[name]]));
      });
  }
  const rows = orderedRows(input), digest = boundProjection(rows, binding);
  const seals = db.prepare("SELECT observed_semantic_sha256 FROM map_observed_seal WHERE dataset_id=? AND edition_id=?").all(datasetId, editionId);
  requireThat(seals.length === 1 && seals[0].observed_semantic_sha256 === digest, "seal");
  return { datasetId, editionId, rows, geometry: inspect(rows, datasetId, editionId), observedGeographySemanticSha256: digest };
}

/** Original source facts are semantic; delivery receipts and DB bytes are not. */
export function observedGeographySemanticProjection(options) {
  exact(options, ["datasetId", "editionId", "rows"], "projection options");
  const { datasetId, editionId } = options, rows = orderedRows(options.rows);
  inspect(rows, datasetId, editionId);
  return { schema: "janseon-observed-geography-semantic.v1", datasetId, editionId, rows };
}

/** Encode a validated read result, not original source bytes or a public release. */
export function encodeObservedGeometryPayload(geometry) {
  canonicalEncode(geometry);
  return Buffer.from(JSON.stringify(geometry) + "\n", "utf8");
}
