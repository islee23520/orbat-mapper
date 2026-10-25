import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { readCommandEditorSource } from "./command-store.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const bytes = value => Buffer.from(canonicalEncode(value) + "\n");
const hash = value => createHash("sha256").update(value).digest("hex");

/** Read model only: supplied database is opened read-only; no map writer here.
 * Uses merged central/authored DTOs, not the unapproved release-payload draft.
 */
export function exportEditorSnapshot({ databasePath, binding, expectedHead }) {
  canonicalEncode(expectedHead);
  const keys = ["datasetId", "editionId", "generationId", "sequence", "mapSemanticSha256", "identitySnapshotSha256"];
  if (!expectedHead || Object.keys(expectedHead).length !== keys.length || !keys.every(k => Object.hasOwn(expectedHead, k))) fail("E_EDITOR_HEAD_SHAPE");
  const before = hash(readFileSync(databasePath));
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let snapshot;
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA query_only=ON");
    const source = readCommandEditorSource(db, binding), head = source.head;
    const actualHead = { datasetId: source.authored.datasetId, editionId: source.authored.editionId,
      generationId: head.generation_id, sequence: head.sequence, mapSemanticSha256: head.map_semantic_sha256,
      identitySnapshotSha256: source.identitySnapshotSha256 };
    if (canonicalEncode(actualHead) !== canonicalEncode(expectedHead)) fail("E_EDITOR_STALE_HEAD");
    const refs = {
      "references/central.json": source.central,
      "references/authored.json": source.authored,
    };
    // PR4 central-reference encoding preserves source-owned object/alias order.
    const encodeMember = (path, value) => path === "references/central.json"
      ? Buffer.from(JSON.stringify(value) + "\n") : bytes(value);
    const members = Object.entries(refs).map(([path, value]) => ({ path, semanticSha256: semanticDigest(value),
      rawSha256: hash(encodeMember(path, value)), sizeBytes: encodeMember(path, value).length }));
    snapshot = { descriptor: { schema: "janseon-editor-edition-read.v1", readonly: true, head: actualHead,
      editions: [{ domain: "graph", datasetId: source.central.graph.datasetId, editionId: source.central.graph.editionId,
        semanticSha256: source.central.graph.graphSemanticSha256 },
      { domain: "observed-geography", datasetId: source.central.observedGeography.datasetId, editionId: source.central.observedGeography.editionId,
        semanticSha256: source.central.observedGeography.observedGeographySemanticSha256 },
      { domain: "initial-state", datasetId: source.authored.datasetId, editionId: source.authored.editionId,
        semanticSha256: source.authored.semanticSha256 }], members },
      files: Object.fromEntries(Object.entries(refs).map(([path, value]) => [path, encodeMember(path, value)])) };
    snapshot.files["edition.json"] = bytes(snapshot.descriptor);
  } finally { db.close(); }
  if (hash(readFileSync(databasePath)) !== before) fail("E_EDITOR_SOURCE_CHANGED");
  return snapshot;
}

/** Verify detached JSON members against a fresh independently pinned store read. */
export function verifyEditorSnapshot(candidate, request) {
  const expected = exportEditorSnapshot(request);
  if (canonicalEncode(candidate.descriptor) !== canonicalEncode(expected.descriptor)
    || canonicalEncode(Object.keys(candidate.files).sort()) !== canonicalEncode(Object.keys(expected.files).sort())) fail("E_EDITOR_SNAPSHOT_MEMBER");
  for (const [path, value] of Object.entries(expected.files)) {
    if (!Buffer.from(candidate.files[path]).equals(value)) fail("E_EDITOR_SNAPSHOT_MEMBER");
  }
  return { generationId: expected.descriptor.head.generationId, editionId: expected.descriptor.head.editionId };
}
