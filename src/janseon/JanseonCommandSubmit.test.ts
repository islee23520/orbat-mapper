import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import JanseonCommandSubmit from "./JanseonCommandSubmit.vue";
const save = vi.fn().mockResolvedValue(undefined);
vi.mock("@/utils/files", () => ({ saveBlobToLocalFile: (...args: unknown[]) => save(...args) }));
async function click(wrapper: ReturnType<typeof mount>, id: string) {
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  await wrapper.setProps({ onSettled: finish });
  await wrapper.get(`[data-testid="${id}"]`).trigger("click"); await done;
}
describe("CLI-only command submission", () => {
  beforeEach(() => { save.mockClear(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  for (const code of ["ACCEPTED", "STALE_BASE", "WRITER_LOCKED", "PACKAGE_TAMPERED"]) {
    it(`exports package and renders CLI ${code} without replacing result`, async () => {
      const transport = { schema: "janseon-command-transport.v1", log: {}, sha256: "a".repeat(64) };
      const result = { status: code === "ACCEPTED" ? "ACCEPTED" : "REJECTED", code };
      const fetchMock = vi.fn().mockResolvedValueOnce({ json: async () => ({ exitCode: 0, result: { status: "EXPORTED" }, transport }) })
        .mockResolvedValueOnce({ json: async () => ({ exitCode: code === "ACCEPTED" ? 0 : 3, result }) });
      vi.stubGlobal("fetch", fetchMock);
      const wrapper = mount(JanseonCommandSubmit, { props: { command: { schema: "janseon-map-commands.v1", operationId: "preview-only", operations: [] } } });
      await wrapper.get('[data-testid="operation-id"]').setValue("reviewed-op");
      await wrapper.get('[data-testid="bridge-token"]').setValue("session-token");
      await wrapper.get('[data-testid="authoritative-store"]').setValue("/authority/map.sqlite");
      await click(wrapper, "export-package");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).commandPackage.operationId).toBe("reviewed-op");
      expect(save).toHaveBeenCalledOnce();
      await click(wrapper, "apply-cli");
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ transport, authoritativeStore: "/authority/map.sqlite" });
      expect(JSON.parse(wrapper.get('[data-testid="cli-output"]').text()).result).toEqual(result);
      wrapper.unmount();
    });
  }
  it("renders the mobile submit controls and preserves long machine errors without a write", async () => {
    vi.stubGlobal("innerWidth", 320);
    const network = vi.fn().mockRejectedValue(new Error("BRIDGE_UNAVAILABLE_" + "x".repeat(300)));
    vi.stubGlobal("fetch", network);
    const wrapper = mount(JanseonCommandSubmit, { props: { command: { operationId: "preview-only", operations: [] } } });
    const button = wrapper.get('[data-testid="export-package"]');
    expect(button.classes()).toContain("whitespace-normal");
    expect(button.classes()).toContain("w-full");
    expect(wrapper.get('[data-testid="apply-cli"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[data-testid="operation-id"]').setValue("mobile-reviewed");
    await click(wrapper, "export-package");
    const output = wrapper.get('[data-testid="cli-output"]');
    expect(JSON.parse(output.text())).toEqual({ exitCode: 2, result: { status: "REJECTED", code: "BRIDGE_UNAVAILABLE_" + "x".repeat(300) } });
    expect(output.attributes("aria-live")).toBe("polite");
    expect(output.classes()).toContain("break-all");
    expect(save).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0][0]).toBe("http://127.0.0.1:5190/package");
    expect(wrapper.get('[data-testid="apply-cli"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
  it("rejects a non-loopback URL locally on mobile before any request", async () => {
    vi.stubGlobal("innerWidth", 390); const network = vi.fn(); vi.stubGlobal("fetch", network);
    const wrapper = mount(JanseonCommandSubmit, { props: { command: { operations: [] } } });
    await wrapper.get('[data-testid="bridge-url"]').setValue("http://192.168.1.2:5190");
    await wrapper.get('[data-testid="operation-id"]').setValue("mobile-reviewed");
    await click(wrapper, "export-package");
    expect(JSON.parse(wrapper.get('[data-testid="cli-output"]').text()).result.code).toBe("LOOPBACK_BRIDGE_REQUIRED");
    expect(network).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); wrapper.unmount();
  });
});
