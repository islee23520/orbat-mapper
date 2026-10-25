<script setup lang="ts">
import { computed, ref } from "vue";
import { useClipboard } from "@vueuse/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadReadSnapshot, previewEntity, type ReadSnapshot } from "./editorReadModel";
import JanseonDraftEditor from "./JanseonDraftEditor.vue";
const emit = defineEmits<{ settled: [] }>();

const snapshot = ref<ReadSnapshot>();
const generation = ref("");
const error = ref("");
const loading = ref(false);
const selected = ref("entities:0");
const category = ref("entities");
const input = ref<HTMLInputElement>();
const { copy, copied } = useClipboard();
const groups = computed(() => snapshot.value ? {
  entities: snapshot.value.authored.entities,
  stations: snapshot.value.central.graph.document.stations,
  edges: snapshot.value.central.graph.document.edges,
  observed: snapshot.value.central.observedGeography.geometry.features,
  assignments: snapshot.value.authored.assignments,
} : { entities: [], stations: [], edges: [], observed: [], assignments: [] });
const rows = computed(() => groups.value[category.value as keyof typeof groups.value]);
const detail = computed(() => rows.value[Number(selected.value.split(":")[1])] ?? null);
const command = computed(() => snapshot.value && category.value === "entities" && detail.value
  ? previewEntity(snapshot.value, detail.value as ReadSnapshot["authored"]["entities"][number]) : null);
async function load(event: Event) {
  snapshot.value = undefined; error.value = ""; loading.value = true;
  try { snapshot.value = await loadReadSnapshot(Array.from((event.target as HTMLInputElement).files ?? []), generation.value.trim()); category.value = "entities"; selected.value = "entities:0"; }
  catch (e) { error.value = e instanceof Error ? e.message : "SNAPSHOT_REJECTED"; }
  finally { loading.value = false; emit("settled"); }
}
function label(row: unknown, index: number) {
  const r = row as Record<string, unknown>;
  const key = r.ref as Record<string, string> | undefined;
  return key?.sourceId ?? String(r.id ?? r.kind ?? `${category.value} ${index + 1}`);
}
</script>

<template>
  <main class="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8">
    <div class="mx-auto max-w-7xl space-y-6">
      <header class="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div><p class="text-muted-foreground text-xs font-semibold tracking-widest uppercase">Seoul · canonical references</p><h1 class="mt-2 text-3xl font-semibold">Map edition inspector</h1><p class="text-muted-foreground mt-2">Read-only source facts. Submit reviewed commands through the operator CLI.</p></div>
        <span class="rounded-full border px-3 py-1 text-xs font-semibold">READ ONLY</span>
      </header>
      <Card><CardHeader><CardTitle>Open a pinned snapshot</CardTitle></CardHeader><CardContent class="space-y-3">
        <label class="block text-sm font-medium" for="generation">Expected generation SHA-256</label>
        <input id="generation" v-model="generation" data-testid="expected-generation" class="bg-background w-full rounded-md border px-3 py-2 font-mono text-xs" placeholder="Paste the independently selected generation hash" />
        <input ref="input" data-testid="snapshot-files" type="file" multiple accept=".json" class="hidden" @change="load" />
        <Button class="h-auto max-w-full whitespace-normal py-2 text-left" :disabled="loading" @click="input?.click()">{{ loading ? 'Verifying…' : 'Choose edition.json, central.json and authored.json' }}</Button>
        <p class="text-muted-foreground text-xs">Local files only · source/member hash checks · no upload or database connection</p>
        <p v-if="error" data-testid="snapshot-error" role="alert" class="text-destructive font-mono text-sm">{{ error }}</p>
      </CardContent></Card>
      <div v-if="snapshot" class="space-y-5" data-testid="snapshot-ready">
        <div class="bg-muted grid gap-3 rounded-lg p-4 text-sm sm:grid-cols-3"><div><span class="text-muted-foreground block text-xs">Dataset / edition</span><span class="break-all font-mono text-xs">{{ snapshot.descriptor.head.datasetId }} / {{ snapshot.descriptor.head.editionId }}</span></div><div><span class="text-muted-foreground block text-xs">Accepted sequence</span>{{ snapshot.descriptor.head.sequence }}</div><div><span class="text-muted-foreground block text-xs">Generation</span><span class="break-all font-mono text-xs">{{ snapshot.descriptor.head.generationId }}</span></div></div>
        <div class="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
          <Card><CardHeader><CardTitle>Typed domains</CardTitle></CardHeader><CardContent class="space-y-3">
            <label for="domain" class="text-sm">Reference domain</label><select id="domain" v-model="category" data-testid="domain-select" class="bg-background w-full rounded border p-2 text-sm" @change="selected = `${category}:0`"><option v-for="(items, name) in groups" :key="name" :value="name">{{ name }} ({{ items.length }})</option></select>
            <div class="max-h-80 space-y-1 overflow-auto"><button v-for="(row, index) in rows" :key="index" data-testid="entity-row" class="w-full rounded border px-3 py-2 text-left text-xs break-all" :class="selected === `${category}:${index}` ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="selected = `${category}:${index}`">{{ label(row, index) }}</button><p v-if="!rows.length" class="text-muted-foreground text-sm">No authored records in this domain.</p></div>
          </CardContent></Card>
          <Card class="min-w-0"><CardHeader><CardTitle>Reference detail</CardTitle></CardHeader><CardContent><pre data-testid="reference-detail" class="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs leading-5">{{ JSON.stringify(detail, null, 2) }}</pre></CardContent></Card>
          <Card class="min-w-0"><CardHeader><CardTitle>Command preview</CardTitle></CardHeader><CardContent class="space-y-4"><p class="text-muted-foreground text-xs">Unreviewed, unchanged-value entity.update example. Not accepted or applied. A real operation ID and review are required elsewhere.</p><pre v-if="command" data-testid="command-preview" class="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs leading-5">{{ JSON.stringify(command, null, 2) }}</pre><p v-else class="text-muted-foreground text-sm">Preview unavailable for this reference kind. Select an authored entity.</p><Button data-testid="copy-preview" :disabled="!command" @click="command && copy(JSON.stringify(command, null, 2))">{{ copied ? 'Copied preview' : 'Copy command JSON' }}</Button></CardContent></Card>
        </div>
      </div>
      <JanseonDraftEditor v-if="snapshot" :snapshot="snapshot" :entity="category === 'entities' ? detail as ReadSnapshot['authored']['entities'][number] : null" />
      <div v-else-if="!loading" class="text-muted-foreground rounded-lg border border-dashed p-8 text-center">No snapshot loaded. Choose the three PR9 read-model files and an expected generation.</div>
      <footer class="text-muted-foreground border-t pt-4 text-xs">Physical rail / legacy atlas: UNSET — typed source coverage unavailable. No geometry fallback. Only the merged CLI writes authoritative state.</footer>
    </div>
  </main>
</template>
