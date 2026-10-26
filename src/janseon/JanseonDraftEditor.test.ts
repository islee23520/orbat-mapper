/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { webcrypto } from "node:crypto";
import JanseonDraftEditor from "./JanseonDraftEditor.vue";
import { saveDraftSession, reopenDraftSession, stageLocation } from "./draftSession";
import type { ReadSnapshot } from "./editorReadModel";
vi.mock("./JanseonMapCanvas.vue", () => ({ default: { template: "<div />" } }));
const save = vi.fn((_blob: Blob) => "blob:synthetic-draft");
const snapshot = (): ReadSnapshot => ({ descriptor: { schema: "janseon-editor-edition-read.v1", readonly: true,
  head: { datasetId: "synthetic:a", editionId: "base", generationId: "a".repeat(64), sequence: 0, mapSemanticSha256: "b".repeat(64), identitySnapshotSha256: "c".repeat(64) }, members: [] },
  central: { schema: "janseon-central-snapshot.v1", graph: { datasetId: "g", editionId: "one", document: { stations: [], edges: [] } }, observedGeography: { geometry: { features: [] } } },
  authored: { schema: "janseon-authored-edition.v1", datasetId: "synthetic:a", editionId: "base", identitySnapshotSha256: "c".repeat(64), assignments: [],
    entities: [{ ref: { datasetId: "synthetic:a", editionId: "base", entityKind: "authored-facility", sourceId: "facility" }, geographicParentRef: null, location: { crs: "OGC:CRS84", coordinates: [127, 37] }, footprint: null }] } });
async function action(wrapper: ReturnType<typeof mount>, selector: string, file?: { text(): Promise<string> }) {
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  await wrapper.setProps({ onSettled: finish });
  if (file) { Object.defineProperty(wrapper.get(selector).element, "files", { configurable: true, value: [file] }); await wrapper.get(selector).trigger("change"); }
  else await wrapper.get(selector).trigger("click");
  await done;
}
describe("client draft session", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto); save.mockClear();
    vi.stubGlobal("URL", { createObjectURL: save, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  it("stages diff, saves and reopens exact draft then passes accumulated commands to existing submission", async () => {
    const s = snapshot(), original = JSON.stringify(s);
    const wrapper = mount(JanseonDraftEditor, { props: { snapshot: s, entity: s.authored.entities[0] } });
    await wrapper.get('[data-testid="draft-longitude"]').setValue("127.2");
    await wrapper.get('[data-testid="stage-edit"]').trigger("click");
    const diff = JSON.parse(wrapper.get('[data-testid="draft-diff"]').text());
    expect(diff[0].before.coordinates).toEqual([127, 37]); expect(diff[0].after.coordinates).toEqual([127.2, 37]);
    await action(wrapper, '[data-testid="save-draft"]');
    const blob = save.mock.calls[0][0];
    const text = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsText(blob); });
    await wrapper.get('[data-testid="clear-draft"]').trigger("click");
    expect(JSON.parse(wrapper.get('[data-testid="draft-command"]').text())).toBe(null);
    await action(wrapper, '[data-testid="draft-file"]', { text: async () => text });
    const command = JSON.parse(wrapper.get('[data-testid="draft-command"]').text());
    expect(command.operations).toHaveLength(1); expect(command.operations[0].args.location.coordinates).toEqual([127.2, 37]);
    expect(wrapper.findComponent({ name: "JanseonCommandSubmit" }).props("command")).toEqual(command);
    expect(JSON.stringify(s)).toBe(original);
    wrapper.unmount();
  });
  it("resets the native file selection so the same saved file can reopen after clear", async () => {
    const s = snapshot();
    const text = await saveDraftSession(s, [stageLocation(s, s.authored.entities[0], 127.2, 37)]);
    const file = { text: async () => text };
    const wrapper = mount(JanseonDraftEditor, { props: { snapshot: s, entity: s.authored.entities[0] } });
    const input = wrapper.get('[data-testid="draft-file"]').element as HTMLInputElement;
    let nativeSelection = "";
    Object.defineProperty(input, "value", { configurable: true,
      get: () => nativeSelection, set: value => { nativeSelection = value; } });
    async function chooseSameFile() {
      const path = "C:\\fakepath\\map-draft-session.json";
      if (nativeSelection === path) return; // Native inputs emit no change for the same selection.
      nativeSelection = path;
      await action(wrapper, '[data-testid="draft-file"]', file);
    }
    await chooseSameFile();
    const expected = wrapper.get('[data-testid="draft-command"]').text();
    expect(JSON.parse(expected).operations).toHaveLength(1);
    expect(input.value).toBe("");
    await wrapper.get('[data-testid="clear-draft"]').trigger("click");
    expect(JSON.parse(wrapper.get('[data-testid="draft-command"]').text())).toBe(null);
    await chooseSameFile();
    expect(wrapper.get('[data-testid="draft-command"]').text()).toBe(expected);
    expect(input.value).toBe("");
    wrapper.unmount();
  });
  it("rejects tampered and stale saved sessions without retaining staged commands", async () => {
    const s = snapshot(), op = stageLocation(s, s.authored.entities[0], 127.3, 37);
    const text = await saveDraftSession(s, [op]), changed = JSON.parse(text); changed.operations[0].args.location.coordinates[0] = 128;
    const wrapper = mount(JanseonDraftEditor, { props: { snapshot: s, entity: s.authored.entities[0] } });
    await action(wrapper, '[data-testid="draft-file"]', { text: async () => JSON.stringify(changed) });
    expect(wrapper.get('[data-testid="draft-error"]').text()).toBe("DRAFT_TAMPERED");
    const stale = snapshot(); stale.descriptor.head.sequence = 1;
    await wrapper.setProps({ snapshot: stale });
    await action(wrapper, '[data-testid="draft-file"]', { text: async () => text });
    expect(wrapper.get('[data-testid="draft-error"]').text()).toBe("DRAFT_STALE_BASE");
    expect(JSON.parse(wrapper.get('[data-testid="draft-command"]').text())).toBe(null);
    wrapper.unmount();
  });
  it("validates supported edit shape even if the checksum is recomputed", async () => {
    const s = snapshot(), op = stageLocation(s, s.authored.entities[0], 127.1, 37);
    const data = JSON.parse(await saveDraftSession(s, [op])); data.operations[0].kind = "entity.tombstone";
    const { canonical } = await import("./editorReadModel"); const { sha256, ...payload } = data;
    data.sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(payload))))].map(n => n.toString(16).padStart(2, "0")).join("");
    await expect(reopenDraftSession(JSON.stringify(data), s)).rejects.toThrow("DRAFT_COMMANDS");
    expect(() => stageLocation(s, s.authored.entities[0], 181, 37)).toThrow("DRAFT_COORDINATE");
  });
});
