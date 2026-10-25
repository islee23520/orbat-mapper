import { describe, expect, it, vi } from "vitest";
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
      expect(save).toHaveBeenCalled();
      await click(wrapper, "apply-cli");
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ transport, authoritativeStore: "/authority/map.sqlite" });
      expect(JSON.parse(wrapper.get('[data-testid="cli-output"]').text()).result).toEqual(result);
      wrapper.unmount();
    });
  }
});
