import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { graphSemanticProjection } from "./graph-store.mjs";
import { observedGeographySemanticProjection } from "./observed-geography-store.mjs";

const fail = (code, detail, operationIndex) => {
  throw Object.assign(new Error(`${code}: ${detail}`), { code, ...(operationIndex === undefined ? {} : { operationIndex }) });
};
const check = (yes, detail, code = "E_COMMAND_SHAPE") => { if (!yes) fail(code, detail); };
const exact = (v, keys) => check(v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), "exact keys");
const text = v => check(typeof v === "string" && v.isWellFormed() && v.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(v), "text");
const hash = v => check(typeof v === "string" && /^[a-f0-9]{64}$/u.test(v), "hash");
const opaque = v => { text(v); check(![".", ".."].includes(v) && !/[\\/%]/u.test(v) && !/^[A-Za-z]:/u.test(v), "opaque id"); };
const receipt = v => { exact(v, ["contentId", "sha256"]); opaque(v.contentId); hash(v.sha256); };
const list = (v, fn) => { check(Array.isArray(v), "array"); v.forEach(fn); };
const same = (a, b) => canonicalEncode(a) === canonicalEncode(b);
const tuple = r => [r.datasetId, r.editionId, r.entityKind, r.sourceId];
const key = r => JSON.stringify(tuple(r));
const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; }
  return 0;
};
const sorted = (v, select) => check(v.every((x, i) => !i || compare(select(v[i - 1]), select(x)) < 0), "sorted unique", "E_COMMAND_REFERENCE");
const ref = r => { exact(r, ["datasetId", "editionId", "entityKind", "sourceId"]); Object.values(r).forEach(text); };
const nullableRef = r => { if (r !== null) ref(r); };
const entityKinds = ["authored-facility", "authored-settlement"];
const assignments = ["placement", "holder", "owner", "control"];
const kinds = ["entity.create", "entity.update", "entity.tombstone", "geometry.overlay.create", "geometry.overlay.set",
  "graph.edge.create", "graph.edge.change", "graph.crosswalk.create", "graph.crosswalk.change",
  "placement.set", "holder.set", "owner.set", "control.set", "baseline.restore"];
