import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { assertStoreSchema, initializeStoreSchema } from "./store-schema.mjs";
import { importGraphEdition, readGraphEdition } from "./graph-store.mjs";
import { importObservedGeographyEdition, readObservedGeographyEdition } from "./observed-geography-store.mjs";

const MODE = "janseon-central-store.v1";

function pair(options) {
  canonicalEncode(options);
  if (!options || Array.isArray(options) || typeof options !== "object"
      || Object.keys(options).length !== 2 || !Object.hasOwn(options, "graph")
      || !Object.hasOwn(options, "observedGeography")) {
    throw Object.assign(new Error("E_CENTRAL_SHAPE: exact graph/observedGeography pair required"), { code: "E_CENTRAL_SHAPE" });
  }
}

function boundaryError(error) {
  if (error.code === "E_STORE_SCHEMA") {
    throw Object.assign(new Error("E_CENTRAL_SCHEMA: " + error.message), { code: "E_CENTRAL_SCHEMA" });
  }
  throw error;
}

// Only these two synchronous central operations use this private scope helper.
function transaction(db, write, action, mode = MODE) {
  const started = !db.isTransaction;
  const savepoint = write ? "map_central_import" : "map_central_read";
  if (started) db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  let saved = false;
  try {
    db.exec("SAVEPOINT " + savepoint); saved = true;
    assertStoreSchema(db, mode); // Main sqlite_schema SELECT establishes the read snapshot.
    const result = action();
    db.exec(started ? "COMMIT" : "RELEASE " + savepoint);
    return result;
  } catch (error) {
    if (db.isTransaction) {
      if (saved) db.exec("ROLLBACK TO " + savepoint + "; RELEASE " + savepoint);
      if (started) db.exec("ROLLBACK");
    }
    boundaryError(error);
  }
}

/** Exact two-domain schema, not source admission or an accepted generation. */
export function initializeCentralStore(db) {
  try { initializeStoreSchema(db, MODE); } catch (error) { boundaryError(error); }
}

/** Both imports and their ordinary typed readbacks commit or roll back together. */
export function importCentralEditions(db, options, mode = MODE) {
  pair(options);
  return transaction(db, true, () => {
    const graph = importGraphEdition(db, options.graph, mode);
    const observedGeography = importObservedGeographyEdition(db, options.observedGeography, mode);
    readCentralSnapshot(db, {
      graph: { datasetId: graph.datasetId, editionId: graph.editionId, expectedBinding: options.graph.expectedBinding },
      observedGeography: { datasetId: observedGeography.datasetId, editionId: observedGeography.editionId,
        expectedBinding: options.observedGeography.expectedBinding },
    }, mode);
    return { schema: "janseon-central-import.v1", graph, observedGeography };
  }, mode);
}

/** One SQLite snapshot of an explicitly pinned pair; not approval of that pair. */
export function readCentralSnapshot(db, options, mode = MODE) {
  pair(options);
  return transaction(db, false, () => {
    const graph = readGraphEdition(db, options.graph, mode);
    const observedGeography = readObservedGeographyEdition(db, options.observedGeography, mode);
    const centralSemanticSha256 = semanticDigest({ schema: "janseon-central-semantic.v1",
      graph: { datasetId: graph.datasetId, editionId: graph.editionId, semanticSha256: graph.graphSemanticSha256 },
      observedGeography: { datasetId: observedGeography.datasetId, editionId: observedGeography.editionId,
        semanticSha256: observedGeography.observedGeographySemanticSha256 },
    });
    return { schema: "janseon-central-snapshot.v1", graph, observedGeography, centralSemanticSha256 };
  }, mode);
}
