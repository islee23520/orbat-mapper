"""Draft wire-contract checks only; no producer/consumer implementation."""
import copy
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "schemas/janseon/release-payload/v1"
DOCS = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in SCHEMAS.glob("*.schema.json")}
REGISTRY = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in DOCS.values())
H = "a" * 64


def ref(kind="graph-station", source="station-a"):
    return {"datasetId": "synthetic:map", "editionId": "one", "entityKind": kind, "sourceId": source}


def edition(domain="graph"):
    return {"domain": domain, "datasetId": "synthetic:map", "editionId": "one", "semanticSha256": H}


RECEIPT = {"contentId": "synthetic-receipt", "sha256": H}
ENTITY = {"ref": ref("authored-facility", "facility-a"), "geographicParentRef": None,
          "location": {"crs": "OGC:CRS84", "coordinates": [127, 37]}, "footprint": None}
CROSSWALK = {"ref": ref("authored-crosswalk", "binding-a"), "stationRef": ref(),
             "facilityRef": ref("authored-facility", "facility-a"), "sourceReceipt": RECEIPT}
EDGE_CHANGE = {"ref": ref("authored-edge-change", "change-a"), "baseEdgeRef": ref("graph-edge", "edge-sha256:" + H),
               "a": None, "b": None, "sourceReceipt": RECEIPT}
AUTHORED = {"datasetId": "synthetic:map", "editionId": "one", "baseCentralSemanticSha256": H,
            "identitySnapshotSha256": H, "entities": [ENTITY], "geometries": [], "edgeChanges": [EDGE_CHANGE],
            "crosswalkChanges": [CROSSWALK], "assignments": [{"kind": "placement", "subjectRef": ref("person", "person-a"),
                                                          "valueRef": None}], "tombstones": [], "semanticSha256": H}
GRAPH = {"districts": ["district-a"], "stations": [{"ref": ref(), "nameKo": "Station A", "nameEn": "Station A",
          "district": "district-a", "location": {"crs": "OGC:CRS84", "coordinates": [127, 37]}}],
         "edges": [{"ref": ref("graph-edge", "edge-sha256:" + H), "a": ref(), "b": ref(source="station-b"),
                    "sourceLocator": "/edges/0"}], "aliases": [{"alias": "Alias A", "stationRef": ref()}], "evidenceReceipt": RECEIPT}
OBSERVED = {"crs": "OGC:CRS84", "axisOrder": "longitude-latitude", "features": [{"type": "Feature",
            "ref": ref("observed-feature", "city-a"), "sourceId": "city-a",
            "properties": {"kind": "city", "sourceEdition": "one", "officialCode": "11"},
            "geometry": {"type": "Polygon", "coordinates": [[[127, 37], [128, 37], [128, 38], [127, 37]]]}}],
            "slots": [], "baseDate": "2025-06-30", "authority": "official-SGIS-statistical-boundary",
            "legalSurveyCertification": False, "current2026Geometry": False, "archiveSha256": H}


def payloads():
    data = {
        "wiki-map-core": GRAPH,
        "wiki-observed-geography": OBSERVED,
        "wiki-spatial-assignments": AUTHORED,
        "wiki-station-bindings": {"baseline": {"status": "available", "entries": [CROSSWALK]},
                                  "authoredChanges": [CROSSWALK], "physicalRail": {"status": "unavailable", "decisionId": "UNSET-3"}},
        "wiki-underground-geometry": {"status": "unavailable", "decisionId": "UNSET-3"},
        "game-world-graph": {"graph": GRAPH, "edgeChanges": [EDGE_CHANGE]},
        "game-map-topology": {"observedGeography": OBSERVED, "entities": [ENTITY], "geometries": []},
        "game-initial-world": AUTHORED,
        "game-terrain-manifest": {"terrain": {"status": "unavailable", "decisionId": "UNSET-4"},
                                  "roads": {"status": "absent", "coverageReceipt": RECEIPT},
                                  "buildings": {"status": "unavailable", "decisionId": "UNSET-4"}},
    }
    return {name: {"schema": "janseon-" + name + ".v1", "binding": {"mapSemanticSha256": H,
                  "identitySnapshotSha256": H, "editions": [edition()]},
                  "origins": [{"editionRef": edition(), "sourceSemanticSha256": H, "sourceReceipt": RECEIPT}],
                  "data": copy.deepcopy(value)} for name, value in data.items()}