const slots = ["entity", "geometry", "edge-change", "crosswalk", ...assignments];
const finite = n => typeof n === "number" && Number.isFinite(n) && !Object.is(n, -0);
function point(p) {
  check(Array.isArray(p) && p.length === 2 && p.every(finite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90, "coordinate");
}
function geometry(v, location = false) {
  exact(v, location ? ["crs", "coordinates"] : ["crs", "type", "coordinates"]);
  check(v.crs === "OGC:CRS84", "CRS");
  const ring = r => { list(r, point); check(r.length >= 4 && same(r[0], r.at(-1)), "closed ring"); };
  const polygon = p => { list(p, ring); check(p.length > 0, "polygon"); };
  if (location || v.type === "Point") point(v.coordinates);
  else if (v.type === "LineString") { list(v.coordinates, point); check(v.coordinates.length >= 2, "line"); }
  else if (v.type === "Polygon") polygon(v.coordinates);
  else if (v.type === "MultiPolygon") { list(v.coordinates, polygon); check(v.coordinates.length > 0, "polygons"); }
  else fail("E_COMMAND_SHAPE", "geometry type");
}
function spatial(v, primary = "ref") {
  exact(v, [primary, "geographicParentRef", "location", "footprint"]); ref(v[primary]); nullableRef(v.geographicParentRef);
  check(entityKinds.includes(v[primary].entityKind), "authored entity kind", "E_COMMAND_IMMUTABLE");
  if (v.location !== null) geometry(v.location, true);
  if (v.footprint !== null) { geometry(v.footprint); check(["Polygon", "MultiPolygon"].includes(v.footprint.type), "footprint"); }
}
function edge(v, primary = "ref") {
  exact(v, [primary, "baseEdgeRef", "a", "b", "sourceReceipt"]); ref(v[primary]);
  [v.baseEdgeRef, v.a, v.b].forEach(nullableRef); receipt(v.sourceReceipt);
  check((v.a === null) === (v.b === null) && (v.a !== null || v.baseEdgeRef !== null), "edge alternatives");
}
function crosswalk(v, primary = "ref") {
  exact(v, [primary, "stationRef", "facilityRef", "sourceReceipt"]); ref(v[primary]); ref(v.stationRef); nullableRef(v.facilityRef); receipt(v.sourceReceipt);
}
function overlay(v, primary = "ref") { exact(v, [primary, "ownerRef", "geometry"]); ref(v[primary]); ref(v.ownerRef); geometry(v.geometry); }
function authoredHash(a) {
  const { semanticSha256, ...projection } = a;
  return semanticDigest({ ...projection,
    edgeChanges: a.edgeChanges.map(({ sourceReceipt, ...row }) => row),
    crosswalkChanges: a.crosswalkChanges.map(({ sourceReceipt, ...row }) => row) });
}
function authored(a) {
  exact(a, ["schema", "datasetId", "editionId", "baseCentralSemanticSha256", "identitySnapshotSha256", "entities", "geometries", "edgeChanges", "crosswalkChanges", "assignments", "tombstones", "semanticSha256"]);
  check(a.schema === "janseon-authored-edition.v1", "authored schema"); text(a.datasetId); text(a.editionId);
  [a.baseCentralSemanticSha256, a.identitySnapshotSha256, a.semanticSha256].forEach(hash);
  list(a.entities, r => spatial(r)); list(a.geometries, r => overlay(r)); list(a.edgeChanges, r => edge(r)); list(a.crosswalkChanges, r => crosswalk(r));
  list(a.assignments, r => { exact(r, ["kind", "subjectRef", "valueRef"]); check(assignments.includes(r.kind), "assignment kind"); ref(r.subjectRef); nullableRef(r.valueRef); });
  list(a.tombstones, ref);
  const expected = [entityKinds, ["authored-geometry"], ["authored-edge-change"], ["authored-crosswalk"]];
  [a.entities, a.geometries, a.edgeChanges, a.crosswalkChanges].forEach((rows, i) => {
    sorted(rows, r => tuple(r.ref));
    for (const r of rows) check(r.ref.datasetId === a.datasetId && r.ref.editionId === a.editionId && expected[i].includes(r.ref.entityKind), "authored namespace", "E_COMMAND_BINDING");
  });
  sorted(a.assignments, r => [r.kind, ...tuple(r.subjectRef)]); sorted(a.tombstones, tuple);
  for (const r of a.tombstones) check(r.datasetId === a.datasetId && r.editionId === a.editionId
    && [...entityKinds, "authored-geometry"].includes(r.entityKind), "tombstone namespace", "E_COMMAND_BINDING");
  check(a.semanticSha256 === authoredHash(a), "authored digest", "E_COMMAND_BINDING");
}
function graphSource(document) {
  const referenceCode = "E_COMMAND_REFERENCE";
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
function central(c) {
  exact(c, ["schema", "graph", "observedGeography", "centralSemanticSha256"]);
  check(c.schema === "janseon-central-snapshot.v1", "central schema");
  exact(c.graph, ["datasetId", "editionId", "document", "graphSemanticSha256"]);
  exact(c.observedGeography, ["datasetId", "editionId", "rows", "geometry", "observedGeographySemanticSha256"]);
  for (const x of [c.graph, c.observedGeography]) { text(x.datasetId); text(x.editionId); }
  const g = c.graph, o = c.observedGeography, d = g.document;
  exact(d, ["schema", "districts", "stations", "edges", "aliases", "source"]); check(d.schema === "seoul-world-graph-v2", "graph schema");
  list(d.districts, text); check(new Set(d.districts).size === d.districts.length, "district duplicate", "E_COMMAND_REFERENCE");
  list(d.stations, s => { exact(s, ["id", "nameKo", "nameEn", "district", "lat", "lon"]); [s.id, s.nameKo, s.nameEn, s.district].forEach(text); check(finite(s.lat) && finite(s.lon), "station coordinates"); });
  const stations = new Set(d.stations.map(s => s.id)); check(stations.size === d.stations.length, "duplicate station", "E_COMMAND_REFERENCE");
  check(d.stations.every(s => d.districts.includes(s.district)), "district reference", "E_COMMAND_REFERENCE");
  const pairs = new Set();
  list(d.edges, e => { exact(e, ["a", "b"]); text(e.a); text(e.b); const p = JSON.stringify([e.a, e.b].sort());
    check(stations.has(e.a) && stations.has(e.b) && e.a !== e.b && !pairs.has(p), "graph edge", "E_COMMAND_REFERENCE"); pairs.add(p); });
  check(d.aliases !== null && typeof d.aliases === "object" && !Array.isArray(d.aliases), "aliases");
  for (const [k, v] of Object.entries(d.aliases)) { text(k); text(v); check(stations.has(v), "alias", "E_COMMAND_REFERENCE"); }
  graphSource(d);
  check(g.graphSemanticSha256 === semanticDigest(graphSemanticProjection(g)), "graph digest", "E_COMMAND_BINDING");
  check(o.observedGeographySemanticSha256 === semanticDigest(observedGeographySemanticProjection({ datasetId: o.datasetId, editionId: o.editionId, rows: o.rows })), "observed digest", "E_COMMAND_BINDING");
  check(c.centralSemanticSha256 === semanticDigest({ schema: "janseon-central-semantic.v1",
    graph: { datasetId: g.datasetId, editionId: g.editionId, semanticSha256: g.graphSemanticSha256 },
    observedGeography: { datasetId: o.datasetId, editionId: o.editionId, semanticSha256: o.observedGeographySemanticSha256 } }), "central digest", "E_COMMAND_BINDING");
}
function command(c) {
  exact(c, ["kind", "args", "editionId", "targetEntityRefs"]); text(c.editionId);
  check(kinds.includes(c.kind), "kind", "E_COMMAND_KIND");
  const a = c.args;
  if (["entity.create", "entity.update"].includes(c.kind)) spatial(a, "entityRef");
  else if (c.kind === "entity.tombstone") {
    exact(a, ["entityRef", "referenceResolutions"]); ref(a.entityRef);
    list(a.referenceResolutions, r => { exact(r, ["ownerRef", "slot", "replacementRef"]); ref(r.ownerRef); nullableRef(r.replacementRef);
      check(["geographic-parent", "geometry-owner", "crosswalk-facility", "owner-subject"].includes(r.slot), "resolution slot"); });
    sorted(a.referenceResolutions, r => [...tuple(r.ownerRef), r.slot]);
  } else if (c.kind.startsWith("geometry.")) overlay(a, "geometryRef");
  else if (c.kind.startsWith("graph.edge.")) edge(a, "changeRef");
  else if (c.kind.startsWith("graph.crosswalk.")) crosswalk(a, "crosswalkRef");
  else if (c.kind === "baseline.restore") { exact(a, ["targetRef", "slot"]); ref(a.targetRef); check(slots.includes(a.slot), "restore slot"); }
  else {
    const fields = { "placement.set": ["personRef", "stationRef"], "holder.set": ["titleRef", "personRef"], "owner.set": ["settlementRef", "personRef"], "control.set": ["locationRef", "polityRef"] }[c.kind];
    exact(a, fields); ref(a[fields[0]]); nullableRef(a[fields[1]]);
  }
  list(c.targetEntityRefs, ref); sorted(c.targetEntityRefs, tuple);
  const refs = new Map();
  function visit(v) { if (!v || typeof v !== "object") return;
    if (Object.hasOwn(v, "entityKind")) { ref(v); refs.set(key(v), v); }
    else Object.values(v).forEach(visit); }
  visit(a);
  check(same(c.targetEntityRefs, [...refs.values()].sort((a, b) => compare(tuple(a), tuple(b)))), "target reference closure", "E_COMMAND_REFERENCE");
}
function contextShape(c) {
  exact(c, ["schema", "generationId", "mapSemanticSha256", "identitySnapshotSha256", "central", "authored", "baseline", "identity", "referenceEntities", "sourceReceipts", "review", "replay"]);
  check(c.schema === "janseon-authoring-context.v1", "context schema");
  [c.generationId, c.mapSemanticSha256, c.identitySnapshotSha256].forEach(hash); central(c.central); authored(c.authored); authored(c.baseline);
  exact(c.identity, ["snapshotSha256", "entities"]); hash(c.identity.snapshotSha256);
  list(c.identity.entities, e => { exact(e, ["ref", "affiliationRefs", "affiliationStatus"]); ref(e.ref);
    check(["person", "polity", "bloc"].includes(e.ref.entityKind), "identity kind"); list(e.affiliationRefs, ref); sorted(e.affiliationRefs, tuple);
    check(["resolved", "none", "unresolved"].includes(e.affiliationStatus), "affiliation status"); });
  sorted(c.identity.entities, e => tuple(e.ref));
  for (const e of c.identity.entities) for (const r of e.affiliationRefs) check(c.identity.entities.some(x => same(x.ref, r)), "affiliation reference", "E_COMMAND_REFERENCE");
  list(c.referenceEntities, e => { exact(e, ["ref", "role"]); ref(e.ref); check(["title", "region", "facility", "settlement"].includes(e.role), "reference role"); });
  sorted(c.referenceEntities, e => tuple(e.ref)); list(c.sourceReceipts, receipt);
  exact(c.review, ["receipt", "inputSha256", "permittedKinds", "sourceReceipts"]); receipt(c.review.receipt); hash(c.review.inputSha256);
  list(c.review.permittedKinds, k => check(kinds.includes(k), "review kind")); sorted(c.review.permittedKinds, k => [k]); list(c.review.sourceReceipts, receipt);
}
function index(c, a) {
  const entries = new Map();
  const add = (r, role) => { check(!entries.has(key(r)), "duplicate canonical key", "E_COMMAND_REFERENCE"); entries.set(key(r), role); };
  const g = c.central.graph, o = c.central.observedGeography;
  const gr = (kind, id) => ({ datasetId: g.datasetId, editionId: g.editionId, entityKind: kind, sourceId: id });
  g.document.stations.forEach(s => add(gr("graph-station", s.id), "station"));
  g.document.edges.forEach((_, i) => add(gr("graph-edge", `/edges/${i}`), "edge"));
  o.rows.boundary_geometry_feature.forEach(f => add({ datasetId: o.datasetId, editionId: o.editionId, entityKind: "observed-feature", sourceId: f.id }, "region"));
  c.identity.entities.forEach(e => add(e.ref, e.ref.entityKind)); c.referenceEntities.forEach(e => add(e.ref, e.role));
  for (const rows of [a.entities, a.geometries, a.edgeChanges, a.crosswalkChanges]) for (const row of rows) {
    add(row.ref, ({ "authored-facility": "facility", "authored-settlement": "settlement", "authored-geometry": "geometry", "authored-edge-change": "edge-change", "authored-crosswalk": "crosswalk" })[row.ref.entityKind]);
  }
  return (r, roles, nullable = false) => {
    if (r === null && nullable) return;
    if (r?.entityKind === "graph-edge" && !/^\/edges\/(0|[1-9][0-9]*)$/u.test(r.sourceId)) fail("E_COMMAND_ORDINAL", "edge locator");
    if (r?.entityKind === "graph-edge" && r.datasetId === g.datasetId && r.editionId === g.editionId
      && (!Number.isSafeInteger(Number(r.sourceId.slice(7))) || Number(r.sourceId.slice(7)) >= g.document.edges.length)) fail("E_COMMAND_ORDINAL", "edge ordinal");
    check(r !== null && !a.tombstones.some(t => same(t, r)) && roles.includes(entries.get(key(r))), "unresolved or wrong-role reference", "E_COMMAND_REFERENCE");
  };
}
function stateReferences(c, a) {
  const resolve = index(c, a), parents = ["region", "facility", "settlement"];
  for (const r of a.entities) {
    resolve(r.ref, ["facility", "settlement"]); resolve(r.geographicParentRef, parents, true);
    const seen = new Set([key(r.ref)]); let p = r.geographicParentRef;
    while (p) { check(!seen.has(key(p)), "parent cycle", "E_COMMAND_REFERENCE"); seen.add(key(p)); p = a.entities.find(x => same(x.ref, p))?.geographicParentRef ?? null; }
  }
  a.geometries.forEach(r => resolve(r.ownerRef, parents));
  const baseEdges = new Set(), pairs = new Set(), crossPairs = new Set();
  for (const r of a.edgeChanges) {
    resolve(r.baseEdgeRef, ["edge"], true); resolve(r.a, ["station"], true); resolve(r.b, ["station"], true);
    if (r.baseEdgeRef) { check(!baseEdges.has(key(r.baseEdgeRef)), "duplicate base edge", "E_COMMAND_REFERENCE"); baseEdges.add(key(r.baseEdgeRef)); }
  }
  const g = c.central.graph;
  const pair = (x, y) => { const p = JSON.stringify([x, y].sort()); check(x !== y && !pairs.has(p), "duplicate/self edge", "E_COMMAND_REFERENCE"); pairs.add(p); };
  g.document.edges.forEach((r, i) => { if (!a.edgeChanges.some(e => e.baseEdgeRef?.sourceId === `/edges/${i}`)) pair(r.a, r.b); });
  a.edgeChanges.forEach(r => { if (r.a) pair(r.a.sourceId, r.b.sourceId); });
  for (const r of a.crosswalkChanges) { resolve(r.stationRef, ["station"]); resolve(r.facilityRef, ["facility", "settlement"], true);
    if (r.facilityRef) { const p = JSON.stringify([tuple(r.stationRef), tuple(r.facilityRef)]); check(!crossPairs.has(p), "duplicate crosswalk", "E_COMMAND_REFERENCE"); crossPairs.add(p); } }
  for (const r of a.assignments) {
    const [subjects, values] = { placement: [["person"], ["station"]], holder: [["title"], ["person"]], owner: [["settlement"], ["person"]], control: [["station", "region"], ["polity"]] }[r.kind];
    resolve(r.subjectRef, subjects); resolve(r.valueRef, values, true);
    if (r.valueRef && r.kind !== "placement") check(c.identity.entities.find(e => same(e.ref, r.valueRef))?.affiliationStatus !== "unresolved", "unresolved political affiliation", "E_COMMAND_REFERENCE");
  }
}
function incoming(a, t) {
  return [...a.entities.filter(r => same(r.geographicParentRef, t)).map(r => ({ ownerRef: r.ref, slot: "geographic-parent" })),
    ...a.geometries.filter(r => same(r.ownerRef, t)).map(r => ({ ownerRef: r.ref, slot: "geometry-owner" })),
    ...a.crosswalkChanges.filter(r => same(r.facilityRef, t)).map(r => ({ ownerRef: r.ref, slot: "crosswalk-facility" })),
    ...a.assignments.filter(r => r.kind === "owner" && same(r.subjectRef, t)).map(r => ({ ownerRef: r.subjectRef, slot: "owner-subject" }))]
    .sort((a, b) => compare([...tuple(a.ownerRef), a.slot], [...tuple(b.ownerRef), b.slot]));
}
function freeze(v) { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function execute(pkg, c) {
  try { canonicalEncode(pkg); canonicalEncode(c); } catch { fail("E_COMMAND_SHAPE", "canonical data required"); }
  exact(pkg, ["schema", "datasetId", "baseGeneration", "expectedSemanticHash", "identitySnapshotHash", "operationId", "operations"]);
  check(pkg.schema === "janseon-map-commands.v1", "command schema"); text(pkg.datasetId); opaque(pkg.operationId);
  [pkg.baseGeneration, pkg.expectedSemanticHash, pkg.identitySnapshotHash].forEach(hash); check(Array.isArray(pkg.operations) && pkg.operations.length > 0, "operations");
  pkg.operations.forEach((op, i) => { try { command(op); } catch (e) { e.operationIndex = i; throw e; } });
  contextShape(c);
  const inputSha256 = semanticDigest(pkg);
  // Simulation mutates its own rows, including rows created by earlier commands.
  pkg = structuredClone(pkg);
  if (c.replay !== null) {
    const r = c.replay; exact(r, ["datasetId", "operationId", "inputSha256", "commandPackage", "result"]);
    check(r.datasetId === pkg.datasetId && r.operationId === pkg.operationId && r.inputSha256 === inputSha256 && same(r.commandPackage, pkg), "replay input", "E_COMMAND_REPLAY");
    const result = r.result;
    exact(result, ["schema", "operationId", "inputSha256", "baseGeneration", "baseEditionId", "newEdition", "authoredSemanticSha256", "release", "replayed"]);
    check(result.schema === "janseon-command-result.v1" && result.operationId === pkg.operationId && result.inputSha256 === inputSha256
      && result.baseGeneration === pkg.baseGeneration && result.baseEditionId === pkg.operations[0].editionId && result.replayed === false
      && same(result.release, { state: "unbuilt", mapReleaseId: null, deliveryReceiptId: null }), "replay result", "E_COMMAND_REPLAY");
    try { authored(result.newEdition); } catch { fail("E_COMMAND_REPLAY", "replay edition"); }
    const semanticOperations = pkg.operations.map(op => { if (!op.kind.startsWith("graph.")) return op; const { sourceReceipt, ...args } = op.args; return { ...op, args }; });
    const expectedEdition = "authored-sha256:" + semanticDigest({ schema: "janseon-authored-edit.v1", datasetId: pkg.datasetId, baseEditionId: result.baseEditionId,
      baseGeneration: pkg.baseGeneration, identitySnapshotHash: pkg.identitySnapshotHash, operations: semanticOperations });
    check(result.authoredSemanticSha256 === result.newEdition.semanticSha256 && result.newEdition.datasetId === pkg.datasetId
      && result.newEdition.editionId === expectedEdition, "replay result binding", "E_COMMAND_REPLAY");
    // Replay may precede a later head, but its typed inputs must still be the
    // independently pinned historical identity/source context, not latest data.
    check(result.newEdition.identitySnapshotSha256 === pkg.identitySnapshotHash
      && c.identitySnapshotSha256 === pkg.identitySnapshotHash && c.identity.snapshotSha256 === pkg.identitySnapshotHash
      && result.newEdition.baseCentralSemanticSha256 === c.central.centralSemanticSha256,
    "replay historical context binding", "E_COMMAND_REPLAY");
    try { stateReferences(c, result.newEdition); } catch { fail("E_COMMAND_REPLAY", "replay result references"); }
    return freeze(structuredClone({ ...result, replayed: true }));
  }
  check(pkg.datasetId === c.authored.datasetId && pkg.expectedSemanticHash === c.mapSemanticSha256 && pkg.identitySnapshotHash === c.identitySnapshotSha256
    && c.identity.snapshotSha256 === c.identitySnapshotSha256 && c.authored.identitySnapshotSha256 === c.identitySnapshotSha256
    && c.authored.baseCentralSemanticSha256 === c.central.centralSemanticSha256, "context binding", "E_COMMAND_BINDING");
  check(pkg.baseGeneration === c.generationId && pkg.operations.every(op => op.editionId === c.authored.editionId), "stale base", "E_COMMAND_STALE");
  check(c.review.inputSha256 === inputSha256 && pkg.operations.every(op => c.review.permittedKinds.includes(op.kind)), "review scope", "E_COMMAND_REVIEW");
  const a = structuredClone(c.authored);
  stateReferences(c, a);
  for (let i = 0; i < pkg.operations.length; i++) {
    try {
      const op = pkg.operations[i], v = op.args, resolve = index(c, a);
      if (op.kind === "entity.tombstone") {
        check(entityKinds.includes(v.entityRef.entityKind), "immutable target", "E_COMMAND_IMMUTABLE");
        const allRefs = [v.entityRef, ...c.identity.entities.map(e => e.ref), ...c.referenceEntities.map(e => e.ref)];
        check([a.datasetId, c.central.graph.datasetId, c.central.observedGeography.datasetId, ...allRefs.map(r => r.datasetId)].every(d => d.startsWith("synthetic:")), "missing real reverse-reference coverage", "E_COMMAND_REFERENCE_COVERAGE");
        resolve(v.entityRef, ["facility", "settlement"]);
        check(same(incoming(a, v.entityRef), v.referenceResolutions.map(({ ownerRef, slot }) => ({ ownerRef, slot }))), "resolution coverage", "E_COMMAND_REFERENCE");
        for (const r of v.referenceResolutions) {
          const groups = { "geographic-parent": [a.entities, "geographicParentRef"], "geometry-owner": [a.geometries, "ownerRef"], "crosswalk-facility": [a.crosswalkChanges, "facilityRef"], "owner-subject": [a.assignments, "subjectRef"] };
          const [rows, field] = groups[r.slot];
          resolve(r.replacementRef, r.slot === "owner-subject" ? ["settlement"] : r.slot === "crosswalk-facility" ? ["facility", "settlement"] : ["region", "facility", "settlement"], true);
          const at = rows.findIndex(row => same(r.slot === "owner-subject" ? row.subjectRef : row.ref, r.ownerRef) && (r.slot !== "owner-subject" || row.kind === "owner"));
          check(at >= 0, "resolution owner", "E_COMMAND_REFERENCE");
          if (r.replacementRef === null && ["geometry-owner", "owner-subject"].includes(r.slot)) {
            if (r.slot === "geometry-owner") a.tombstones.push(rows[at].ref);
            rows.splice(at, 1);
          } else {
            if (r.slot === "owner-subject") check(!rows.some((x, j) => j !== at && x.kind === "owner" && same(x.subjectRef, r.replacementRef)), "owner collision", "E_COMMAND_REFERENCE");
            rows[at][field] = r.replacementRef;
          }
        }
        check(incoming(a, v.entityRef).length === 0, "remaining incoming ref", "E_COMMAND_REFERENCE");
        a.entities.splice(a.entities.findIndex(r => same(r.ref, v.entityRef)), 1); a.tombstones.push(v.entityRef);
      } else if (op.kind === "baseline.restore") {
        check(c.baseline.datasetId === a.datasetId && c.baseline.baseCentralSemanticSha256 === a.baseCentralSemanticSha256 && c.baseline.identitySnapshotSha256 === a.identitySnapshotSha256, "baseline binding", "E_COMMAND_BASELINE");
        check(!a.tombstones.some(t => same(t, v.targetRef)), "retired restore", "E_COMMAND_IMMUTABLE");
        const collection = { entity: "entities", geometry: "geometries", "edge-change": "edgeChanges", crosswalk: "crosswalkChanges" }[v.slot];
        const roles = { entity: ["facility", "settlement"], geometry: ["geometry"], "edge-change": ["edge-change"], crosswalk: ["crosswalk"], placement: ["person"], holder: ["title"], owner: ["settlement"], control: ["station", "region"] }[v.slot];
        resolve(v.targetRef, roles);
        const local = r => r.datasetId === a.datasetId && r.editionId === c.baseline.editionId ? { ...r, editionId: a.editionId } : r;
        const baseline = structuredClone(c.baseline);
        function rebind(x) { if (x && typeof x === "object") { if (Object.hasOwn(x, "entityKind")) Object.assign(x, local(x)); else Object.values(x).forEach(rebind); } }
        rebind(baseline);
        const rows = collection ? a[collection] : a.assignments, old = collection ? baseline[collection] : baseline.assignments;
        const matches = row => same(collection ? row.ref : row.subjectRef, v.targetRef) && (collection || row.kind === v.slot);
        const previous = old.find(matches), at = rows.findIndex(matches);
        if (!previous) { check(v.slot !== "entity", "missing baseline entity", "E_COMMAND_BASELINE"); if (at >= 0) rows.splice(at, 1); }
        else if (at >= 0) rows[at] = previous; else rows.push(previous);
      } else if (assignments.some(k => op.kind === k + ".set")) {
        const kind = op.kind.split(".")[0], fields = { placement: ["personRef", "stationRef"], holder: ["titleRef", "personRef"], owner: ["settlementRef", "personRef"], control: ["locationRef", "polityRef"] }[kind];
        const row = { kind, subjectRef: v[fields[0]], valueRef: v[fields[1]] };
        const at = a.assignments.findIndex(r => r.kind === kind && same(r.subjectRef, row.subjectRef));
        if (at < 0) a.assignments.push(row); else a.assignments[at] = row;
      } else {
        const [collection, primary, role] = op.kind.startsWith("entity.") ? ["entities", "entityRef", ["facility", "settlement"]]
          : op.kind.startsWith("geometry.") ? ["geometries", "geometryRef", ["geometry"]]
            : op.kind.startsWith("graph.edge.") ? ["edgeChanges", "changeRef", ["edge-change"]] : ["crosswalkChanges", "crosswalkRef", ["crosswalk"]];
        const r = v[primary], expected = { geometries: ["authored-geometry"], edgeChanges: ["authored-edge-change"], crosswalkChanges: ["authored-crosswalk"], entities: entityKinds }[collection];
        check(expected.includes(r.entityKind) && r.datasetId === a.datasetId && r.editionId === a.editionId, "immutable/nonlocal target", "E_COMMAND_IMMUTABLE");
        check(!a.tombstones.some(t => same(t, r)), "retired identity", "E_COMMAND_IMMUTABLE");
        const at = a[collection].findIndex(row => same(row.ref, r));
        if (op.kind.endsWith(".create")) check(at < 0, "existing create target", "E_COMMAND_REFERENCE");
        else { check(at >= 0, "missing existing target", "E_COMMAND_REFERENCE"); resolve(r, role); }
        if (v.sourceReceipt) check(c.sourceReceipts.some(x => same(x, v.sourceReceipt)) && c.review.sourceReceipts.some(x => same(x, v.sourceReceipt)), "source review", "E_COMMAND_REVIEW");
        const { [primary]: ignored, ...rest } = v, row = { ref: r, ...rest };
        if (at < 0) a[collection].push(row); else a[collection][at] = row;
      }
      stateReferences(c, a);
      for (const t of a.tombstones) check(incoming(a, t).length === 0, "tombstone reintroduced", "E_COMMAND_REFERENCE");
    } catch (e) { e.operationIndex = i; throw e; }
  }
  const semanticOperations = pkg.operations.map(op => { if (!op.kind.startsWith("graph.")) return op; const { sourceReceipt, ...args } = op.args; return { ...op, args }; });
  const editionId = "authored-sha256:" + semanticDigest({ schema: "janseon-authored-edit.v1", datasetId: pkg.datasetId, baseEditionId: c.authored.editionId,
    baseGeneration: pkg.baseGeneration, identitySnapshotHash: pkg.identitySnapshotHash, operations: semanticOperations });
  function rebind(v) { if (v && typeof v === "object") { if (Object.hasOwn(v, "entityKind") && v.datasetId === a.datasetId && v.editionId === a.editionId) v.editionId = editionId; else Object.values(v).forEach(rebind); } }
  // Working rows may still point into package args: detach before rebinding.
  const resultEdition = structuredClone(a); rebind(resultEdition); resultEdition.editionId = editionId;
  for (const k of ["entities", "geometries", "edgeChanges", "crosswalkChanges"]) resultEdition[k].sort((a, b) => compare(tuple(a.ref), tuple(b.ref)));
  resultEdition.assignments.sort((a, b) => compare([a.kind, ...tuple(a.subjectRef)], [b.kind, ...tuple(b.subjectRef)])); resultEdition.tombstones.sort((a, b) => compare(tuple(a), tuple(b)));
  resultEdition.semanticSha256 = authoredHash(resultEdition); authored(resultEdition); stateReferences(c, resultEdition);
  return freeze({ schema: "janseon-command-result.v1", operationId: pkg.operationId, inputSha256, baseGeneration: pkg.baseGeneration,
    baseEditionId: c.authored.editionId, newEdition: resultEdition, authoredSemanticSha256: resultEdition.semanticSha256,
    release: { state: "unbuilt", mapReleaseId: null, deliveryReceiptId: null }, replayed: false });
}

/** Pure full-package validation: simulation checks sequential references without writes. */
export function validateAuthoringCommands(commandPackage, context) {
  const result = execute(commandPackage, context);
  return Object.freeze({ schema: "janseon-command-validation.v1", inputSha256: result.inputSha256 });
}

/** Detached immutable reduction only; never a database write or accepted release. */
export function applyAuthoringCommands(commandPackage, context) { return execute(commandPackage, context); }
