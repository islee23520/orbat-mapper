/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { webcrypto, createHash } from "node:crypto";
import JanseonPanel from "./JanseonPanel.vue";
import { canonical, loadReadSnapshot } from "./editorReadModel";
vi.mock("./JanseonMapCanvas.vue", () => ({ default: { template: "<div />" } }));
const copy = vi.fn();
vi.mock("@vueuse/core", () => ({ useClipboard: () => ({ copy, copied: false }) }));
const H = "a".repeat(64);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(empty = false) {
  const entityRef = { datasetId: "synthetic:author", editionId: "one", entityKind: "authored-facility", sourceId: "facility-a" };
  const central = { schema: "janseon-central-snapshot.v1", graph: { datasetId: "synthetic:graph", editionId: "one", document: {
    stations: empty ? [] : [{ id: "station-a", nameKo: "Station A" }], edges: [{ a: "station-a", b: "station-b" }] } },
    observedGeography: { geometry: { features: [{ id: "region-a" }] } } };
  const authored = { schema: "janseon-authored-edition.v1", datasetId: "synthetic:author", editionId: "one", identitySnapshotSha256: H,
    entities: [{ ref: entityRef, geographicParentRef: null, location: null, footprint: null }], assignments: [{ kind: "placement", valueRef: null }] };
  const members = { "central.json": JSON.stringify(central) + "\n", "authored.json": canonical(authored) + "\n" };
  const descriptor = { schema: "janseon-editor-edition-read.v1", readonly: true,
    head: { datasetId: authored.datasetId, editionId: "one", generationId: H, sequence: 1, mapSemanticSha256: H, identitySnapshotSha256: H },
    members: Object.entries(members).map(([name, text]) => ({ path: "references/" + name, sizeBytes: new TextEncoder().encode(text).length,
      rawSha256: sha(text), semanticSha256: sha(canonical(JSON.parse(text))) })) };
  return { files: [...Object.entries(members), ["edition.json", JSON.stringify(descriptor)]].map(([name, text]) => ({ name, text: async () => text })), entityRef };
}
async function open(wrapper: ReturnType<typeof mount>, files: ReturnType<typeof fixture>["files"], generation = H) {
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  await wrapper.setProps({ onSettled: complete });
  await wrapper.get('[data-testid="expected-generation"]').setValue(generation);
  Object.defineProperty(wrapper.get('[data-testid="snapshot-files"]').element, "files", { configurable: true, value: files });
  await wrapper.get('[data-testid="snapshot-files"]').trigger("change");
  await done;
  await flushPromises();
}
describe("readonly Seoul edition inspector", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); copy.mockReset(); });
  it("loads snapshot domains, previews entity command and copies without mutating inputs or writing", async () => {
    const f = fixture(), before = await Promise.all(f.files.map(file => file.text()));
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const storage = vi.spyOn(Storage.prototype, "setItem"); storage.mockClear();
    const wrapper = mount(JanseonPanel); await open(wrapper, f.files);
    expect(wrapper.find('[data-testid="snapshot-ready"]').exists()).toBe(true);
    const preview = JSON.parse(wrapper.get('[data-testid="command-preview"]').text());
    expect(preview).toMatchObject({ schema: "janseon-map-commands.v1", baseGeneration: H, operationId: "preview-only",
      operations: [{ kind: "entity.update", editionId: "one", args: { entityRef: f.entityRef, geographicParentRef: null, location: null, footprint: null }, targetEntityRefs: [f.entityRef] }] });
    await wrapper.get('[data-testid="copy-preview"]').trigger("click");
    expect(JSON.parse(copy.mock.calls[0][0])).toEqual(preview);
    expect(network).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
    expect(await Promise.all(f.files.map(file => file.text()))).toEqual(before);
    await wrapper.get('[data-testid="domain-select"]').setValue("stations");
    expect(wrapper.get('[data-testid="reference-detail"]').text()).toContain("station-a");
    expect(wrapper.get('[data-testid="copy-preview"]').attributes("disabled")).toBeDefined();
    storage.mockRestore(); wrapper.unmount();
  });
  it("displays empty and stale rejection and clears previously loaded data", async () => {
    const wrapper = mount(JanseonPanel); await open(wrapper, fixture().files);
    await open(wrapper, fixture().files, "b".repeat(64));
    expect(wrapper.get('[data-testid="snapshot-error"]').text()).toBe("STALE_SNAPSHOT");
    expect(wrapper.find('[data-testid="snapshot-ready"]').exists()).toBe(false);
    await open(wrapper, fixture(true).files);
    expect(wrapper.get('[data-testid="snapshot-error"]').text()).toBe("EMPTY_SNAPSHOT");
    wrapper.unmount();
  });
  it("rejects incomplete files and altered member bytes", async () => {
    const f = fixture(); await expect(loadReadSnapshot(f.files.slice(1), H)).rejects.toThrow("SNAPSHOT_FILES_REQUIRED");
    f.files[0].text = async () => "{}";
    await expect(loadReadSnapshot(f.files, H)).rejects.toThrow("SNAPSHOT_MEMBER_HASH");
  });
});