def validator(name):
    return Draft202012Validator(DOCS[name + ".schema.json"], registry=REGISTRY)


class PayloadSchemas(unittest.TestCase):
    def test_meta_schema_and_all_local_references(self):
        self.assertEqual(len(DOCS), 10)
        self.assertEqual(len({s["$id"] for s in DOCS.values()}), 10)
        for schema in DOCS.values():
            with self.subTest(schema=schema["$id"]):
                Draft202012Validator.check_schema(schema)
                pending = [schema]
                while pending:
                    value = pending.pop()
                    if isinstance(value, dict):
                        if "$ref" in value:
                            REGISTRY.resolver().lookup(value["$ref"])
                        pending.extend(value.values())
                    elif isinstance(value, list):
                        pending.extend(value)

    def test_all_nine_representative_payloads(self):
        for name, value in payloads().items():
            with self.subTest(member=name):
                validator(name).validate(value)

    def test_both_targets_reject_unknown_missing_and_wrong_types(self):
        for name, value in payloads().items():
            for field in ["schema", "binding", "origins", "data"]:
                with self.subTest(member=name, missing=field):
                    wrong = copy.deepcopy(value)
                    del wrong[field]
                    self.assertFalse(validator(name).is_valid(wrong))
            wrong = copy.deepcopy(value)
            wrong["privateApprovalBody"] = "not allowed"
            self.assertFalse(validator(name).is_valid(wrong))
            wrong = copy.deepcopy(value)
            wrong["binding"]["identitySnapshotSha256"] = 42
            self.assertFalse(validator(name).is_valid(wrong))

    def test_explicit_null_not_missing_and_coordinate_bounds(self):
        value = payloads()["game-initial-world"]
        validator("game-initial-world").validate(value)
        del value["data"]["assignments"][0]["valueRef"]
        self.assertFalse(validator("game-initial-world").is_valid(value))
        value = payloads()["wiki-map-core"]
        value["data"]["stations"][0]["location"]["coordinates"] = [181, 37]
        self.assertFalse(validator("wiki-map-core").is_valid(value))
        value["data"]["stations"][0]["location"]["coordinates"] = [127, "37"]
        self.assertFalse(validator("wiki-map-core").is_valid(value))

    def test_unknown_fact_lanes_cannot_claim_available_or_silent_absence(self):
        value = payloads()["wiki-underground-geometry"]
        value["data"] = {"status": "available", "paths": []}
        self.assertFalse(validator("wiki-underground-geometry").is_valid(value))
        value = payloads()["game-terrain-manifest"]
        value["data"]["terrain"] = {"status": "available", "tiles": []}
        self.assertFalse(validator("game-terrain-manifest").is_valid(value))
        value["data"]["terrain"] = {"status": "absent"}
        self.assertFalse(validator("game-terrain-manifest").is_valid(value))

    def test_kind_specific_observed_facts_required_and_nonnull(self):
        value = payloads()["wiki-observed-geography"]
        value["data"]["features"][0]["properties"]["officialCode"] = None
        self.assertFalse(validator("wiki-observed-geography").is_valid(value))

    def test_authored_footprint_is_not_a_point_overlay(self):
        value = payloads()["game-initial-world"]
        value["data"]["entities"][0]["footprint"] = {"crs": "OGC:CRS84", "type": "Point", "coordinates": [127, 37]}
        self.assertFalse(validator("game-initial-world").is_valid(value))
        value = payloads()["wiki-observed-geography"]
        value["data"]["features"][0]["properties"] = {"kind": "dong", "sourceEdition": "one", "officialCode": "001"}
        self.assertFalse(validator("wiki-observed-geography").is_valid(value))


if __name__ == "__main__":
    unittest.main()
