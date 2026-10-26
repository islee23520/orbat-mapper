import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { assertStoreSchema, initializeStoreSchema } from "./store-schema.mjs";
import { readCentralSnapshot } from "./central-store.mjs";
import { applyAuthoringCommands } from "./command-validate.mjs";

const MODE = "janseon-command-store.v1";
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonicalEncode(a) === canonicalEncode(b);
const mapHash = (central, authored) => semanticDigest({ schema: "janseon-command-map.v1",
  centralSemanticSha256: central.centralSemanticSha256, authoredSemanticSha256: authored.semanticSha256 });
const generation = result => semanticDigest({ schema: "janseon-command-generation.v1",
  baseGeneration: result.baseGeneration, inputSha256: result.inputSha256,
  editionId: result.newEdition.editionId, authoredSemanticSha256: result.authoredSemanticSha256 });
function transaction(db, write, action) {
  if (db.isTransaction) fail("E_COMMAND_STORE_TRANSACTION");
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    assertStoreSchema(db, MODE);
    const result = action(); db.exec("COMMIT"); return result;
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}
function base(db, binding) {
  const central = readCentralSnapshot(db, binding.central, MODE);
  const context = { ...structuredClone(binding.context), central, replay: null };
  if (!same(binding.context.central, central)) fail("E_COMMAND_STORE_BINDING");
  // Review is per-command input. Every other immutable context field is pinned.
  const { review, replay, ...authority } = context;
  return { context, contextSha256: semanticDigest(authority) };
}
function current(db, binding) {
  const { context, contextSha256 } = base(db, binding), datasetId = context.authored.datasetId;
  const head = db.prepare("SELECT * FROM map_command_head WHERE dataset_id=?").get(datasetId);
  if (!head || head.context_sha256 !== contextSha256) fail("E_COMMAND_STORE_BINDING");
  const rows = db.prepare("SELECT * FROM map_command_log WHERE dataset_id=? ORDER BY sequence").all(datasetId);
  const accepted = new Map();
  for (const [index, row] of rows.entries()) {
    if (row.sequence !== index + 1 || row.context_sha256 !== contextSha256) fail("E_COMMAND_STORE_REPLAY");
    const commandPackage = JSON.parse(row.command_json), review = JSON.parse(row.review_json);
    const result = applyAuthoringCommands(commandPackage, { ...context, review });
    const generationId = generation(result);
    if (row.operation_id !== result.operationId || row.input_sha256 !== result.inputSha256
      || row.base_generation !== result.baseGeneration || row.base_edition_id !== result.baseEditionId
      || row.generation_id !== generationId || row.edition_id !== result.newEdition.editionId
      || row.authored_semantic_sha256 !== result.authoredSemanticSha256) fail("E_COMMAND_STORE_REPLAY");
    accepted.set(row.operation_id, { commandPackage, result });
    context.authored = structuredClone(result.newEdition);
    context.generationId = generationId;
    context.mapSemanticSha256 = mapHash(context.central, context.authored);
  }
  if (head.sequence !== rows.length || head.generation_id !== context.generationId
    || head.edition_id !== context.authored.editionId || head.map_semantic_sha256 !== context.mapSemanticSha256)
    fail("E_COMMAND_STORE_REPLAY");
  return { context, contextSha256, head, accepted };
}

/** Opt-in exact central+command schema; existing central schemas stay strict. */
export function initializeCommandStore(db) { initializeStoreSchema(db, MODE); }

/** Explicit pinned baseline, not an authentication or source-acceptance event. */
export function initializeCommandHead(db, binding) {
  return transaction(db, true, () => {
    const { context, contextSha256 } = base(db, binding);
    db.prepare("INSERT INTO map_command_head VALUES(?,?,?,?,?,?)").run(context.authored.datasetId, 0,
      context.generationId, context.authored.editionId, context.mapSemanticSha256, contextSha256);
    return { generationId: context.generationId, editionId: context.authored.editionId };
  });
}

export function readCommandEdition(db, binding) {
  return transaction(db, false, () => {
    const { context } = current(db, binding);
    return { generationId: context.generationId, mapSemanticSha256: context.mapSemanticSha256,
      authored: context.authored };
  });
}

/** Complete typed release inputs from one verified ledger/central read snapshot. */
export function readCommandReleaseSource(db, binding) {
  return transaction(db, false, () => {
    const { context } = current(db, binding);
    return { central: context.central, authored: context.authored,
      identitySnapshotSha256: context.identitySnapshotSha256 };
  });
}

