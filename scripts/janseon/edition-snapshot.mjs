import { createHash } from "node:crypto";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { graphSemanticProjection } from "./graph-store.mjs";
import { observedGeographySemanticProjection } from "./observed-geography-store.mjs";
import { validateReleaseManifest } from "./release-manifest.mjs";

const fail = (code, detail) => { throw Object.assign(new Error(`${code}: ${detail}`), { code }); };
const check = (yes, detail, code = "E_SNAPSHOT_SHAPE") => { if (!yes) fail(code, detail); };
const exact = (v, keys) => check(v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), "exact keys");
const text = v => check(typeof v === "string" && v.isWellFormed() && v.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(v), "text");
const hash = v => check(typeof v === "string" && /^[a-f0-9]{64}$/u.test(v), "hash");
const opaque = v => { text(v); check(![".", ".."].includes(v) && !/[\\/%]/u.test(v) && !/^[A-Za-z]:/u.test(v), "opaque id"); };
const positive = v => check(Number.isSafeInteger(v) && v > 0, "positive integer");
const list = (v, fn) => { check(Array.isArray(v), "array"); v.forEach(fn); };
const same = (a, b) => canonicalEncode(a) === canonicalEncode(b);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const bind = (a, b, label) => check(same(a, b), label, "E_SNAPSHOT_BINDING");
const receipt = r => { exact(r, ["contentId", "sha256"]); opaque(r.contentId); hash(r.sha256); };
const domains = ["graph", "observed-geography", "legacy-atlas", "physical-rail", "station-bindings", "initial-state", "terrain", "roads", "buildings"];
const ids = ["surface-observed", "surface-legacy-atlas", "subway-graph", "physical-rail", "authored-spatial"];
const contentKinds = ["central-reference", "authored-reference", "identity-reference", "legacy-atlas-reference", "physical-rail-reference"];
const tuple = e => [e.domain, e.datasetId, e.editionId];
const entityTuple = e => [e.datasetId, e.editionId, e.entityKind, e.sourceId];
const key = e => JSON.stringify(tuple(e));
const entityKey = e => JSON.stringify(entityTuple(e));
function compare(a, b) { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; }
function sorted(v, select) { check(v.every((x, i) => !i || compare(select(v[i - 1]), select(x)) < 0), "sorted unique", "E_SNAPSHOT_REFERENCE"); }
function edition(e, digest = false) {
  exact(e, ["domain", "datasetId", "editionId", ...(digest ? ["semanticSha256"] : [])]);
  check(domains.includes(e.domain), "domain"); text(e.datasetId); text(e.editionId); if (digest) hash(e.semanticSha256);
}
const entity = r => { exact(r, ["datasetId", "editionId", "entityKind", "sourceId"]); Object.values(r).forEach(text); };
function sourceSnapshot(s) { exact(s, ["contentId", "databaseSha256", "mapSemanticSha256"]); opaque(s.contentId); hash(s.databaseSha256); hash(s.mapSemanticSha256); }
function sourceContent(s) {
  exact(s, ["contentId", "rawSha256", "sizeBytes", "encoding"]); opaque(s.contentId); hash(s.rawSha256); positive(s.sizeBytes);
  check(s.encoding === "wiki-json-pretty2-lf.v1", "identity source encoding");
}
function identityIndex(i) {
  exact(i, ["snapshotSha256", "entities"]); hash(i.snapshotSha256);
  list(i.entities, e => { exact(e, ["ref", "affiliationRefs", "affiliationStatus"]); entity(e.ref);
    check(["person", "polity", "bloc"].includes(e.ref.entityKind), "identity kind"); list(e.affiliationRefs, entity); sorted(e.affiliationRefs, entityTuple);
    check(["resolved", "none", "unresolved"].includes(e.affiliationStatus), "affiliation status"); });
  sorted(i.entities, e => entityTuple(e.ref));
  const refs = new Set(i.entities.map(e => entityKey(e.ref)));
  for (const e of i.entities) for (const r of e.affiliationRefs) check(refs.has(entityKey(r)), "identity reference", "E_SNAPSHOT_REFERENCE");
}
function descriptor(d) {
  exact(d, ["contentId", "rawSha256", "sizeBytes", "kind", "editionRefs", "visibility", "license"]);
  opaque(d.contentId); hash(d.rawSha256); positive(d.sizeBytes); check(contentKinds.includes(d.kind), "content kind");
  list(d.editionRefs, e => edition(e)); sorted(d.editionRefs, tuple); check(d.editionRefs.length > 0, "content editions", "E_SNAPSHOT_REFERENCE");
  check(["public", "protected"].includes(d.visibility), "visibility"); exact(d.license, ["id", "textSha256"]); text(d.license.id); hash(d.license.textSha256);
}
function freeze(v) { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
const rootKeys = ["schema", "datasetId", "editionId", "generationId", "mapSemanticSha256", "identitySnapshotSha256", "release", "sourceSnapshot", "identityReceipt", "sourceReceipts", "editions", "layers", "contents"];
function inspect(s, c, complete) {
  try { canonicalEncode(s); canonicalEncode(c); } catch { fail("E_SNAPSHOT_SHAPE", "canonical data required"); }
  exact(s, [...rootKeys, ...(complete ? ["snapshotSha256"] : [])]);
  exact(c, ["schema", "expectedDatasetId", "expectedEditionId", "expectedGenerationId", "expectedMapSemanticSha256", "expectedIdentitySnapshotSha256", "requiredLayers",
    "expectedSourceSnapshot", "expectedIdentityReceipt", "expectedIdentityReferenceBinding", "expectedSourceReceipts", "releaseManifest", "releaseContext", "expectedContentDescriptors"]);
  check(s.schema === "janseon-map-snapshot.v1" && c.schema === "janseon-editor-snapshot-context.v1", "schema");
  [s.datasetId, s.editionId, c.expectedDatasetId, c.expectedEditionId].forEach(text);
  [s.generationId, s.mapSemanticSha256, s.identitySnapshotSha256, c.expectedGenerationId, c.expectedMapSemanticSha256, c.expectedIdentitySnapshotSha256].forEach(hash);
  if (complete) hash(s.snapshotSha256);
  sourceSnapshot(s.sourceSnapshot); sourceSnapshot(c.expectedSourceSnapshot); receipt(s.identityReceipt); receipt(c.expectedIdentityReceipt);
  exact(c.expectedIdentityReferenceBinding, ["sourceContent", "sourceReceipt", "indexSemanticSha256"]);
  sourceContent(c.expectedIdentityReferenceBinding.sourceContent); receipt(c.expectedIdentityReferenceBinding.sourceReceipt); hash(c.expectedIdentityReferenceBinding.indexSemanticSha256);
  for (const rs of [s.sourceReceipts, c.expectedSourceReceipts]) {
    list(rs, r => { exact(r, ["editionRef", "receipt"]); edition(r.editionRef); receipt(r.receipt); }); sorted(rs, r => tuple(r.editionRef));
  }
  list(s.editions, e => edition(e, true)); sorted(s.editions, tuple);
  list(s.contents, descriptor); sorted(s.contents, d => [d.contentId]); list(c.expectedContentDescriptors, descriptor); sorted(c.expectedContentDescriptors, d => [d.contentId]);
  list(c.requiredLayers, id => check(ids.includes(id), "required layer")); sorted(c.requiredLayers, id => [id]);
  exact(s.release, ["state", "mapReleaseId", "deliveryReceiptId"]); check(["draft", "released"].includes(s.release.state), "release state");
  bind([s.datasetId, s.editionId, s.generationId, s.mapSemanticSha256, s.identitySnapshotSha256],
    [c.expectedDatasetId, c.expectedEditionId, c.expectedGenerationId, c.expectedMapSemanticSha256, c.expectedIdentitySnapshotSha256], "generation binding");
  bind(s.sourceSnapshot, c.expectedSourceSnapshot, "source snapshot"); bind(s.sourceSnapshot.mapSemanticSha256, s.mapSemanticSha256, "source semantic");
  bind(s.identityReceipt, c.expectedIdentityReceipt, "identity receipt"); bind(s.identityReceipt, c.expectedIdentityReferenceBinding.sourceReceipt, "identity source receipt");
  bind(s.identitySnapshotSha256, c.expectedIdentityReferenceBinding.sourceContent.rawSha256, "identity source hash");
  bind(s.sourceReceipts, c.expectedSourceReceipts, "source receipts"); bind(s.contents, c.expectedContentDescriptors, "content bindings");
  if (s.release.state === "draft") {
    check(s.release.mapReleaseId === null && s.release.deliveryReceiptId === null && c.releaseManifest === null && c.releaseContext === null, "unbuilt draft", "E_SNAPSHOT_BINDING");
  } else {
    check(c.releaseManifest !== null && c.releaseContext !== null, "release required", "E_SNAPSHOT_BINDING");
    const r = validateReleaseManifest(c.releaseManifest, c.releaseContext), m = c.releaseManifest;
    bind([s.release.mapReleaseId, s.release.deliveryReceiptId], [r.mapReleaseId, r.deliveryReceiptId], "R/P");
    bind(s.editions, m.semantic.editions, "release editions"); bind(s.mapSemanticSha256, m.semantic.mapSemanticSha256, "release map");
    bind(s.identitySnapshotSha256, m.semantic.identitySnapshotSha256, "release identity"); bind(s.sourceSnapshot, m.provenance.snapshot, "release source");
    bind(s.identityReceipt, m.provenance.identityReceipt, "release identity receipt"); bind(s.sourceReceipts, m.provenance.sourceReceipts, "release sources");
  }
  const editions = new Set(s.editions.map(key));
  check(s.editions.length > 0 && new Set(s.editions.map(e => JSON.stringify([e.domain, e.datasetId]))).size === s.editions.length, "edition uniqueness", "E_SNAPSHOT_REFERENCE");
  check(s.sourceReceipts.length === editions.size && s.sourceReceipts.every(r => editions.has(key(r.editionRef))), "source coverage", "E_SNAPSHOT_REFERENCE");
  const refs = values => check(values.every(e => editions.has(key(e))), "unresolved edition", "E_SNAPSHOT_REFERENCE");
  const allowedContentDomains = { "central-reference": ["graph", "observed-geography"], "legacy-atlas-reference": ["legacy-atlas"], "physical-rail-reference": ["physical-rail"], "authored-reference": domains, "identity-reference": domains };
  for (const d of s.contents) { refs(d.editionRefs); check(d.editionRefs.every(e => allowedContentDomains[d.kind].includes(e.domain)), "content edition role", "E_SNAPSHOT_REFERENCE"); }
  const layerRoles = { "surface-observed": ["observed-geography"], "surface-legacy-atlas": ["legacy-atlas"], "subway-graph": ["graph"], "physical-rail": ["physical-rail"], "authored-spatial": domains };
  list(s.layers, l => {
    exact(l, ["id", "editionRefs", "contentIds", "sourceCoordinates", "displayTransform", "movement"]); check(ids.includes(l.id), "layer id");
    list(l.editionRefs, e => edition(e)); sorted(l.editionRefs, tuple); refs(l.editionRefs);
    check(l.editionRefs.length > 0 && l.editionRefs.every(e => layerRoles[l.id].includes(e.domain)), "layer edition role", "E_SNAPSHOT_REFERENCE");
    list(l.contentIds, opaque); sorted(l.contentIds, id => [id]); check(l.contentIds.length > 0, "layer content", "E_SNAPSHOT_REFERENCE");
    const used = l.contentIds.map(id => s.contents.find(d => d.contentId === id));
    check(used.every(Boolean) && l.editionRefs.every(e => used.some(d => d.editionRefs.some(x => key(x) === key(e)))), "layer coverage", "E_SNAPSHOT_REFERENCE");
    const requiredKind = { "surface-observed": "central-reference", "subway-graph": "central-reference", "surface-legacy-atlas": "legacy-atlas-reference", "physical-rail": "physical-rail-reference", "authored-spatial": "authored-reference" }[l.id];
    check(used.some(d => d.kind === requiredKind), "layer content role", "E_SNAPSHOT_REFERENCE");
    check(l.movement === (l.id === "subway-graph" ? "explicit-graph" : "none"), "movement role", "E_SNAPSHOT_REFERENCE");
    exact(l.sourceCoordinates, ["crs", "axisOrder"]); exact(l.displayTransform, ["id", "outputCrs", "outputAxisOrder"]);
    const graph = l.id === "subway-graph";
    check(same(l.sourceCoordinates, graph ? { crs: "graph-named-lat-lon", axisOrder: "latitude-longitude" } : { crs: "OGC:CRS84", axisOrder: "longitude-latitude" })
      && same(l.displayTransform, { id: graph ? "graph-lon-lat-v1" : "identity-crs84-v1", outputCrs: "OGC:CRS84", outputAxisOrder: "longitude-latitude" }), "unsupported transform", "E_SNAPSHOT_TRANSFORM");
  });
  sorted(s.layers, l => [l.id]);
  check(c.requiredLayers.every(id => s.layers.some(l => l.id === id)), "missing required layer", "E_SNAPSHOT_REFERENCE");
  check(s.editions.every(e => s.contents.some(d => d.editionRefs.some(x => key(x) === key(e)))), "unconsumed edition", "E_SNAPSHOT_REFERENCE");
}
const identity = s => ({ snapshotSha256: s.snapshotSha256, mapReleaseId: s.release.mapReleaseId, deliveryReceiptId: s.release.deliveryReceiptId });
function digest(s) { const { snapshotSha256, ...value } = s; return semanticDigest(value); }

/** Structural binding only, never source authentication or filesystem resolution. */
export function createEditorSnapshot(input, context) {
  inspect(input, context, false);
  return freeze({ ...structuredClone(input), snapshotSha256: semanticDigest(input) });
}
export function validateEditorSnapshot(snapshot, context) {
  inspect(snapshot, context, true);
  check(snapshot.snapshotSha256 === digest(snapshot), "snapshot digest", "E_SNAPSHOT_DIGEST");
  return Object.freeze(identity(snapshot));
}

// Strict raw JSON parser: JSON.parse alone would overwrite duplicate members.
function parse(bytes) {
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail("E_SNAPSHOT_SHAPE", "UTF-8"); }
  let at = 0;
  const whitespace = () => { while (/[ \t\r\n]/u.test(source[at] ?? "x")) at++; };
  const string = () => {
    const start = at++; let escaped = false;
    while (at < source.length) {
      const ch = source[at++];
      if (!escaped && ch === '"') { try { return JSON.parse(source.slice(start, at)); } catch { fail("E_SNAPSHOT_SHAPE", "JSON string"); } }
      if (!escaped && ch === "\\") escaped = true; else escaped = false;
    }
    fail("E_SNAPSHOT_SHAPE", "unterminated string");
  };
  const value = () => {
    whitespace(); const ch = source[at];
    if (ch === '"') return string();
    if (ch === "{" || ch === "[") {
      at++; const object = ch === "{", result = object ? {} : [], names = new Set(), end = object ? "}" : "]";
      whitespace(); if (source[at] === end) { at++; return result; }
      while (at < source.length) {
        whitespace(); let name;
        if (object) { check(source[at] === '"', "JSON key"); name = string(); check(!names.has(name), "duplicate JSON key"); names.add(name); whitespace(); check(source[at++] === ":", "JSON colon"); }
        const item = value(); if (object) Object.defineProperty(result, name, { value: item, enumerable: true, writable: true, configurable: true }); else result.push(item);
        whitespace(); const separator = source[at++]; if (separator === end) return result; check(separator === ",", "JSON delimiter");
      }
      fail("E_SNAPSHOT_SHAPE", "unterminated JSON");
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(source.slice(at));
    check(Boolean(token), "JSON value"); at += token[0].length; return JSON.parse(token[0]);
  };
  const result = value(); whitespace(); check(at === source.length, "JSON trailing bytes");
  try { canonicalEncode(result); } catch { fail("E_SNAPSHOT_SHAPE", "canonical JSON values"); }
  return result;
}
function graphSource(document) {
  const referenceCode = "E_SNAPSHOT_REFERENCE";
  const strings = values => list(values, value => check(typeof value === "string" && value.isWellFormed() && !value.includes("\0"), "source string"));
  const string = value => strings([value]);
  const integer = value => check(Number.isSafeInteger(value) && !Object.is(value, -0), "source integer");
  const official = value => { exact(value, ["url", "retrievedAt", "sha256", "scope"]); Object.values(value).forEach(string); };
  const endpoints = value => { exact(value, ["a", "b"]); string(value.a); string(value.b); };
  exact(document.source, ["original", "railAdjacency"]); string(document.source.original);
  const r = document.source.railAdjacency;
  exact(r, ["revision", "officialSource", "WikiCommit", "scope", "replacements", "excluded", "hubIdentities"]);
  [r.revision, r.WikiCommit, r.scope].forEach(string); official(r.officialSource);
  const stations = new Set(document.stations.map(s => s.id));
  const station = id => check(stations.has(id), "source station reference", referenceCode);
  const ordinals = new Set();
  const originalIndex = index => { integer(index); check(!ordinals.has(index), "duplicate original index", referenceCode); ordinals.add(index); };
  list(r.replacements, v => {
    exact(v, ["originalIndex", "original", "status", "chain", "officialCodes", "lineId", "source", "physicalEvidenceBoundary"]);
    originalIndex(v.originalIndex); endpoints(v.original); [v.status, v.lineId, v.physicalEvidenceBoundary].forEach(string);
    strings(v.chain); v.chain.forEach(station); strings(v.officialCodes); official(v.source);
  });
  list(r.excluded, v => {
    check(v !== null && typeof v === "object" && !Array.isArray(v), "exclusion");
    const optional = ["reason", "missing"].filter(k => Object.hasOwn(v, k));
    exact(v, ["originalIndex", "original", "status", ...optional, "support"]); check(optional.length <= 1, "exclusion alternatives");
    originalIndex(v.originalIndex); endpoints(v.original); string(v.status);
    if (Object.hasOwn(v, "reason") && v.reason !== null) string(v.reason);
    if (Object.hasOwn(v, "missing")) strings(v.missing);
    const s = v.support;
    exact(s, ["index", "a", "b", "mappedA", "mappedB", "classification", "officialAdjacentSupport", "skippedStopEvidence", "openingEdgeSupport", "endpointClassification", "noSurfaceAdjacencyInference", "evidence_refs"]);
    integer(s.index); [s.a, s.b, s.mappedA, s.mappedB, s.classification].forEach(string);
    check(typeof s.noSurfaceAdjacencyInference === "boolean", "source boolean");
    [s.officialAdjacentSupport, s.openingEdgeSupport, s.endpointClassification].forEach(strings);
    list(s.evidence_refs, e => { exact(e, ["path", "selector"]); string(e.path); string(e.selector); });
    list(s.skippedStopEvidence, e => {
      exact(e, ["lineId", "lineName", "pathIndex", "codes", "stationIds", "names", "skippedStops"]);
      string(e.lineId); string(e.lineName); integer(e.pathIndex); integer(e.skippedStops);
      [e.codes, e.stationIds, e.names].forEach(strings);
    });
  });
  const hubs = new Set();
  list(r.hubIdentities, h => {
    exact(h, ["uid", "officialCodes", "permanentIds", "lineIds", "evidence", "contract"]); string(h.uid); string(h.contract);
    check(!hubs.has(h.uid), "duplicate hub", referenceCode); hubs.add(h.uid);
    [h.officialCodes, h.permanentIds, h.lineIds].forEach(strings); h.permanentIds.forEach(station);
    list(h.evidence, e => {
      exact(e, ["lineId", "lineName", "code", "uid", "name", "pathIndex", "stationIndex"]);
      [e.lineId, e.lineName, e.code, e.uid, e.name].forEach(string); integer(e.pathIndex); integer(e.stationIndex);
    });
  });
}
function readCentral(c, descriptor, s) {
  exact(c, ["schema", "graph", "observedGeography", "centralSemanticSha256"]); check(c.schema === "janseon-central-snapshot.v1", "central schema");
  const g = c.graph, o = c.observedGeography;
  exact(g, ["datasetId", "editionId", "document", "graphSemanticSha256"]);
  exact(o, ["datasetId", "editionId", "rows", "geometry", "observedGeographySemanticSha256"]);
  for (const x of [g, o]) { text(x.datasetId); text(x.editionId); }
  exact(g.document, ["schema", "districts", "stations", "edges", "aliases", "source"]); check(g.document.schema === "seoul-world-graph-v2", "graph schema");
  const d = g.document;
  list(d.districts, text); list(d.stations, r => { exact(r, ["id", "nameKo", "nameEn", "district", "lat", "lon"]); [r.id, r.nameKo, r.nameEn, r.district].forEach(text);
    check([r.lat, r.lon].every(n => typeof n === "number" && Number.isFinite(n) && !Object.is(n, -0)), "station coordinates"); });
  const stations = new Set(d.stations.map(x => x.id)); check(stations.size === d.stations.length && new Set(d.districts).size === d.districts.length, "graph duplicates", "E_SNAPSHOT_REFERENCE");
  check(d.stations.every(x => d.districts.includes(x.district)), "graph district", "E_SNAPSHOT_REFERENCE");
  const pairs = new Set(); list(d.edges, r => { exact(r, ["a", "b"]); const k = JSON.stringify([r.a, r.b].sort());
    check(stations.has(r.a) && stations.has(r.b) && r.a !== r.b && !pairs.has(k), "graph edge", "E_SNAPSHOT_REFERENCE"); pairs.add(k); });
  check(d.aliases !== null && typeof d.aliases === "object" && !Array.isArray(d.aliases), "aliases");
  for (const [k, v] of Object.entries(d.aliases)) { text(k); check(stations.has(v), "graph alias", "E_SNAPSHOT_REFERENCE"); }
  graphSource(d);
  bind(g.graphSemanticSha256, semanticDigest(graphSemanticProjection(g)), "graph digest");
  bind(o.observedGeographySemanticSha256, semanticDigest(observedGeographySemanticProjection({ datasetId: o.datasetId, editionId: o.editionId, rows: o.rows })), "observed digest");
  const r = o.rows;
  const expectedGeometry = { type: "FeatureCollection", features: r.boundary_geometry_feature.map(f => {
    const properties = {}, scalars = { kind: "kind", sourceEdition: "source_edition", officialCode: "official_code", officialName: "official_name", dongId: "dong_id", electoralDongId: "electoral_dong_id", countyTitleId: "county_title_id", guId: "gu_id", name: "name" };
    for (const p of r.boundary_geometry_property.filter(p => p.feature_id === f.id).toSorted((a, b) => a.ordinal - b.ordinal)) {
      properties[p.name] = p.name === "officialDongCodes" ? r.boundary_geometry_dong.filter(x => x.feature_id === f.id).toSorted((a, b) => a.ordinal - b.ordinal).map(x => x.code)
        : p.name === "jurisdictionGuRefs" ? r.boundary_geometry_gu.filter(x => x.feature_id === f.id).toSorted((a, b) => a.ordinal - b.ordinal).map(x => x.gu_ref) : f[scalars[p.name]];
    }
    const polygons = r.boundary_geometry_polygon.filter(x => x.feature_id === f.id).toSorted((a, b) => a.ordinal - b.ordinal).map(p =>
      r.boundary_geometry_ring.filter(x => x.feature_id === f.id && x.polygon_ordinal === p.ordinal).toSorted((a, b) => a.ordinal - b.ordinal).map(ring =>
        r.boundary_geometry_point.filter(x => x.feature_id === f.id && x.polygon_ordinal === p.ordinal && x.ring_ordinal === ring.ordinal).toSorted((a, b) => a.ordinal - b.ordinal).map(x => [x.longitude, x.latitude])));
    return { type: "Feature", id: f.id, properties, geometry: { type: f.geometry_type, coordinates: f.geometry_type === "Polygon" ? polygons[0] : polygons } };
  }) };
  bind(o.geometry, expectedGeometry, "observed geometry derivation");
  bind(c.centralSemanticSha256, semanticDigest({ schema: "janseon-central-semantic.v1",
    graph: { datasetId: g.datasetId, editionId: g.editionId, semanticSha256: g.graphSemanticSha256 },
    observedGeography: { datasetId: o.datasetId, editionId: o.editionId, semanticSha256: o.observedGeographySemanticSha256 } }), "central digest");
  const expected = [{ domain: "graph", datasetId: g.datasetId, editionId: g.editionId }, { domain: "observed-geography", datasetId: o.datasetId, editionId: o.editionId }];
  bind(descriptor.editionRefs, expected, "central content editions");
  for (const [e, h] of [[expected[0], g.graphSemanticSha256], [expected[1], o.observedGeographySemanticSha256]]) bind(s.editions.find(x => key(x) === key(e))?.semanticSha256, h, "source edition digest");
  return c;
}

/** Validates only explicitly supplied blobs; missing bytes never trigger discovery. */
export function validateEditorSnapshotContents(snapshot, contents, context) {
  inspect(snapshot, context, true);
  check(Array.isArray(contents) && Object.getPrototypeOf(contents) === Array.prototype && Reflect.ownKeys(contents).length === contents.length + 1, "contents array");
  const blobs = new Map();
  for (let i = 0; i < contents.length; i++) {
    const cell = Object.getOwnPropertyDescriptor(contents, String(i)); check(cell && "value" in cell && cell.enumerable, "content entry");
    const row = cell.value;
    check(row !== null && typeof row === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(row))
      && Reflect.ownKeys(row).length === 2 && ["contentId", "bytes"].every(k => { const d = Object.getOwnPropertyDescriptor(row, k); return d && "value" in d && d.enumerable; }), "content row");
    opaque(row.contentId); check(row.bytes instanceof Uint8Array && [Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(row.bytes)), "byte array");
    check(!blobs.has(row.contentId) && snapshot.contents.some(d => d.contentId === row.contentId), "duplicate/unlisted blob", "E_SNAPSHOT_REFERENCE");
    blobs.set(row.contentId, Uint8Array.from(row.bytes));
  }
  const loaded = new Map();
  for (const d of snapshot.contents) {
    const bytes = blobs.get(d.contentId); check(bytes !== undefined, "missing blob", "E_SNAPSHOT_CONTENT_MISSING");
    check(bytes.length === d.sizeBytes && sha(bytes) === d.rawSha256, "blob bytes", "E_SNAPSHOT_CONTENT_DIGEST");
    if (["legacy-atlas-reference", "physical-rail-reference"].includes(d.kind)) fail("E_SNAPSHOT_CONTENT_KIND", "typed reader unavailable");
    const value = parse(bytes);
    const encoded = Buffer.from(d.kind === "central-reference" ? JSON.stringify(value) + "\n" : canonicalEncode(value), "utf8");
    check(Buffer.from(bytes).equals(encoded), "content encoding", "E_SNAPSHOT_CONTENT_DIGEST");
    check(!loaded.has(d.kind), "duplicate content role", "E_SNAPSHOT_REFERENCE");
    if (d.kind === "central-reference") readCentral(value, d, snapshot);
    if (d.kind === "identity-reference") {
      exact(value, ["schema", "projectionContract", "sourceContent", "sourceReceipt", "index"]);
      check(value.schema === "janseon-identity-reference.v1" && value.projectionContract === "janseon-identity-index.v1", "identity schema");
      sourceContent(value.sourceContent); receipt(value.sourceReceipt); identityIndex(value.index);
      bind(value.sourceContent, context.expectedIdentityReferenceBinding.sourceContent, "identity source");
      bind(value.sourceReceipt, context.expectedIdentityReferenceBinding.sourceReceipt, "identity receipt");
      bind(value.index.snapshotSha256, snapshot.identitySnapshotSha256, "identity index source");
      bind(semanticDigest(value.index), context.expectedIdentityReferenceBinding.indexSemanticSha256, "independent identity index");
    }
    loaded.set(d.kind, value);
  }
  check(loaded.has("central-reference") && loaded.has("identity-reference") && loaded.has("authored-reference"), "required reference contents", "E_SNAPSHOT_CONTENT_MISSING");
  const a = loaded.get("authored-reference"), c = loaded.get("central-reference"), i = loaded.get("identity-reference").index;
  exact(a, ["schema", "datasetId", "editionId", "baseCentralSemanticSha256", "identitySnapshotSha256", "entities", "geometries", "edgeChanges", "crosswalkChanges", "assignments", "tombstones", "semanticSha256"]);
  check(a.schema === "janseon-authored-edition.v1", "authored schema");
  bind([a.datasetId, a.editionId, a.baseCentralSemanticSha256, a.identitySnapshotSha256], [snapshot.datasetId, snapshot.editionId, c.centralSemanticSha256, snapshot.identitySnapshotSha256], "authored binding");
  const refs = new Set(i.entities.map(e => entityKey(e.ref))), role = new Map();
  i.entities.forEach(e => role.set(entityKey(e.ref), e.ref.entityKind));
  const add = (r, kind) => { entity(r); check(!refs.has(entityKey(r)), "duplicate entity", "E_SNAPSHOT_REFERENCE"); refs.add(entityKey(r)); role.set(entityKey(r), kind); };
  c.graph.document.stations.forEach(r => add({ datasetId: c.graph.datasetId, editionId: c.graph.editionId, entityKind: "graph-station", sourceId: r.id }, "station"));
  c.graph.document.edges.forEach((_, n) => add({ datasetId: c.graph.datasetId, editionId: c.graph.editionId, entityKind: "graph-edge", sourceId: `/edges/${n}` }, "edge"));
  c.observedGeography.rows.boundary_geometry_feature.forEach(f => add({ datasetId: c.observedGeography.datasetId, editionId: c.observedGeography.editionId, entityKind: "observed-feature", sourceId: f.id }, "region"));
  const expectedKind = { entities: ["authored-facility", "authored-settlement"], geometries: ["authored-geometry"], edgeChanges: ["authored-edge-change"], crosswalkChanges: ["authored-crosswalk"] };
  for (const collection of Object.keys(expectedKind)) {
    list(a[collection], r => { entity(r.ref); check(r.ref.datasetId === a.datasetId && r.ref.editionId === a.editionId && expectedKind[collection].includes(r.ref.entityKind), "authored namespace", "E_SNAPSHOT_BINDING");
      add(r.ref, ({ "authored-facility": "facility", "authored-settlement": "settlement", "authored-geometry": "geometry", "authored-edge-change": "edge-change", "authored-crosswalk": "crosswalk" })[r.ref.entityKind]); });
    sorted(a[collection], r => entityTuple(r.ref));
  }
  list(a.tombstones, entity); sorted(a.tombstones, entityTuple);
  const tombstones = new Set(a.tombstones.map(entityKey));
  for (const t of a.tombstones) check(t.datasetId === a.datasetId && t.editionId === a.editionId && !refs.has(entityKey(t)), "live tombstone", "E_SNAPSHOT_REFERENCE");
  const resolve = (r, roles, nullable = false) => { if (r === null && nullable) return; entity(r); check(!tombstones.has(entityKey(r)) && roles.includes(role.get(entityKey(r))), "dangling/wrong-role authored reference", "E_SNAPSHOT_REFERENCE"); };
  const coordinate = p => check(Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "number" && Number.isFinite(n) && !Object.is(n, -0)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90, "coordinate");
  const geometry = (v, location = false) => {
    exact(v, location ? ["crs", "coordinates"] : ["crs", "type", "coordinates"]); check(v.crs === "OGC:CRS84", "authored CRS");
    const ring = r => { list(r, coordinate); check(r.length >= 4 && same(r[0], r.at(-1)), "ring"); };
    const polygon = p => { list(p, ring); check(p.length > 0, "polygon"); };
    if (location || v.type === "Point") coordinate(v.coordinates);
    else if (v.type === "LineString") { list(v.coordinates, coordinate); check(v.coordinates.length >= 2, "line"); }
    else if (v.type === "Polygon") polygon(v.coordinates);
    else if (v.type === "MultiPolygon") { list(v.coordinates, polygon); check(v.coordinates.length > 0, "multi polygon"); }
    else fail("E_SNAPSHOT_SHAPE", "geometry kind");
  };
  for (const r of a.entities) {
    exact(r, ["ref", "geographicParentRef", "location", "footprint"]); resolve(r.geographicParentRef, ["region", "facility", "settlement"], true);
    if (r.location !== null) geometry(r.location, true); if (r.footprint !== null) { geometry(r.footprint); check(["Polygon", "MultiPolygon"].includes(r.footprint.type), "footprint"); }
    const seen = new Set([entityKey(r.ref)]); let p = r.geographicParentRef;
    while (p) { check(!seen.has(entityKey(p)), "parent cycle", "E_SNAPSHOT_REFERENCE"); seen.add(entityKey(p)); p = a.entities.find(x => same(x.ref, p))?.geographicParentRef ?? null; }
  }
  for (const r of a.geometries) { exact(r, ["ref", "ownerRef", "geometry"]); resolve(r.ownerRef, ["region", "facility", "settlement"]); geometry(r.geometry); }
  const baseEdges = new Set(), edgePairs = new Set(), crosswalkPairs = new Set();
  for (const r of a.edgeChanges) {
    exact(r, ["ref", "baseEdgeRef", "a", "b", "sourceReceipt"]); receipt(r.sourceReceipt); resolve(r.baseEdgeRef, ["edge"], true); resolve(r.a, ["station"], true); resolve(r.b, ["station"], true);
    check((r.a === null) === (r.b === null) && (r.a !== null || r.baseEdgeRef !== null), "edge alternatives");
    if (r.baseEdgeRef) { check(!baseEdges.has(r.baseEdgeRef.sourceId), "base edge duplicate", "E_SNAPSHOT_REFERENCE"); baseEdges.add(r.baseEdgeRef.sourceId); }
  }
  const pair = (a, b) => { const k = JSON.stringify([a, b].sort()); check(a !== b && !edgePairs.has(k), "duplicate/self edge", "E_SNAPSHOT_REFERENCE"); edgePairs.add(k); };
  c.graph.document.edges.forEach((e, n) => { if (!baseEdges.has(`/edges/${n}`)) pair(e.a, e.b); });
  a.edgeChanges.forEach(e => { if (e.a) pair(e.a.sourceId, e.b.sourceId); });
  for (const r of a.crosswalkChanges) {
    exact(r, ["ref", "stationRef", "facilityRef", "sourceReceipt"]); receipt(r.sourceReceipt); resolve(r.stationRef, ["station"]); resolve(r.facilityRef, ["facility", "settlement"], true);
    if (r.facilityRef) { const k = JSON.stringify([entityTuple(r.stationRef), entityTuple(r.facilityRef)]); check(!crosswalkPairs.has(k), "crosswalk duplicate", "E_SNAPSHOT_REFERENCE"); crosswalkPairs.add(k); }
  }
  list(a.assignments, r => {
    exact(r, ["kind", "subjectRef", "valueRef"]);
    const roles = { placement: [["person"], ["station"]], holder: [["title"], ["person"]], owner: [["settlement"], ["person"]], control: [["station", "region"], ["polity"]] }[r.kind];
    check(Boolean(roles), "assignment kind"); resolve(r.subjectRef, roles[0]); resolve(r.valueRef, roles[1], true);
    if (r.valueRef && r.kind !== "placement") check(i.entities.find(e => same(e.ref, r.valueRef))?.affiliationStatus !== "unresolved",
      "unresolved political affiliation", "E_SNAPSHOT_REFERENCE");
  }); sorted(a.assignments, r => [r.kind, ...entityTuple(r.subjectRef)]);
  const { semanticSha256, ...projection } = a;
  bind(semanticSha256, semanticDigest({ ...projection, edgeChanges: a.edgeChanges.map(({ sourceReceipt, ...r }) => r), crosswalkChanges: a.crosswalkChanges.map(({ sourceReceipt, ...r }) => r) }), "authored digest");
  const authoredEdition = snapshot.editions.find(e => e.domain === "initial-state" && e.datasetId === a.datasetId && e.editionId === a.editionId);
  check(Boolean(authoredEdition), "authored edition missing", "E_SNAPSHOT_REFERENCE");
  bind(authoredEdition.semanticSha256, semanticSha256, "authored edition digest");
  check(snapshot.snapshotSha256 === digest(snapshot), "snapshot digest", "E_SNAPSHOT_DIGEST");
  return Object.freeze(identity(snapshot));
}
