import { createHash } from "node:crypto";
import { semanticDigest } from "./canonical.mjs";
import { observedGeographySemanticProjection } from "./observed-geography-store.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
export function graphInput(edition = "one") {
  const document = { schema: "seoul-world-graph-v2", districts: ["district"],
    stations: ["\u00e9", "e\u0301"].map(id => ({ id, nameKo: id, nameEn: id, district: "district", lat: 37, lon: 127 })),
    edges: [{ a: "\u00e9", b: "e\u0301" }], aliases: {}, source: { original: "synthetic", railAdjacency: {
      revision: "synthetic", officialSource: { url: "https://example.invalid", retrievedAt: "2025-01-01", sha256: "a".repeat(64), scope: "synthetic" },
      WikiCommit: "synthetic", scope: "synthetic", replacements: [], excluded: [], hubIdentities: [],
    } } };
  const bytes = Buffer.from(JSON.stringify(document) + "\n");
  const expectedBinding = { dataset_id: "synthetic:shared", edition_id: edition, schema_contract: "janseon-graph-store.v1",
    projection_contract: "janseon-graph-semantic.v1", source_schema: document.schema, expected_source_sha256: sha(bytes),
    expected_document_sha256: sha(JSON.stringify(document)), expected_byte_length: bytes.length, source_package_content_id: "synthetic-package",
    source_authentication_receipt_sha256: "b".repeat(64), source_revision: "synthetic", source_reader_sha256: "c".repeat(64),
    source_schema_sha256: "d".repeat(64), field_disposition_sha256: "e".repeat(64), game_source_manifest_sha256: "f".repeat(64), rights_receipt_content_id: "synthetic-rights" };
  return { document, expectedBinding, sourceReceipt: { singleton: 1, actor: "test", reason: "synthetic only",
    source_sha256: sha(bytes), document_sha256: sha(JSON.stringify(document)), byte_length: bytes.length } };
}

export function observedInput(edition = "one") {
  const rows = {
    boundary_geometry_source: [{ source_path: "synthetic/geometry", sha256: "a".repeat(64), collection_type: "FeatureCollection" }],
    boundary_geometry_feature: [], boundary_geometry_property: [], boundary_geometry_dong: [{ feature_id: "county", ordinal: 0, code: "001" }],
    boundary_geometry_gu: [{ feature_id: "county", ordinal: 0, gu_ref: "gu" }], boundary_geometry_polygon: [], boundary_geometry_ring: [], boundary_geometry_point: [],
    geography_spatial: [{ singleton: 1, edition, baseDate: "2025-06-30", authority: "official-SGIS-statistical-boundary", legalSurveyCertification: 0, current2026Geometry: 0, archiveSha256: "b".repeat(64) }],
    geography_spatial_geometry: [{ singleton: 1, path: "synthetic/geometry", sha256: "a".repeat(64), crs: "OGC:CRS84", features: 4 }],
    geography_county: [{ edition: "dated", countyTitleId: "county", ordinal: 0 }],
    geography_slot: [{ edition: "dated", countyTitleId: "county", ordinal: 0, slotId: "slot", dongId: "\u00e9", name: "Dong", jurisdictionGuRef: "gu", electoralDongId: "electoral", fragmentId: null, sourceEdition: edition, sourcePointer: "/synthetic/0", geometryVerified: 1 }],
    geography_slot_source: [{ edition: "dated", slotId: "slot", ordinal: 0, ref: "source" }],
    geography_slot_geometry: [{ edition: "dated", slotId: "slot", ordinal: 0, ref: "\u00e9" }],
    geography_edition: [{ kind: "electoral", id: "electoral-edition", electionDate: "2024-04-10", seoulCompositionMatchesCurrentAppendix: 1 }],
    geography_edition_source: [{ kind: "electoral", ordinal: 0, ref: "source" }],
    geography_source_record: [{ ordinal: 3, id: "source", sha256: "c".repeat(64), role: "membership" }],
    geography_evidence: [{ kind: "membership", path: "synthetic/membership", sha256: "d".repeat(64) }, { kind: "spatial", path: "synthetic/spatial", sha256: "e".repeat(64) }],
  };
  const definitions = [["\u00e9", "dong", { officialCode: "001", officialName: "Dong", dongId: "\u00e9", electoralDongId: "electoral", countyTitleId: "county", guId: "gu" }],
    ["county", "county", { countyTitleId: "county", name: "County", officialDongCodes: ["001"], jurisdictionGuRefs: ["gu"] }],
    ["gu", "gu", { guId: "gu", name: "Gu" }], ["city", "city", { officialCode: "11" }]];
  const mapping = { kind: "kind", sourceEdition: "source_edition", officialCode: "official_code", officialName: "official_name", dongId: "dong_id", electoralDongId: "electoral_dong_id", countyTitleId: "county_title_id", guId: "gu_id", name: "name" };
  definitions.forEach(([id, kind, properties], ordinal) => {
    const feature = { id, ordinal, feature_type: "Feature", geometry_type: "Polygon", kind, source_edition: edition,
      official_code: null, official_name: null, dong_id: null, electoral_dong_id: null, county_title_id: null, gu_id: null, name: null };
    for (const [key, value] of Object.entries(properties)) if (mapping[key]) feature[mapping[key]] = value;
    rows.boundary_geometry_feature.push(feature);
    Object.keys({ kind, sourceEdition: edition, ...properties }).forEach((name, ordinal) => rows.boundary_geometry_property.push({ feature_id: id, ordinal, name }));
    rows.boundary_geometry_polygon.push({ feature_id: id, ordinal: 0 });
    rows.boundary_geometry_ring.push({ feature_id: id, polygon_ordinal: 0, ordinal: 0 });
    [[127, 37], [127.125, 37], [127.125, 37.125], [127, 37]].forEach(([longitude, latitude], ordinal) => rows.boundary_geometry_point.push({ feature_id: id, polygon_ordinal: 0, ring_ordinal: 0, ordinal, longitude, latitude }));
  });
  const expectedBinding = { dataset_id: "synthetic:shared", edition_id: edition, schema_contract: "janseon-observed-geography-store.v1", projection_contract: "janseon-observed-geography-semantic.v1",
    expected_projection_sha256: semanticDigest(observedGeographySemanticProjection({ datasetId: "synthetic:shared", editionId: edition, rows })),
    source_package_content_id: "synthetic-package", source_authentication_receipt_sha256: "1".repeat(64), source_revision: "synthetic",
    source_reader_closure_sha256: "2".repeat(64), source_schema_closure_sha256: "3".repeat(64), field_disposition_sha256: "4".repeat(64), rights_receipt_content_id: "synthetic-rights",
    original_geometry_sha256: "a".repeat(64), original_spatial_sha256: "e".repeat(64), original_membership_sha256: "d".repeat(64), original_geography_archive_sha256: "5".repeat(64) };
  return { rows, expectedBinding };
}
export const centralInputs = (edition = "one") => ({ graph: graphInput(edition), observedGeography: observedInput(edition) });