/** Reserve the sole writer until the checkpoint consumer finishes. No acceptance. */
export function withCommandReleaseCheckpoint(db, binding, consume) {
  return transaction(db, true, () => {
    const datasetId = binding.context.authored.datasetId;
    const head = db.prepare("SELECT * FROM map_command_head WHERE dataset_id=?").get(datasetId);
    const count = db.prepare("SELECT count(*) n FROM map_command_log WHERE dataset_id=?").get(datasetId).n;
    if (head && count > head.sequence) fail("E_RELEASE_UNAPPLIED_COMMANDS");
    const state = current(db, binding);
    const rows = db.prepare("SELECT command_json,review_json FROM map_command_log WHERE dataset_id=? ORDER BY sequence").all(datasetId);
    const log = { schema: "janseon-command-log.v1", contextSha256: state.contextSha256,
      commands: rows.map(row => ({ commandPackage: JSON.parse(row.command_json), review: JSON.parse(row.review_json) })) };
    return consume({ datasetId, sequence: state.head.sequence, generationId: state.head.generation_id,
      editionId: state.head.edition_id, mapSemanticSha256: state.head.map_semantic_sha256,
      contextSha256: state.contextSha256, commandLogSha256: semanticDigest(log) });
  });
}

/** Editor head and typed references share the same verified read transaction. */
export function readCommandEditorSource(db, binding) {
  return transaction(db, false, () => {
    const { context, head } = current(db, binding);
    return { central: context.central, authored: context.authored,
      identitySnapshotSha256: context.identitySnapshotSha256, head: { ...head } };
  });
}

/** Owns one write transaction: validate current references, append, CAS, commit. */
export function acceptCommandPackage(db, { binding, commandPackage, review }) {
  return transaction(db, true, () => {
    const state = current(db, binding), previous = state.accepted.get(commandPackage.operationId);
    if (previous) {
      if (!same(previous.commandPackage, commandPackage)) fail("E_COMMAND_REPLAY");
      return { ...previous.result, replayed: true };
    }
    if (commandPackage.baseGeneration !== state.head.generation_id
      || commandPackage.operations?.some(op => op.editionId !== state.head.edition_id)) fail("E_COMMAND_STALE");
    const result = applyAuthoringCommands(commandPackage, { ...state.context, review });
    const generationId = generation(result), mapSemanticSha256 = mapHash(state.context.central, result.newEdition);
    db.prepare("INSERT INTO map_command_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(commandPackage.datasetId,
      state.head.sequence + 1, result.operationId, result.inputSha256, result.baseGeneration, result.baseEditionId,
      generationId, result.newEdition.editionId, result.authoredSemanticSha256, state.contextSha256,
      canonicalEncode(commandPackage), canonicalEncode(review));
    const changed = db.prepare("UPDATE map_command_head SET sequence=?,generation_id=?,edition_id=?,map_semantic_sha256=? WHERE dataset_id=? AND sequence=? AND generation_id=? AND edition_id=?").run(
      state.head.sequence + 1, generationId, result.newEdition.editionId, mapSemanticSha256,
      commandPackage.datasetId, state.head.sequence, result.baseGeneration, result.baseEditionId);
    if (changed.changes !== 1) fail("E_COMMAND_STORE_STALE");
    return result;
  });
}

/** Ordered portable inputs, not SQL pages or writable JSON map authority. */
export function exportCommandLog(db, binding) {
  return transaction(db, false, () => {
    const state = current(db, binding);
    return { schema: "janseon-command-log.v1", contextSha256: state.contextSha256,
      commands: db.prepare("SELECT command_json,review_json FROM map_command_log WHERE dataset_id=? ORDER BY sequence")
        .all(state.context.authored.datasetId).map(row => ({ commandPackage: JSON.parse(row.command_json), review: JSON.parse(row.review_json) })) };
  });
}

/** Read-only package preparation; review remains an independent caller input. */
export function prepareCommandLog(db, { binding, commandPackage, review }) {
  return transaction(db, false, () => {
    const state = current(db, binding);
    applyAuthoringCommands(commandPackage, { ...state.context, review });
    if (state.accepted.has(commandPackage.operationId)) fail("E_COMMAND_REPLAY");
    const commands = db.prepare("SELECT command_json,review_json FROM map_command_log WHERE dataset_id=? ORDER BY sequence")
      .all(state.context.authored.datasetId).map(row => ({ commandPackage: JSON.parse(row.command_json), review: JSON.parse(row.review_json) }));
    return { schema: "janseon-command-log.v1", contextSha256: state.contextSha256,
      commands: [...commands, { commandPackage, review }] };
  });
}

/** Each accepted package is atomic; ordered replay fails on a stale/tampered entry. */
export function replayCommandLog(db, { binding, package: exported }) {
  if (exported?.schema !== "janseon-command-log.v1" || !Array.isArray(exported.commands)
    || Object.keys(exported).length !== 3) fail("E_COMMAND_STORE_REPLAY");
  const identity = transaction(db, false, () => base(db, binding).contextSha256);
  if (exported.contextSha256 !== identity) fail("E_COMMAND_STORE_BINDING");
  return exported.commands.map(row => {
    if (!row || Object.keys(row).length !== 2 || !Object.hasOwn(row, "commandPackage") || !Object.hasOwn(row, "review")) fail("E_COMMAND_STORE_REPLAY");
    return acceptCommandPackage(db, { binding, ...row });
  });
}
