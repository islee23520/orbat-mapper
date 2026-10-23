-- Adapted from seoul-dengoku-wiki/scripts/cast-sqlite/world-graph-document.{sql,mjs}
-- https://github.com/islee23520/seoul-dengoku-wiki/tree/50ae1e930981d3115847f723d366bbb9e3247ec0
-- Modified: namespaced graph editions, constraints, seals and semantic projection.
--
-- Copyright (c) 2026 iz (ilseob lee)
--
-- Permission is hereby granted, free of charge, to any person obtaining a copy
-- of this software and associated documentation files (the "Software"), to deal
-- in the Software without restriction, including without limitation the rights
-- to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
-- copies of the Software, and to permit persons to whom the Software is
-- furnished to do so, subject to the following conditions:
--
-- The above copyright notice and this permission notice shall be included in all
-- copies or substantial portions of the Software.
--
-- THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
-- IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
-- FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
-- AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
-- LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
-- OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
-- SOFTWARE.

CREATE TABLE map_graph_binding (
  dataset_id TEXT COLLATE BINARY NOT NULL CHECK (length(dataset_id) > 0),
  edition_id TEXT COLLATE BINARY NOT NULL CHECK (length(edition_id) > 0),
  schema_contract TEXT COLLATE BINARY NOT NULL CHECK (length(schema_contract) > 0),
  projection_contract TEXT COLLATE BINARY NOT NULL CHECK (length(projection_contract) > 0),
  source_schema TEXT COLLATE BINARY NOT NULL CHECK (length(source_schema) > 0),
  expected_source_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(expected_source_sha256) = 64 AND expected_source_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_document_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(expected_document_sha256) = 64 AND expected_document_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_byte_length INTEGER NOT NULL CHECK (expected_byte_length >= 0),
  source_package_content_id TEXT COLLATE BINARY NOT NULL CHECK (length(source_package_content_id) > 0),
  source_authentication_receipt_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(source_authentication_receipt_sha256) = 64 AND source_authentication_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_revision TEXT COLLATE BINARY NOT NULL CHECK (length(source_revision) > 0),
  source_reader_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(source_reader_sha256) = 64 AND source_reader_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_schema_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(source_schema_sha256) = 64 AND source_schema_sha256 NOT GLOB '*[^0-9a-f]*'),
  field_disposition_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(field_disposition_sha256) = 64 AND field_disposition_sha256 NOT GLOB '*[^0-9a-f]*'),
  game_source_manifest_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(game_source_manifest_sha256) = 64 AND game_source_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  rights_receipt_content_id TEXT COLLATE BINARY NOT NULL CHECK (length(rights_receipt_content_id) > 0),
  CHECK (schema_contract = 'janseon-graph-store.v1'),
  CHECK (projection_contract = 'janseon-graph-semantic.v1'),
  PRIMARY KEY (dataset_id, edition_id)
) STRICT;

CREATE TABLE map_graph_import (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  singleton INTEGER NOT NULL CHECK (singleton = 1),
  actor TEXT COLLATE BINARY NOT NULL CHECK (length(trim(actor)) > 0),
  reason TEXT COLLATE BINARY NOT NULL CHECK (length(trim(reason)) > 0),
  source_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  document_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(document_sha256) = 64 AND document_sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  PRIMARY KEY (dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id)
) STRICT;

