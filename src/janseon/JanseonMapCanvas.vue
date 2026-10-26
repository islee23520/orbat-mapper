<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Map as MlMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "@/modules/maplibreview/maplibreWorkerUrl";
import type { ReadSnapshot } from "./editorReadModel";
import type { DraftOperation, Entity } from "./draftSession";
import { editorMapData } from "./editorMapData";

const props = defineProps<{ snapshot: ReadSnapshot; operations: DraftOperation[] }>();
const emit = defineEmits<{ move: [entity: Entity, longitude: number, latitude: number] }>();
const container = ref<HTMLDivElement>();
const status = ref("Drag a teal authored marker to stage a location. Reference geometry is locked.");
const ready = ref(false);
const rendered = ref(false);
const data = computed(() => editorMapData(props.snapshot, props.operations));
let map: MlMap;
let markers: Marker[] = [];
let observer: ResizeObserver;
function reject() { status.value = "REFERENCE_LOCKED: observed geometry and graph stations cannot be moved. No draft change."; }
function draw() {
  if (!ready.value) return;
  (map.getSource("edges") as GeoJSONSource).setData(data.value.edges);
  (map.getSource("observed") as GeoJSONSource).setData(data.value.observed);
  markers.forEach(marker => marker.remove()); markers = [];
  for (const station of data.value.stations) {
    const element = document.createElement("button"); element.type = "button";
    element.className = "station-marker"; element.textContent = "S";
    element.title = `${station.id} · graph station · locked`; element.setAttribute("aria-label", element.title);
    element.dataset.testid = "station-marker";
    element.addEventListener("pointerdown", event => { event.stopPropagation(); reject(); });
    markers.push(new Marker({ element }).setLngLat(station.point).addTo(map));
  }
  for (const row of data.value.entities) {
    const element = document.createElement("button"); element.type = "button";
    element.className = `authored-marker${row.pending ? " pending" : ""}`;
    element.textContent = row.pending ? "◆" : "●";
    element.title = `${row.entity.ref.sourceId} · ${row.editable ? "drag to draft" : "locked"}`;
    element.setAttribute("aria-label", element.title); element.dataset.testid = "authored-marker";
    const marker = new Marker({ element }).setLngLat(row.point).addTo(map); markers.push(marker);
    let drag: { pointerId: number; x: number; y: number } | null = null;
    element.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.stopPropagation(); event.preventDefault();
      if (!row.editable) { reject(); return; }
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      element.setPointerCapture(event.pointerId); map.dragPan.disable();
      status.value = `Moving ${row.entity.ref.sourceId} · release to stage, Escape to cancel.`;
    });
    const position = (event: PointerEvent) => {
      const rect = map.getCanvas().getBoundingClientRect();
      return map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
    };
    element.addEventListener("pointermove", event => {
      if (drag?.pointerId === event.pointerId) marker.setLngLat(position(event));
    });
    const cancel = () => { if (drag) { drag = null; map.dragPan.enable(); marker.setLngLat(row.point); status.value = "Drag cancelled. No draft change."; } };
    element.addEventListener("pointercancel", cancel); element.addEventListener("lostpointercapture", cancel);
    element.addEventListener("keydown", event => { if (event.key === "Escape") cancel(); });
    element.addEventListener("pointerup", event => {
      if (drag?.pointerId !== event.pointerId) return;
      const changed = Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3;
      drag = null; map.dragPan.enable();
      if (!changed) { marker.setLngLat(row.point); status.value = "No location change."; return; }
      const point = position(event);
      if (Math.abs(point.lng) > 180 || Math.abs(point.lat) > 90) { marker.setLngLat(row.point); status.value = "DRAFT_COORDINATE: outside CRS84 bounds."; return; }
      emit("move", row.entity, point.lng, point.lat);
      status.value = `Staged ${row.entity.ref.sourceId}: ${point.lng.toFixed(6)}, ${point.lat.toFixed(6)} · client draft only.`;
    });
  }
}
function fit() {
  const points = [...data.value.stations.map(row => row.point), ...data.value.entities.map(row => row.point)];
  for (const feature of data.value.observed.features) {
    const walk = (value: unknown) => { if (!Array.isArray(value)) return; if (typeof value[0] === "number") points.push(value as [number, number]); else value.forEach(walk); };
    if ("coordinates" in feature.geometry) walk(feature.geometry.coordinates);
  }
  if (points.length) {
    const bounds: [[number, number], [number, number]] = [[Infinity, Infinity], [-Infinity, -Infinity]];
    for (const [lon, lat] of points) {
      bounds[0][0] = Math.min(bounds[0][0], lon); bounds[0][1] = Math.min(bounds[0][1], lat);
      bounds[1][0] = Math.max(bounds[1][0], lon); bounds[1][1] = Math.max(bounds[1][1], lat);
    }
    map.fitBounds(bounds, { padding: 55, maxZoom: 14, duration: 0 });
  }
}
onMounted(() => {
  setWorkerUrl(workerUrl);
  map = new MlMap({ container: container.value!, style: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#edf2f5" } }] }, center: [0, 0], zoom: 1, renderWorldCopies: false, attributionControl: false });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.on("load", () => {
    map.addSource("observed", { type: "geojson", data: data.value.observed });
    map.addSource("edges", { type: "geojson", data: data.value.edges });
    map.addLayer({ id: "observed-fill", type: "fill", source: "observed", paint: { "fill-color": "#d4b377", "fill-opacity": 0.28 } });
    map.addLayer({ id: "observed-border", type: "line", source: "observed", paint: { "line-color": "#9a7438", "line-width": 2, "line-dasharray": [3, 2] } });
    map.addLayer({ id: "graph-edges", type: "line", source: "edges", paint: { "line-color": "#536b86", "line-width": 3 } });
    for (const layer of ["observed-fill", "observed-border", "graph-edges"]) {
      map.on("mousedown", layer, event => { event.preventDefault(); reject(); });
      map.on("touchstart", layer, event => { event.preventDefault(); reject(); });
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "not-allowed"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }
    ready.value = true; draw(); fit();
    map.once("idle", () => { rendered.value = true; });
  });
  map.on("error", event => { status.value = `MAP_ERROR: ${event.error.message}`; });
  observer = new ResizeObserver(() => map.resize()); observer.observe(container.value!);
});
watch(data, draw);
watch(() => props.snapshot, () => { if (ready.value) fit(); });
onUnmounted(() => { observer?.disconnect(); markers.forEach(marker => marker.remove()); map?.remove(); });
</script>

