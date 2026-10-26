/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import JanseonDraftEditor from "./JanseonDraftEditor.vue";
import { editorMapData } from "./editorMapData";
import { saveDraftSession } from "./draftSession";
import type { ReadSnapshot } from "./editorReadModel";
import { webcrypto } from "node:crypto";
vi.mock("@/modules/maplibreview/maplibreWorkerUrl", () => ({ default: "synthetic-worker-url" }));

const runtime = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => void>(), sources: new Map<string, any>(), removed: vi.fn() }));
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: vi.fn(), NavigationControl: class {},
  Map: class {
    container: HTMLElement;
    dragPan = { disable: vi.fn(), enable: vi.fn() };
    constructor(options: { container: HTMLElement }) { this.container = options.container; }
    on(event: string, layer: string | ((...args: any[]) => void), handler?: (...args: any[]) => void) { runtime.handlers.set(`${event}:${typeof layer === "string" ? layer : ""}`, handler ?? layer as (...args: any[]) => void); }
    addSource(id: string, source: any) { runtime.sources.set(id, { data: source.data, setData(value: any) { this.data = value; } }); }
    getSource(id: string) { return runtime.sources.get(id); }
    once(_event: string, handler: () => void) { handler(); }
    addLayer() {} addControl() {} fitBounds() {} resize() {}
    getCanvas() { return this.container; }
    unproject(point: number[]) { return { lng: 127 + point[0] / 1000, lat: 37 + point[1] / 1000 }; }
    remove() { runtime.removed(); }
  },
  Marker: class {
    element: HTMLElement;
    constructor(options: { element: HTMLElement }) { this.element = options.element; }
    setLngLat() { return this; }
    addTo(map: { container: HTMLElement }) { map.container.append(this.element); return this; }
    remove() { this.element.remove(); }
  },
}));

const snapshot = (): ReadSnapshot => ({
  descriptor: { schema: "janseon-editor-edition-read.v1", readonly: true, head: { datasetId: "a", editionId: "one", generationId: "a".repeat(64), sequence: 0, mapSemanticSha256: "b".repeat(64), identitySnapshotSha256: "c".repeat(64) }, members: [] },
  central: { schema: "janseon-central-snapshot.v1", graph: { datasetId: "g", editionId: "one", document: { stations: [{ id: "s1", lon: 127, lat: 37 }, { id: "s2", lon: 127.2, lat: 37.1 }], edges: [{ a: "s1", b: "s2" }] } }, observedGeography: { geometry: { features: [{ type: "Feature", id: "boundary", properties: { kind: "dong" }, geometry: { type: "Polygon", coordinates: [[[126.9, 36.9], [127.3, 36.9], [127.3, 37.3], [126.9, 36.9]]] } }] } } },
  authored: { schema: "janseon-authored-edition.v1", datasetId: "a", editionId: "one", identitySnapshotSha256: "c".repeat(64), assignments: [], entities: [{ ref: { datasetId: "a", editionId: "one", entityKind: "authored-facility", sourceId: "facility" }, geographicParentRef: null, footprint: null, location: { crs: "OGC:CRS84", coordinates: [127, 37] } }] },
});
async function open() {
  const s = snapshot(), wrapper = mount(JanseonDraftEditor, { props: { snapshot: s, entity: s.authored.entities[0] } });
  runtime.handlers.get("load:")!(); await nextTick();
  return { s, wrapper };
}
async function drag(element: Element) {
  for (const [type, x, y] of [["pointerdown", 0, 0], ["pointermove", 200, 100], ["pointerup", 200, 100]] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y }); element.dispatchEvent(event);
  }
  await nextTick();
}
describe("snapshot map canvas", () => {
  beforeEach(() => {
    runtime.handlers.clear(); runtime.sources.clear(); runtime.removed.mockClear();
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    HTMLElement.prototype.setPointerCapture = vi.fn();
  });
  it("deterministically renders existing CRS84 stations, endpoint edges and observed polygons without mutating the snapshot", async () => {
    const { s, wrapper } = await open(); const before = JSON.stringify(s);
    expect(editorMapData(s, []).stations).toEqual([{ id: "s1", point: [127, 37] }, { id: "s2", point: [127.2, 37.1] }]);
    expect(wrapper.findAll('[data-testid="station-marker"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="authored-marker"]')).toHaveLength(1);
    expect(runtime.sources.get("edges").data.features[0].geometry.coordinates).toEqual([[127, 37], [127.2, 37.1]]);
    expect(runtime.sources.get("observed").data.features).toEqual(s.central.observedGeography.geometry.features);
    expect(JSON.stringify(s)).toBe(before); wrapper.unmount(); expect(runtime.removed).toHaveBeenCalledOnce();
  });
  it("drags an authored entity into the existing diff, save/reopen and submit command flow", async () => {
    const { s, wrapper } = await open(); const before = JSON.stringify(s);
    await drag(wrapper.get('[data-testid="authored-marker"]').element);
    const command = JSON.parse(wrapper.get('[data-testid="draft-command"]').text());
    expect(command.operations[0]).toMatchObject({ kind: "entity.update", args: { entityRef: s.authored.entities[0].ref, location: { crs: "OGC:CRS84", coordinates: [127.2, 37.1] } } });
    expect(command.operations[0].targetEntityRefs).toEqual([s.authored.entities[0].ref]);
    expect(JSON.parse(wrapper.get('[data-testid="draft-diff"]').text())[0].before.coordinates).toEqual([127, 37]);
    expect(wrapper.findComponent({ name: "JanseonCommandSubmit" }).props("command")).toEqual(command);
    const text = await saveDraftSession(s, command.operations);
    await wrapper.get('[data-testid="clear-draft"]').trigger("click");
    expect(JSON.parse(wrapper.get('[data-testid="draft-command"]').text())).toBeNull();
    let done!: () => void; const settled = new Promise<void>(resolve => { done = resolve; });
    await wrapper.setProps({ onSettled: done });
    Object.defineProperty(wrapper.get('[data-testid="draft-file"]').element, "files", { value: [{ text: async () => text }] });
    await wrapper.get('[data-testid="draft-file"]').trigger("change"); await settled;
    expect(JSON.parse(wrapper.get('[data-testid="draft-command"]').text())).toEqual(command);
    expect(wrapper.get('[data-testid="authored-marker"]').classes()).toContain("pending");
    expect(JSON.stringify(s)).toBe(before); wrapper.unmount();
  });
  it("rejects observed geometry and graph station drags without disturbing an existing authored draft", async () => {
    const { s, wrapper } = await open(); const before = JSON.stringify(s);
    await drag(wrapper.get('[data-testid="authored-marker"]').element);
    const command = wrapper.get('[data-testid="draft-command"]').text();
    const preventDefault = vi.fn(); runtime.handlers.get("mousedown:observed-fill")!({ preventDefault });
    await nextTick(); expect(preventDefault).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="map-status"]').text()).toContain("REFERENCE_LOCKED");
    await drag(wrapper.get('[data-testid="station-marker"]').element);
    expect(wrapper.get('[data-testid="draft-command"]').text()).toBe(command);
    expect(JSON.stringify(s)).toBe(before); wrapper.unmount();
  });
});