CREATE TABLE map_graph_root (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  entity_kind TEXT COLLATE BINARY NOT NULL CHECK (entity_kind = 'graph-document'),
  source_id TEXT COLLATE BINARY NOT NULL,
  singleton INTEGER NOT NULL CHECK (singleton = 1),
  schema TEXT COLLATE BINARY NOT NULL,
  district_count INTEGER NOT NULL CHECK (district_count >= 0),
  station_count INTEGER NOT NULL CHECK (station_count >= 0),
  edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
  alias_count INTEGER NOT NULL CHECK (alias_count >= 0),
  source_original TEXT COLLATE BINARY NOT NULL,
  rail_revision TEXT COLLATE BINARY NOT NULL,
  rail_wiki_commit TEXT COLLATE BINARY NOT NULL,
  rail_scope TEXT COLLATE BINARY NOT NULL,
  rail_official_url TEXT COLLATE BINARY NOT NULL,
  rail_official_retrieved_at TEXT COLLATE BINARY NOT NULL,
  rail_official_sha256 TEXT COLLATE BINARY NOT NULL,
  rail_official_scope TEXT COLLATE BINARY NOT NULL,
  replacement_count INTEGER NOT NULL CHECK (replacement_count >= 0),
  excluded_count INTEGER NOT NULL CHECK (excluded_count >= 0),
  hub_count INTEGER NOT NULL CHECK (hub_count >= 0),
  PRIMARY KEY (dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_binding(dataset_id, edition_id),
  CHECK (source_id = '/'),
  UNIQUE (dataset_id, edition_id, entity_kind, source_id)
) STRICT;

CREATE TABLE map_graph_district (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  entity_kind TEXT COLLATE BINARY NOT NULL CHECK (entity_kind = 'graph-district'),
  source_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  name TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  CHECK (source_id = name),
  UNIQUE (dataset_id, edition_id, entity_kind, source_id),
  UNIQUE (dataset_id, edition_id, name)
) STRICT;

CREATE TABLE map_graph_station (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  entity_kind TEXT COLLATE BINARY NOT NULL CHECK (entity_kind = 'graph-station'),
  source_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  station_id TEXT COLLATE BINARY NOT NULL,
  name_ko TEXT COLLATE BINARY NOT NULL,
  name_en TEXT COLLATE BINARY NOT NULL,
  district TEXT COLLATE BINARY NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  lat_text TEXT COLLATE BINARY NOT NULL,
  lon_text TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  CHECK (source_id = station_id),
  UNIQUE (dataset_id, edition_id, entity_kind, source_id),
  UNIQUE (dataset_id, edition_id, station_id),
  FOREIGN KEY (dataset_id, edition_id, district) REFERENCES map_graph_district(dataset_id, edition_id, name)
) STRICT;

CREATE TABLE map_graph_edge (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  entity_kind TEXT COLLATE BINARY NOT NULL CHECK (entity_kind = 'graph-edge'),
  source_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  endpoint_a TEXT COLLATE BINARY NOT NULL,
  endpoint_b TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  CHECK (source_id = '/edges/' || CAST(ordinal AS TEXT)),
  UNIQUE (dataset_id, edition_id, entity_kind, source_id),
  FOREIGN KEY (dataset_id, edition_id, endpoint_a) REFERENCES map_graph_station(dataset_id, edition_id, station_id),
  FOREIGN KEY (dataset_id, edition_id, endpoint_b) REFERENCES map_graph_station(dataset_id, edition_id, station_id)
) STRICT;

CREATE TABLE map_graph_alias (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  entity_kind TEXT COLLATE BINARY NOT NULL CHECK (entity_kind = 'graph-alias'),
  source_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  alias_key TEXT COLLATE BINARY NOT NULL,
  alias_value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  CHECK (source_id = alias_key),
  UNIQUE (dataset_id, edition_id, entity_kind, source_id),
  UNIQUE (dataset_id, edition_id, alias_key),
  FOREIGN KEY (dataset_id, edition_id, alias_value) REFERENCES map_graph_station(dataset_id, edition_id, station_id)
) STRICT;

CREATE TABLE map_graph_replacement (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  entity_kind TEXT COLLATE BINARY NOT NULL CHECK (entity_kind = 'graph-replacement'),
  source_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  original_index INTEGER NOT NULL,
  original_a TEXT COLLATE BINARY NOT NULL,
  original_b TEXT COLLATE BINARY NOT NULL,
  status TEXT COLLATE BINARY NOT NULL,
  line_id TEXT COLLATE BINARY NOT NULL,
  physical_evidence_boundary TEXT COLLATE BINARY NOT NULL,
  chain_count INTEGER NOT NULL CHECK (chain_count >= 0),
  official_code_count INTEGER NOT NULL CHECK (official_code_count >= 0),
  source_url TEXT COLLATE BINARY NOT NULL,
  source_retrieved_at TEXT COLLATE BINARY NOT NULL,
  source_sha256 TEXT COLLATE BINARY NOT NULL,
  source_scope TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  CHECK (source_id = '/source/railAdjacency/replacements/' || CAST(ordinal AS TEXT)),
  UNIQUE (dataset_id, edition_id, entity_kind, source_id),
  UNIQUE (dataset_id, edition_id, original_index)
) STRICT;

CREATE TABLE map_graph_replacement_chain (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  replacement_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, replacement_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, replacement_ordinal) REFERENCES map_graph_replacement(dataset_id, edition_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id, value) REFERENCES map_graph_station(dataset_id, edition_id, station_id)
) STRICT;

