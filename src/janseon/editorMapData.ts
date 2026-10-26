import type { Feature, FeatureCollection, Geometry } from "geojson";
import { canonical, type ReadSnapshot } from "./editorReadModel";
import type { DraftOperation, Entity } from "./draftSession";

export function coordinate(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2 || value.some(n => typeof n !== "number" || !Number.isFinite(n))
    || Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) return null;
  return [value[0], value[1]];
}

export function editorMapData(snapshot: ReadSnapshot, operations: DraftOperation[]) {
  const stations = snapshot.central.graph.document.stations.flatMap(row => {
    const point = coordinate([row.lon, row.lat]);
    return point ? [{ id: String(row.id), point }] : [];
  });
  const byId = new Map(stations.map(row => [row.id, row.point]));
  const edges: FeatureCollection = { type: "FeatureCollection", features: snapshot.central.graph.document.edges.flatMap(row => {
    const a = byId.get(String(row.a)), b = byId.get(String(row.b));
    return a && b ? [{ type: "Feature" as const, properties: { a: row.a, b: row.b }, geometry: { type: "LineString" as const, coordinates: [a, b] } }] : [];
  }) };
  const observed: FeatureCollection = { type: "FeatureCollection", features: snapshot.central.observedGeography.geometry.features
    .filter(row => row.type === "Feature" && row.geometry !== null && typeof row.geometry === "object") as unknown as Feature<Geometry>[] };
  const entities = snapshot.authored.entities.flatMap((entity: Entity) => {
    const pending = operations.find(op => canonical(op.args.entityRef) === canonical(entity.ref));
    const location = (pending?.args.location ?? entity.location) as { crs?: string; coordinates?: unknown } | null;
    const point = location?.crs === "OGC:CRS84" ? coordinate(location.coordinates) : null;
    return point ? [{ entity, point, pending: !!pending, editable: ["authored-facility", "authored-settlement"].includes(entity.ref.entityKind) }] : [];
  });
  return { stations, edges, observed, entities };
}
