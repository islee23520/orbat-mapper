import { canonical, previewEntity, type ReadSnapshot } from "./editorReadModel";
export type Entity = ReadSnapshot["authored"]["entities"][number];
export type DraftOperation = ReturnType<typeof previewEntity>["operations"][number];
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const base = (snapshot: ReadSnapshot) => ({ head: snapshot.descriptor.head, members: snapshot.descriptor.members });
async function hash(value: unknown) {
  const b = new TextEncoder().encode(canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map(n => n.toString(16).padStart(2, "0")).join("");
}
export function stageLocation(snapshot: ReadSnapshot, entity: Entity, longitude: number, latitude: number): DraftOperation {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90
    || Object.is(longitude, -0) || Object.is(latitude, -0)) throw Error("DRAFT_COORDINATE");
  const original = snapshot.authored.entities.find(e => same(e.ref, entity.ref));
  if (!original || !["authored-facility", "authored-settlement"].includes(original.ref.entityKind)) throw Error("DRAFT_ENTITY");
  const command = previewEntity(snapshot, original).operations[0];
  return { ...command, args: { ...command.args, location: { crs: "OGC:CRS84", coordinates: [longitude, latitude] } } };
}
function validateOperations(snapshot: ReadSnapshot, operations: unknown): asserts operations is DraftOperation[] {
  if (!Array.isArray(operations)) throw Error("DRAFT_COMMANDS");
  const seen = new Set<string>();
  for (const op of operations) {
    const original = snapshot.authored.entities.find(e => same(e.ref, op?.args?.entityRef));
    const coordinates = op?.args?.location?.coordinates;
    if (!original || !Array.isArray(coordinates) || coordinates.length !== 2) throw Error("DRAFT_COMMANDS");
    const expected = stageLocation(snapshot, original, coordinates[0], coordinates[1]);
    const key = canonical(original.ref);
    if (seen.has(key) || !same(op, expected)) throw Error("DRAFT_COMMANDS");
    seen.add(key);
  }
}
export function draftCommand(snapshot: ReadSnapshot, operations: DraftOperation[]) {
  if (!operations.length) return null;
  validateOperations(snapshot, operations);
  const original = previewEntity(snapshot, snapshot.authored.entities[0]);
  return { ...original, operations: JSON.parse(canonical(operations)) as DraftOperation[] };
}
export async function saveDraftSession(snapshot: ReadSnapshot, operations: DraftOperation[]) {
  validateOperations(snapshot, operations);
  const payload = { schema: "janseon-editor-draft.v1", base: base(snapshot), operations: JSON.parse(canonical(operations)) as DraftOperation[] };
  return JSON.stringify({ ...payload, sha256: await hash(payload) }, null, 2) + "\n";
}
export async function reopenDraftSession(text: string, snapshot: ReadSnapshot): Promise<DraftOperation[]> {
  const parsed = JSON.parse(text);
  if (!parsed || Object.keys(parsed).length !== 4 || parsed.schema !== "janseon-editor-draft.v1"
    || !["base", "operations", "sha256"].every(k => Object.hasOwn(parsed, k))) throw Error("DRAFT_SHAPE");
  const { sha256, ...payload } = parsed;
  if (await hash(payload) !== sha256) throw Error("DRAFT_TAMPERED");
  if (!same(parsed.base, base(snapshot))) throw Error("DRAFT_STALE_BASE");
  validateOperations(snapshot, parsed.operations);
  return structuredClone(parsed.operations);
}