CREATE TABLE map_graph_replacement_code (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  replacement_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, replacement_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, replacement_ordinal) REFERENCES map_graph_replacement(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_excluded (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  entity_kind TEXT COLLATE BINARY NOT NULL CHECK (entity_kind = 'graph-exclusion'),
  source_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  original_index INTEGER NOT NULL,
  original_a TEXT COLLATE BINARY NOT NULL,
  original_b TEXT COLLATE BINARY NOT NULL,
  status TEXT COLLATE BINARY NOT NULL,
  reason_presence TEXT COLLATE BINARY NOT NULL CHECK (reason_presence IN ('missing', 'null', 'value')),
  reason TEXT COLLATE BINARY,
  missing_presence TEXT COLLATE BINARY NOT NULL CHECK (missing_presence IN ('missing', 'present')),
  missing_count INTEGER NOT NULL CHECK (missing_count >= 0),
  support_index INTEGER NOT NULL,
  support_a TEXT COLLATE BINARY NOT NULL,
  support_b TEXT COLLATE BINARY NOT NULL,
  support_mapped_a TEXT COLLATE BINARY NOT NULL,
  support_mapped_b TEXT COLLATE BINARY NOT NULL,
  support_classification TEXT COLLATE BINARY NOT NULL,
  support_no_surface_adjacency_inference INTEGER NOT NULL CHECK (support_no_surface_adjacency_inference IN (0, 1)),
  adjacent_count INTEGER NOT NULL CHECK (adjacent_count >= 0),
  skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
  opening_count INTEGER NOT NULL CHECK (opening_count >= 0),
  endpoint_count INTEGER NOT NULL CHECK (endpoint_count >= 0),
  evidence_ref_count INTEGER NOT NULL CHECK (evidence_ref_count >= 0),
  CHECK ((reason_presence = 'value' AND reason IS NOT NULL) OR (reason_presence IN ('missing', 'null') AND reason IS NULL)),
  CHECK ((missing_presence = 'present' AND missing_count >= 0) OR (missing_presence = 'missing' AND missing_count = 0)),
  PRIMARY KEY (dataset_id, edition_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  CHECK (source_id = '/source/railAdjacency/excluded/' || CAST(ordinal AS TEXT)),
  UNIQUE (dataset_id, edition_id, entity_kind, source_id),
  UNIQUE (dataset_id, edition_id, original_index),
  CHECK (reason_presence = 'missing' OR missing_presence = 'missing')
) STRICT;

CREATE TABLE map_graph_excluded_missing (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  excluded_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, excluded_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, excluded_ordinal) REFERENCES map_graph_excluded(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_excluded_adjacent (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  excluded_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, excluded_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, excluded_ordinal) REFERENCES map_graph_excluded(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_excluded_opening (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  excluded_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, excluded_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, excluded_ordinal) REFERENCES map_graph_excluded(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_excluded_endpoint (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  excluded_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, excluded_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, excluded_ordinal) REFERENCES map_graph_excluded(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_excluded_evidence_ref (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  excluded_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  path TEXT COLLATE BINARY NOT NULL,
  selector TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, excluded_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, excluded_ordinal) REFERENCES map_graph_excluded(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_excluded_skipped (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  excluded_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  line_id TEXT COLLATE BINARY NOT NULL,
  line_name TEXT COLLATE BINARY NOT NULL,
  path_index INTEGER NOT NULL,
  skipped_stops INTEGER NOT NULL,
  code_count INTEGER NOT NULL CHECK (code_count >= 0),
  station_id_count INTEGER NOT NULL CHECK (station_id_count >= 0),
  name_count INTEGER NOT NULL CHECK (name_count >= 0),
  PRIMARY KEY (dataset_id, edition_id, excluded_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, excluded_ordinal) REFERENCES map_graph_excluded(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_excluded_skipped_code (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  excluded_ordinal INTEGER NOT NULL,
  skipped_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, excluded_ordinal, skipped_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, excluded_ordinal, skipped_ordinal) REFERENCES map_graph_excluded_skipped(dataset_id, edition_id, excluded_ordinal, ordinal)
) STRICT;

CREATE TABLE map_graph_excluded_skipped_station (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  excluded_ordinal INTEGER NOT NULL,
  skipped_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, excluded_ordinal, skipped_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, excluded_ordinal, skipped_ordinal) REFERENCES map_graph_excluded_skipped(dataset_id, edition_id, excluded_ordinal, ordinal)
) STRICT;

CREATE TABLE map_graph_excluded_skipped_name (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  excluded_ordinal INTEGER NOT NULL,
  skipped_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, excluded_ordinal, skipped_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, excluded_ordinal, skipped_ordinal) REFERENCES map_graph_excluded_skipped(dataset_id, edition_id, excluded_ordinal, ordinal)
) STRICT;

CREATE TABLE map_graph_hub (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  entity_kind TEXT COLLATE BINARY NOT NULL CHECK (entity_kind = 'graph-hub'),
  source_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  uid TEXT COLLATE BINARY NOT NULL,
  contract TEXT COLLATE BINARY NOT NULL,
  official_code_count INTEGER NOT NULL CHECK (official_code_count >= 0),
  permanent_id_count INTEGER NOT NULL CHECK (permanent_id_count >= 0),
  line_id_count INTEGER NOT NULL CHECK (line_id_count >= 0),
  evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
  PRIMARY KEY (dataset_id, edition_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  CHECK (source_id = uid),
  UNIQUE (dataset_id, edition_id, entity_kind, source_id),
  UNIQUE (dataset_id, edition_id, uid)
) STRICT;

CREATE TABLE map_graph_hub_official_code (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  hub_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, hub_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, hub_ordinal) REFERENCES map_graph_hub(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_hub_permanent_id (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  hub_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, hub_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, hub_ordinal) REFERENCES map_graph_hub(dataset_id, edition_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id, value) REFERENCES map_graph_station(dataset_id, edition_id, station_id)
) STRICT;

CREATE TABLE map_graph_hub_line_id (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  hub_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  value TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, hub_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, hub_ordinal) REFERENCES map_graph_hub(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_hub_evidence (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  hub_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  line_id TEXT COLLATE BINARY NOT NULL,
  line_name TEXT COLLATE BINARY NOT NULL,
  code TEXT COLLATE BINARY NOT NULL,
  uid TEXT COLLATE BINARY NOT NULL,
  name TEXT COLLATE BINARY NOT NULL,
  path_index INTEGER NOT NULL,
  station_index INTEGER NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, hub_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, hub_ordinal) REFERENCES map_graph_hub(dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_graph_seal (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  graph_semantic_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(graph_semantic_sha256) = 64 AND graph_semantic_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_graph_root(dataset_id, edition_id)
) STRICT;

CREATE TRIGGER map_graph_binding_immutable_INSERT
BEFORE INSERT ON map_graph_binding
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_binding_immutable_UPDATE
BEFORE UPDATE ON map_graph_binding
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_binding_immutable_DELETE
BEFORE DELETE ON map_graph_binding
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_import_immutable_INSERT
BEFORE INSERT ON map_graph_import
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_import_immutable_UPDATE
BEFORE UPDATE ON map_graph_import
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_import_immutable_DELETE
BEFORE DELETE ON map_graph_import
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_root_immutable_INSERT
BEFORE INSERT ON map_graph_root
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_root_immutable_UPDATE
BEFORE UPDATE ON map_graph_root
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_root_immutable_DELETE
BEFORE DELETE ON map_graph_root
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_district_immutable_INSERT
BEFORE INSERT ON map_graph_district
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_district_immutable_UPDATE
BEFORE UPDATE ON map_graph_district
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_district_immutable_DELETE
BEFORE DELETE ON map_graph_district
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_station_immutable_INSERT
BEFORE INSERT ON map_graph_station
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_station_immutable_UPDATE
BEFORE UPDATE ON map_graph_station
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_station_immutable_DELETE
BEFORE DELETE ON map_graph_station
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_edge_immutable_INSERT
BEFORE INSERT ON map_graph_edge
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_edge_immutable_UPDATE
BEFORE UPDATE ON map_graph_edge
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_edge_immutable_DELETE
BEFORE DELETE ON map_graph_edge
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_alias_immutable_INSERT
BEFORE INSERT ON map_graph_alias
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_alias_immutable_UPDATE
BEFORE UPDATE ON map_graph_alias
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_alias_immutable_DELETE
BEFORE DELETE ON map_graph_alias
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_replacement_immutable_INSERT
BEFORE INSERT ON map_graph_replacement
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_replacement_immutable_UPDATE
BEFORE UPDATE ON map_graph_replacement
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_replacement_immutable_DELETE
BEFORE DELETE ON map_graph_replacement
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_replacement_chain_immutable_INSERT
BEFORE INSERT ON map_graph_replacement_chain
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_replacement_chain_immutable_UPDATE
BEFORE UPDATE ON map_graph_replacement_chain
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_replacement_chain_immutable_DELETE
BEFORE DELETE ON map_graph_replacement_chain
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_replacement_code_immutable_INSERT
BEFORE INSERT ON map_graph_replacement_code
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_replacement_code_immutable_UPDATE
BEFORE UPDATE ON map_graph_replacement_code
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_replacement_code_immutable_DELETE
BEFORE DELETE ON map_graph_replacement_code
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_immutable_INSERT
BEFORE INSERT ON map_graph_excluded
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_immutable_DELETE
BEFORE DELETE ON map_graph_excluded
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_missing_immutable_INSERT
BEFORE INSERT ON map_graph_excluded_missing
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_missing_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded_missing
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_missing_immutable_DELETE
BEFORE DELETE ON map_graph_excluded_missing
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_adjacent_immutable_INSERT
BEFORE INSERT ON map_graph_excluded_adjacent
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_adjacent_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded_adjacent
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_adjacent_immutable_DELETE
BEFORE DELETE ON map_graph_excluded_adjacent
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_opening_immutable_INSERT
BEFORE INSERT ON map_graph_excluded_opening
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_opening_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded_opening
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_opening_immutable_DELETE
BEFORE DELETE ON map_graph_excluded_opening
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_endpoint_immutable_INSERT
BEFORE INSERT ON map_graph_excluded_endpoint
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_endpoint_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded_endpoint
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_endpoint_immutable_DELETE
BEFORE DELETE ON map_graph_excluded_endpoint
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_evidence_ref_immutable_INSERT
BEFORE INSERT ON map_graph_excluded_evidence_ref
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_evidence_ref_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded_evidence_ref
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_evidence_ref_immutable_DELETE
BEFORE DELETE ON map_graph_excluded_evidence_ref
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_immutable_INSERT
BEFORE INSERT ON map_graph_excluded_skipped
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded_skipped
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_immutable_DELETE
BEFORE DELETE ON map_graph_excluded_skipped
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_code_immutable_INSERT
BEFORE INSERT ON map_graph_excluded_skipped_code
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_code_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded_skipped_code
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_code_immutable_DELETE
BEFORE DELETE ON map_graph_excluded_skipped_code
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_station_immutable_INSERT
BEFORE INSERT ON map_graph_excluded_skipped_station
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_station_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded_skipped_station
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_station_immutable_DELETE
BEFORE DELETE ON map_graph_excluded_skipped_station
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_name_immutable_INSERT
BEFORE INSERT ON map_graph_excluded_skipped_name
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_name_immutable_UPDATE
BEFORE UPDATE ON map_graph_excluded_skipped_name
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_excluded_skipped_name_immutable_DELETE
BEFORE DELETE ON map_graph_excluded_skipped_name
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_immutable_INSERT
BEFORE INSERT ON map_graph_hub
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_immutable_UPDATE
BEFORE UPDATE ON map_graph_hub
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_immutable_DELETE
BEFORE DELETE ON map_graph_hub
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_official_code_immutable_INSERT
BEFORE INSERT ON map_graph_hub_official_code
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_official_code_immutable_UPDATE
BEFORE UPDATE ON map_graph_hub_official_code
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_official_code_immutable_DELETE
BEFORE DELETE ON map_graph_hub_official_code
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_permanent_id_immutable_INSERT
BEFORE INSERT ON map_graph_hub_permanent_id
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_permanent_id_immutable_UPDATE
BEFORE UPDATE ON map_graph_hub_permanent_id
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_permanent_id_immutable_DELETE
BEFORE DELETE ON map_graph_hub_permanent_id
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_line_id_immutable_INSERT
BEFORE INSERT ON map_graph_hub_line_id
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_line_id_immutable_UPDATE
BEFORE UPDATE ON map_graph_hub_line_id
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_line_id_immutable_DELETE
BEFORE DELETE ON map_graph_hub_line_id
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_evidence_immutable_INSERT
BEFORE INSERT ON map_graph_hub_evidence
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_evidence_immutable_UPDATE
BEFORE UPDATE ON map_graph_hub_evidence
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_hub_evidence_immutable_DELETE
BEFORE DELETE ON map_graph_hub_evidence
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph edition'); END;

CREATE TRIGGER map_graph_seal_immutable_INSERT
BEFORE INSERT ON map_graph_seal
WHEN EXISTS (SELECT 1 FROM map_graph_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable graph seal'); END;

CREATE TRIGGER map_graph_seal_immutable_UPDATE
BEFORE UPDATE ON map_graph_seal
BEGIN SELECT RAISE(ABORT, 'immutable graph seal'); END;

CREATE TRIGGER map_graph_seal_immutable_DELETE
BEFORE DELETE ON map_graph_seal
BEGIN SELECT RAISE(ABORT, 'immutable graph seal'); END;
