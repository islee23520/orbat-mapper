import { DatabaseSync } from "node:sqlite";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { centralInputs } from "./central-store-fixture.mjs";
import { importCentralEditions, readCentralSnapshot } from "./central-store.mjs";
import { initializeCommandStore, initializeCommandHead, readCommandEdition } from "./command-store.mjs";
const MODE = "janseon-command-store.v1", H = c => c.repeat(64);
const person = { datasetId: "synthetic:identity", editionId: "i1", entityKind: "person", sourceId: "person-a" };
export const station = id => ({ datasetId: "synthetic:shared", editionId: "one", entityKind: "graph-station", sourceId: id });
export function fixture(t, path = ":memory:", input = centralInputs()) {
  const db = new DatabaseSync(path); t.after(() => { if (db.isOpen) db.close(); });
  initializeCommandStore(db);
  importCentralEditions(db, input, MODE);
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
export function command(db, binding, id, value = null) {
  const current = readCommandEdition(db, binding);
  const targetEntityRefs = [person, ...(value ? [value] : [])].sort((a, b) => canonicalEncode(Object.values(a)) < canonicalEncode(Object.values(b)) ? -1 : 1);
  const commandPackage = { schema: "janseon-map-commands.v1", datasetId: binding.context.authored.datasetId,
    baseGeneration: current.generationId, expectedSemanticHash: current.mapSemanticSha256, identitySnapshotHash: H("1"), operationId: id,
    operations: [{ kind: "placement.set", editionId: current.authored.editionId, args: { personRef: person, stationRef: value }, targetEntityRefs }] };
  const review = { receipt: { contentId: "review-" + id, sha256: H("a") }, inputSha256: semanticDigest(commandPackage), permittedKinds: ["placement.set"], sourceReceipts: [] };
  return { binding, commandPackage, review };
}
