export interface EntityRef { datasetId: string; editionId: string; entityKind: string; sourceId: string }
export interface SnapshotHead { datasetId: string; editionId: string; generationId: string; sequence: number; mapSemanticSha256: string; identitySnapshotSha256: string }
export interface ReadSnapshot {
  descriptor: { schema: string; readonly: true; head: SnapshotHead; members: { path: string; sizeBytes: number; rawSha256: string; semanticSha256: string }[] };
  central: { schema: string; graph: { datasetId: string; editionId: string; document: { stations: Record<string, unknown>[]; edges: Record<string, unknown>[] } }; observedGeography: { geometry: { features: Record<string, unknown>[] } } };
  authored: { schema: string; datasetId: string; editionId: string; identitySnapshotSha256: string; entities: { ref: EntityRef; geographicParentRef: EntityRef | null; location: unknown; footprint: unknown }[]; assignments: Record<string, unknown>[] };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(result)].map(n => n.toString(16).padStart(2, "0")).join("");
}
export async function loadReadSnapshot(files: { name: string; text(): Promise<string> }[], expectedGeneration: string): Promise<ReadSnapshot> {
  if (!expectedGeneration.match(/^[a-f0-9]{64}$/)) throw Error("EXPECTED_GENERATION_REQUIRED");
  if (files.length !== 3 || new Set(files.map(f => f.name)).size !== 3) throw Error("SNAPSHOT_FILES_REQUIRED");
  const byName = new Map(await Promise.all(files.map(async f => [f.name, await f.text()] as const)));
  const descriptor = JSON.parse(byName.get("edition.json") ?? "null");
  if (descriptor?.schema !== "janseon-editor-edition-read.v1" || descriptor.readonly !== true || descriptor.members?.length !== 2) throw Error("SNAPSHOT_DESCRIPTOR");
  if (descriptor.head?.generationId !== expectedGeneration) throw Error("STALE_SNAPSHOT");
  for (const path of ["references/central.json", "references/authored.json"]) {
    const member = descriptor.members.filter((m: { path: string }) => m.path === path);
    const text = byName.get(path.split("/").at(-1)!);
    if (member.length !== 1 || text === undefined) throw Error("SNAPSHOT_MEMBER_MISSING");
    const bytes = new TextEncoder().encode(text);
    if (bytes.length !== member[0].sizeBytes || await digest(bytes) !== member[0].rawSha256
      || await digest(new TextEncoder().encode(canonical(JSON.parse(text)))) !== member[0].semanticSha256) throw Error("SNAPSHOT_MEMBER_HASH");
  }
  const central = JSON.parse(byName.get("central.json")!), authored = JSON.parse(byName.get("authored.json")!);
  if (central.schema !== "janseon-central-snapshot.v1" || authored.schema !== "janseon-authored-edition.v1"
    || authored.editionId !== descriptor.head.editionId || authored.datasetId !== descriptor.head.datasetId
    || authored.identitySnapshotSha256 !== descriptor.head.identitySnapshotSha256) throw Error("SNAPSHOT_BINDING");
  if (!central.graph?.document?.stations?.length || !central.graph.document.edges?.length
    || !central.observedGeography?.geometry?.features?.length || !Array.isArray(authored.assignments) || !Array.isArray(authored.entities)) throw Error("EMPTY_SNAPSHOT");
  return { descriptor, central, authored };
}
export function previewEntity(snapshot: ReadSnapshot, entity: ReadSnapshot["authored"]["entities"][number]) {
  return { schema: "janseon-map-commands.v1", datasetId: snapshot.authored.datasetId,
    baseGeneration: snapshot.descriptor.head.generationId, expectedSemanticHash: snapshot.descriptor.head.mapSemanticSha256,
    identitySnapshotHash: snapshot.descriptor.head.identitySnapshotSha256, operationId: "preview-only",
    operations: [{ kind: "entity.update", editionId: snapshot.authored.editionId,
      args: { entityRef: entity.ref, geographicParentRef: entity.geographicParentRef, location: entity.location, footprint: entity.footprint },
      targetEntityRefs: [entity.ref, ...(entity.geographicParentRef ? [entity.geographicParentRef] : [])]
        .filter((ref, i, all) => all.findIndex(r => canonical(r) === canonical(ref)) === i)
        .sort((a, b) => { const x = [a.datasetId, a.editionId, a.entityKind, a.sourceId], y = [b.datasetId, b.editionId, b.entityKind, b.sourceId]; for (let i = 0; i < 4; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; } return 0; }) }] };
}