<template>
  <section class="space-y-3" data-testid="map-section">
    <div class="flex flex-wrap items-center justify-between gap-2"><h3 class="font-semibold">Map canvas · CRS84</h3><button type="button" class="rounded border px-3 py-2 text-sm" :disabled="!ready" @click="fit">Fit snapshot</button></div>
    <p class="text-muted-foreground text-xs">Teal ● authored / ◆ pending · blue S graph stations · slate graph edges · ochre dashed observed boundaries (locked). No basemap or inferred geometry.</p>
    <div ref="container" data-testid="map-canvas" :data-ready="rendered" class="editor-map" aria-label="Snapshot map. Authored markers draggable; reference geometry locked." />
    <p data-testid="map-status" role="status" aria-live="polite" class="rounded border p-3 font-mono text-xs break-words">{{ status }}</p>
    <p class="text-muted-foreground text-xs" data-testid="map-counts">Rendered: {{ data.stations.length }} stations · {{ data.edges.features.length }} edges · {{ data.observed.features.length }} observed features · {{ data.entities.length }} located authored entities. Missing locations are not invented. Pan / zoom the map; use coordinate inputs below for keyboard editing.</p>
  </section>
</template>

<style scoped>
.editor-map { height: 420px; width: 100%; overflow: hidden; border: 1px solid #bccad1; border-radius: 12px; }
.editor-map :deep(.authored-marker), .editor-map :deep(.station-marker) { width: 36px; height: 36px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 8px #162e4a50; font-weight: 700; color: white; }
.editor-map :deep(.authored-marker) { background: #087e80; cursor: grab; touch-action: none; }
.editor-map :deep(.authored-marker.pending) { background: #ac470f; }
.editor-map :deep(.station-marker) { background: #465f80; cursor: not-allowed; width: 28px; height: 28px; font-size: 11px; }
@media (max-width: 640px) { .editor-map { height: 340px; } }
</style>
