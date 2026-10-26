<script setup lang="ts">
import { ref, watch } from "vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { saveBlobToLocalFile } from "@/utils/files";
const props = defineProps<{ command: object | null }>();
const emit = defineEmits<{ settled: [] }>();
const bridge = ref("http://127.0.0.1:5190");
const token = ref("");
const authority = ref("");
const operationId = ref("");
const transport = ref<object>();
const output = ref<unknown>();
const busy = ref(false);
watch(() => [props.command, operationId.value], () => { transport.value = undefined; output.value = undefined; });
async function invoke(action: "package" | "apply") {
  busy.value = true;
  try {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(bridge.value)) throw Error("LOOPBACK_BRIDGE_REQUIRED");
    if (action === "package" && (!props.command || !operationId.value.trim() || operationId.value === "preview-only")) throw Error("OPERATION_ID_REQUIRED");
    const response = await fetch(bridge.value + "/" + action, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: "Bearer " + token.value },
      body: JSON.stringify(action === "package" ? { commandPackage: { ...props.command, operationId: operationId.value.trim() } }
        : { transport: transport.value, authoritativeStore: authority.value }) });
    const result = await response.json(); output.value = result;
    if (action === "package" && result.exitCode === 0) {
      transport.value = result.transport;
      await saveBlobToLocalFile(new Blob([JSON.stringify(result.transport, null, 2)], { type: "application/json" }), "map-command-package.json");
    }
  } catch (error) { output.value = { exitCode: 2, result: { status: "REJECTED", code: error instanceof Error ? error.message : "BRIDGE_FAILED" } }; }
  finally { busy.value = false; emit("settled"); }
}
</script>
<template>
  <Card data-testid="command-submit" class="min-w-0"><CardHeader class="px-4 sm:px-6"><CardTitle>Submit through the operator CLI</CardTitle></CardHeader><CardContent class="min-w-0 space-y-4 px-4 sm:px-6">
    <p class="text-muted-foreground text-sm">The browser never opens the store. Start the local CLI bridge with an independently prepared binding and review. Packaging checks that review; this screen cannot grant it.</p>
    <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      <label class="text-sm">Local bridge URL<input v-model="bridge" data-testid="bridge-url" class="bg-background mt-1 w-full rounded border p-2" /></label>
      <label class="text-sm">Operator session token<input v-model="token" data-testid="bridge-token" type="password" autocomplete="off" class="bg-background mt-1 w-full rounded border p-2" /></label>
      <label class="text-sm">Reviewed operation ID<input v-model="operationId" data-testid="operation-id" class="bg-background mt-1 w-full rounded border p-2" /></label>
      <label class="text-sm">Explicit authoritative store path<input v-model="authority" data-testid="authoritative-store" class="bg-background mt-1 w-full rounded border p-2 font-mono text-xs" /></label>
    </div>
    <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap"><Button data-testid="export-package" class="h-auto min-h-11 w-full max-w-full whitespace-normal py-2 sm:w-auto" :disabled="busy || !command" @click="invoke('package')">Export reviewed command package</Button><Button data-testid="apply-cli" class="h-auto min-h-11 w-full max-w-full whitespace-normal py-2 sm:w-auto" variant="outline" :disabled="busy || !transport || !authority" @click="invoke('apply')">Apply via CLI</Button></div>
    <p class="text-muted-foreground text-xs">Package download is not acceptance. Apply executes the existing CLI against only the operator-configured authority. Refresh the snapshot after success; stale snapshots are not rebased here.</p>
    <pre v-if="output" data-testid="cli-output" aria-live="polite" class="bg-muted min-w-0 max-w-full max-h-80 overflow-auto rounded p-3 text-xs whitespace-pre-wrap break-all">{{ JSON.stringify(output, null, 2) }}</pre>
  </CardContent></Card>
</template>
