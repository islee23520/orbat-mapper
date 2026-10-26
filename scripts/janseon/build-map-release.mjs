import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { readCommandReleaseSource, readCommandEditorSource, exportCommandLog } from "./command-store.mjs";
import { createReleaseManifest, validateReleaseManifest } from "./release-manifest.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = value => Buffer.from(canonicalEncode(value) + "\n");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const ref = (domain, value) => ({ domain, datasetId: value.datasetId, editionId: value.editionId });
const sorted = values => values.toSorted((a, b) => {
  const left = a.editionRef ?? a, right = b.editionRef ?? b;
  for (const key of ["domain", "datasetId", "editionId"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
});

// Fixed allowlist: no caller-supplied payloads, fields or extra release members.
function projections(source) {
  const { central: c, authored: a } = source, g = c.graph, o = c.observedGeography;
  const graph = ref("graph", g), observed = ref("observed-geography", o), authored = ref("initial-state", a);
  const lineage = (editionRef, rows) => ({ editionRef, rowsSha256: semanticDigest(rows) });
  const graphOrigin = lineage(graph, g.document), observedOrigin = lineage(observed, o.rows), authoredOrigin = lineage(authored, a);
  const envelope = (kind, data, origins) => ({ schema: "janseon-typed-map-projection.v1", kind, data,
    sourceRows: origins });
  return [
    ["wiki/map-core.json", "map-core", [graph], envelope("map-core", g.document, [graphOrigin])],
    ["wiki/observed-geography.json", "observed-geography", [observed], envelope("observed-geography", o.geometry, [observedOrigin])],
    ["wiki/spatial-assignments.json", "spatial-assignments", [authored], envelope("spatial-assignments", a.assignments, [authoredOrigin])],
    ["wiki/station-bindings.json", "station-bindings", sorted([graph, authored]), envelope("station-bindings", a.crosswalkChanges.map(({ sourceReceipt, ...row }) => row), [graphOrigin, authoredOrigin])],
    ["wiki/underground-geometry.json", "underground-geometry", [graph], envelope("underground-geometry", {
      stations: g.document.stations.map(({ id, lat, lon }) => ({ id, lat, lon })), edges: g.document.edges }, [graphOrigin])],
    // Preserve the existing graph document shape rather than inventing a runtime graph.
    ["game/world-graph.json", "world-graph", [graph], g.document],
    ["game/map-topology.json", "map-topology", [observed], envelope("map-topology", o.geometry, [observedOrigin])],
    ["game/initial-world.json", "initial-world", sorted([graph, authored]), envelope("initial-world", {
      entities: a.entities, geometries: a.geometries, assignments: a.assignments, tombstones: a.tombstones,
      edgeChanges: a.edgeChanges.map(({ sourceReceipt, ...row }) => row),
      crosswalkChanges: a.crosswalkChanges.map(({ sourceReceipt, ...row }) => row) }, [graphOrigin, authoredOrigin])],
    ["game/terrain-manifest.json", "terrain-manifest", [observed], envelope("terrain-manifest", { terrain: [], roads: [], buildings: [] }, [observedOrigin])],
  ].sort(([a], [b]) => a < b ? -1 : 1);
}

/** Synthetic typed builder: no source/rights authorization or publication. */
export function buildMapRelease({ databasePath, binding, provenance, context, license, sourceRows }) {
  const originalBytes = readFileSync(databasePath);
  if (hash(originalBytes) !== provenance.snapshot.databaseSha256) fail("E_BUILD_SOURCE_BYTES");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let source;
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA query_only=ON");
    // A database-byte receipt cannot stand in for uncheckpointed WAL content.
    if (db.prepare("PRAGMA journal_mode").get().journal_mode === "wal") fail("E_BUILD_CHECKPOINT_REQUIRED");
    source = readCommandReleaseSource(db, binding);
    if (Object.hasOwn(provenance, "ledger")) {
      const { head } = readCommandEditorSource(db, binding);
      const ledger = { datasetId: source.authored.datasetId, sequence: head.sequence, generationId: head.generation_id,
        editionId: head.edition_id, mapSemanticSha256: head.map_semantic_sha256, contextSha256: head.context_sha256,
        commandLogSha256: semanticDigest(exportCommandLog(db, binding)) };
      if (canonicalEncode(provenance.ledger) !== canonicalEncode(ledger)) fail("E_BUILD_LEDGER_BINDING");
    }
  } finally { db.close(); }
  if (hash(readFileSync(databasePath)) !== hash(originalBytes)) fail("E_BUILD_SOURCE_CHANGED");
  const { central: c, authored: a } = source;
  // This first unit is explicitly barred from exporting unapproved real data.
  if (![c.graph, c.observedGeography, a].every(value => value.datasetId.startsWith("synthetic:"))) fail("E_BUILD_SYNTHETIC_ONLY");
  const expectedRows = [
    { editionRef: ref("graph", c.graph), rowsSha256: semanticDigest(c.graph.document) },
    { editionRef: ref("observed-geography", c.observedGeography), rowsSha256: semanticDigest(c.observedGeography.rows) },
    { editionRef: ref("initial-state", a), rowsSha256: semanticDigest(a) },
  ];
  if (canonicalEncode(sorted(sourceRows)) !== canonicalEncode(sorted(expectedRows))) fail("E_BUILD_SOURCE_ROWS");
  for (const row of expectedRows) {
    const receipts = provenance.sourceReceipts?.filter(value => canonicalEncode(value.editionRef) === canonicalEncode(row.editionRef));
    if (receipts?.length !== 1 || receipts[0].receipt.sha256 !== row.rowsSha256) fail("E_BUILD_SOURCE_RECEIPT");
  }
  const specs = projections(source), members = {}, memberOrigins = [];
  const metadata = specs.map(([path, kind, editionRefs, value]) => {
    // Native graph aliases are ordered source entries in graph semantics.
    // Canonical object-key sorting destroys that order. Preserve the validated
    // source document's JSON order for both graph transport members only.
    const data = ["wiki/map-core.json", "game/world-graph.json"].includes(path)
      ? Buffer.from(JSON.stringify(value) + "\n") : bytes(value);
    members[path] = data;
    memberOrigins.push({ path, rawSha256: hash(data), sources: expectedRows.filter(row => editionRefs.some(r => canonicalEncode(r) === canonicalEncode(row.editionRef))) });
    return { path, target: path.split("/")[0], kind, sizeBytes: data.length, rawSha256: hash(data),
      visibility: "public", license, identitySnapshotSha256: source.identitySnapshotSha256, editionRefs };
  });
  const graph = ref("graph", c.graph), observed = ref("observed-geography", c.observedGeography), authored = ref("initial-state", a);
  const semantic = { schema: "janseon-map-release-semantic.v1", projectionContract: "janseon-map-release-projection.v1",
    mapSemanticSha256: semanticDigest({ schema: "janseon-release-map.v1", central: c.centralSemanticSha256, authored: a.semanticSha256 }),
    identitySnapshotSha256: source.identitySnapshotSha256,
    editions: sorted([{ ...graph, semanticSha256: c.graph.graphSemanticSha256 }, { ...observed, semanticSha256: c.observedGeography.observedGeographySemanticSha256 }, { ...authored, semanticSha256: a.semanticSha256 }]),
    domains: { graph: { semanticSha256: c.graph.graphSemanticSha256, editionRefs: [graph] },
      geometry: { semanticSha256: c.observedGeography.observedGeographySemanticSha256, editionRefs: [observed] },
      initialState: { semanticSha256: a.semanticSha256, editionRefs: [authored] } },
    targets: ["wiki", "game"], targetAllowlists: Object.fromEntries(["wiki", "game"].map(target => [target, metadata.filter(m => m.target === target).map(m => m.path)])), members: metadata };
  // Caller independently pins source snapshot semantics as well as bytes.
  if (provenance.snapshot.mapSemanticSha256 !== semantic.mapSemanticSha256) fail("E_BUILD_SOURCE_SEMANTIC");
  const manifest = createReleaseManifest({ semantic, provenance }, context);
  return { manifest, manifestBytes: bytes(manifest), members,
    sourceReceipt: { schema: "janseon-release-row-receipt.v1", sourceCommit: provenance.sourceCommit,
      databaseSha256: provenance.snapshot.databaseSha256, mapSemanticSha256: semantic.mapSemanticSha256, memberOrigins } };
}

/** Rebuild against pinned typed source; rehashed payload forgeries still reject. */
export function verifyBuiltMapRelease(candidate, request) {
  validateReleaseManifest(candidate.manifest, request.context);
  const expected = buildMapRelease(request);
  if (canonicalEncode(candidate.manifest) !== canonicalEncode(expected.manifest)
    || !Buffer.from(candidate.manifestBytes).equals(expected.manifestBytes)
    || canonicalEncode(candidate.sourceReceipt) !== canonicalEncode(expected.sourceReceipt)
    || canonicalEncode(Object.keys(candidate.members).sort()) !== canonicalEncode(Object.keys(expected.members).sort())) fail("E_BUILD_RELEASE");
  for (const [path, value] of Object.entries(expected.members)) {
    if (!Buffer.from(candidate.members[path]).equals(value)) fail("E_BUILD_MEMBER");
  }
  return { mapReleaseId: expected.manifest.mapReleaseId, deliveryReceiptId: expected.manifest.deliveryReceiptId };
}
