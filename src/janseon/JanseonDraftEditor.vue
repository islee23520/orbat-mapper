<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Button } from "@/components/ui/button";
import { canonical, type ReadSnapshot } from "./editorReadModel";
import { draftCommand, stageLocation, saveDraftSession, reopenDraftSession, type DraftOperation, type Entity } from "./draftSession";
import JanseonCommandSubmit from "./JanseonCommandSubmit.vue";
import JanseonMapCanvas from "./JanseonMapCanvas.vue";
const props = defineProps<{ snapshot: ReadSnapshot; entity: Entity | null }>();
const emit = defineEmits<{ settled: [] }>();
const operations = ref<DraftOperation[]>([]);
const longitude = ref(""); const latitude = ref(""); const error = ref("");
const input = ref<HTMLInputElement>();
watch(() => props.snapshot, () => { operations.value = []; error.value = ""; });
watch(() => props.entity, entity => {
  const location = entity?.location as { coordinates?: number[] } | null;
  longitude.value = String(location?.coordinates?.[0] ?? ""); latitude.value = String(location?.coordinates?.[1] ?? "");
}, { immediate: true });
const command = computed(() => draftCommand(props.snapshot, operations.value));
const diff = computed(() => operations.value.map(op => ({ ref: op.args.entityRef,
  before: props.snapshot.authored.entities.find(e => canonical(e.ref) === canonical(op.args.entityRef))?.location,
  after: op.args.location })));
function stageEntity(entity: Entity, lon: number, lat: number) {
  const op = stageLocation(props.snapshot, entity, lon, lat);
  const next = operations.value.filter(row => canonical(row.args.entityRef) !== canonical(op.args.entityRef));
  if (canonical(entity.location) !== canonical(op.args.location)) next.push(op);
  operations.value = next; error.value = "";
}
function move(entity: Entity, lon: number, lat: number) {
  try { stageEntity(entity, lon, lat); }
  catch (e) { error.value = e instanceof Error ? e.message : "DRAFT_REJECTED"; }
}
function stage() {
  try {
    if (!props.entity || !String(longitude.value).trim() || !String(latitude.value).trim()) throw Error("DRAFT_COORDINATE");
    stageEntity(props.entity, Number(longitude.value), Number(latitude.value));
  } catch (e) { error.value = e instanceof Error ? e.message : "DRAFT_REJECTED"; }
}
async function save() {
  try {
    const url = URL.createObjectURL(new Blob([await saveDraftSession(props.snapshot, operations.value)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "map-draft-session.json";
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); error.value = "";
  }
  catch (e) { error.value = e instanceof Error ? e.message : "DRAFT_SAVE_FAILED"; }
  finally { emit("settled"); }
}
async function reopen(event: Event) {
  try {
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file) throw Error("DRAFT_FILE_REQUIRED");
    operations.value = await reopenDraftSession(await file.text(), props.snapshot); error.value = "";
    (event.target as HTMLInputElement).value = "";
  } catch (e) { operations.value = []; error.value = e instanceof Error ? e.message : "DRAFT_REJECTED"; }
  finally { emit("settled"); }
}
</script>
<template>
  <section class="min-w-0 space-y-4 rounded-xl border p-3 sm:p-5" data-testid="draft-editor">
    <h2 class="text-xl font-semibold">Draft changes · client only</h2>
    <p class="text-muted-foreground text-sm">Stage authored entity locations against this pinned base. Reference data stays unchanged. Review approval remains external.</p>
    <JanseonMapCanvas :snapshot="snapshot" :operations="operations" @move="move" />
    <div v-if="entity" class="flex flex-wrap items-end gap-3"><label class="text-sm">Longitude<input v-model="longitude" data-testid="draft-longitude" type="number" step="any" class="bg-background mt-1 block w-36 rounded border p-2" /></label><label class="text-sm">Latitude<input v-model="latitude" data-testid="draft-latitude" type="number" step="any" class="bg-background mt-1 block w-36 rounded border p-2" /></label><Button data-testid="stage-edit" @click="stage">Stage location</Button></div>
    <p v-else class="text-muted-foreground text-sm">Select an authored entity to stage a location.</p>
    <div class="flex flex-wrap gap-3"><Button data-testid="save-draft" variant="outline" @click="save">Save draft session</Button><Button data-testid="reopen-draft" variant="outline" @click="input?.click()">Reopen draft session</Button><Button data-testid="clear-draft" variant="ghost" @click="operations = []">Clear staged edits</Button><input ref="input" data-testid="draft-file" type="file" accept=".json" class="hidden" @change="reopen" /></div>
    <p v-if="error" data-testid="draft-error" role="alert" class="text-destructive font-mono text-sm">{{ error }}</p>
    <div class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2"><div class="min-w-0"><h3 class="font-medium">Draft vs base ({{ operations.length }})</h3><pre data-testid="draft-diff" class="bg-muted mt-2 max-w-full max-h-80 overflow-auto rounded p-3 text-xs whitespace-pre-wrap break-all">{{ JSON.stringify(diff, null, 2) }}</pre></div><div class="min-w-0"><h3 class="font-medium">Accumulated command preview</h3><pre data-testid="draft-command" class="bg-muted mt-2 max-w-full max-h-80 overflow-auto rounded p-3 text-xs whitespace-pre-wrap break-all">{{ JSON.stringify(command, null, 2) }}</pre></div></div>
    <JanseonCommandSubmit :command="command" />
  </section>
</template>
