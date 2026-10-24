-- Adapted from seoul-dengoku-wiki/scripts/cast-sqlite/{geography-store,boundary-geometries}.{sql,mjs}
-- https://github.com/islee23520/seoul-dengoku-wiki/tree/50ae1e930981d3115847f723d366bbb9e3247ec0
-- Modified: allowlisted observed editions, typed geometry validation and immutable seals.
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

CREATE TABLE map_observed_binding (
  dataset_id TEXT COLLATE BINARY NOT NULL CHECK (length(dataset_id) > 0),
  edition_id TEXT COLLATE BINARY NOT NULL CHECK (length(edition_id) > 0),
  schema_contract TEXT COLLATE BINARY NOT NULL CHECK (length(schema_contract) > 0),
  projection_contract TEXT COLLATE BINARY NOT NULL CHECK (length(projection_contract) > 0),
  expected_projection_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(expected_projection_sha256) = 64 AND expected_projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_package_content_id TEXT COLLATE BINARY NOT NULL CHECK (length(source_package_content_id) > 0),
  source_authentication_receipt_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(source_authentication_receipt_sha256) = 64 AND source_authentication_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_revision TEXT COLLATE BINARY NOT NULL CHECK (length(source_revision) > 0),
  source_reader_closure_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(source_reader_closure_sha256) = 64 AND source_reader_closure_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_schema_closure_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(source_schema_closure_sha256) = 64 AND source_schema_closure_sha256 NOT GLOB '*[^0-9a-f]*'),
  field_disposition_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(field_disposition_sha256) = 64 AND field_disposition_sha256 NOT GLOB '*[^0-9a-f]*'),
  rights_receipt_content_id TEXT COLLATE BINARY NOT NULL CHECK (length(rights_receipt_content_id) > 0),
  original_geometry_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(original_geometry_sha256) = 64 AND original_geometry_sha256 NOT GLOB '*[^0-9a-f]*'),
  original_spatial_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(original_spatial_sha256) = 64 AND original_spatial_sha256 NOT GLOB '*[^0-9a-f]*'),
  original_membership_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(original_membership_sha256) = 64 AND original_membership_sha256 NOT GLOB '*[^0-9a-f]*'),
  original_geography_archive_sha256 TEXT COLLATE BINARY NOT NULL CHECK (length(original_geography_archive_sha256) = 64 AND original_geography_archive_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (schema_contract = 'janseon-observed-geography-store.v1'),
  CHECK (projection_contract = 'janseon-observed-geography-semantic.v1'),
  PRIMARY KEY (dataset_id, edition_id)
) STRICT;

CREATE TABLE map_observed_boundary_source (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  source_path TEXT COLLATE BINARY NOT NULL,
  sha256 TEXT COLLATE BINARY NOT NULL,
  collection_type TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, source_path),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  CHECK (collection_type = 'FeatureCollection')
) STRICT;

CREATE TABLE map_observed_boundary_feature (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  feature_type TEXT COLLATE BINARY NOT NULL,
  geometry_type TEXT COLLATE BINARY NOT NULL,
  kind TEXT COLLATE BINARY NOT NULL,
  source_edition TEXT COLLATE BINARY NOT NULL,
  official_code TEXT COLLATE BINARY,
  official_name TEXT COLLATE BINARY,
  dong_id TEXT COLLATE BINARY,
  electoral_dong_id TEXT COLLATE BINARY,
  county_title_id TEXT COLLATE BINARY,
  gu_id TEXT COLLATE BINARY,
  name TEXT COLLATE BINARY,
  PRIMARY KEY (dataset_id, edition_id, id),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  UNIQUE (dataset_id, edition_id, ordinal),
  CHECK (feature_type = 'Feature'),
  CHECK (geometry_type IN ('Polygon','MultiPolygon')),
  CHECK (kind IN ('dong','county','gu','city'))
) STRICT;

CREATE TABLE map_observed_boundary_property (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  feature_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  name TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, feature_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, feature_id) REFERENCES map_observed_boundary_feature(dataset_id, edition_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (dataset_id, edition_id, feature_id, name),
  CHECK (name IN ('kind','sourceEdition','officialCode','officialName','dongId','electoralDongId','countyTitleId','guId','name','officialDongCodes','jurisdictionGuRefs'))
) STRICT;

CREATE TABLE map_observed_boundary_dong (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  feature_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  code TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, feature_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, feature_id) REFERENCES map_observed_boundary_feature(dataset_id, edition_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE map_observed_boundary_gu (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  feature_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  gu_ref TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, feature_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, feature_id) REFERENCES map_observed_boundary_feature(dataset_id, edition_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE map_observed_boundary_polygon (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  feature_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  PRIMARY KEY (dataset_id, edition_id, feature_id, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, feature_id) REFERENCES map_observed_boundary_feature(dataset_id, edition_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE map_observed_boundary_ring (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  feature_id TEXT COLLATE BINARY NOT NULL,
  polygon_ordinal INTEGER NOT NULL CHECK (polygon_ordinal >= 0 AND polygon_ordinal <= 9007199254740991),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  PRIMARY KEY (dataset_id, edition_id, feature_id, polygon_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, feature_id, polygon_ordinal) REFERENCES map_observed_boundary_polygon(dataset_id, edition_id, feature_id, ordinal) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE map_observed_boundary_point (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  feature_id TEXT COLLATE BINARY NOT NULL,
  polygon_ordinal INTEGER NOT NULL CHECK (polygon_ordinal >= 0 AND polygon_ordinal <= 9007199254740991),
  ring_ordinal INTEGER NOT NULL CHECK (ring_ordinal >= 0 AND ring_ordinal <= 9007199254740991),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  longitude REAL NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
  latitude REAL NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
  longitude_text TEXT NOT NULL,
  latitude_text TEXT NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, feature_id, polygon_ordinal, ring_ordinal, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, feature_id, polygon_ordinal, ring_ordinal) REFERENCES map_observed_boundary_ring(dataset_id, edition_id, feature_id, polygon_ordinal, ordinal) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE map_observed_spatial (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  singleton INTEGER NOT NULL CHECK (singleton = 1),
  edition TEXT COLLATE BINARY NOT NULL,
  baseDate TEXT COLLATE BINARY NOT NULL,
  authority TEXT COLLATE BINARY NOT NULL,
  legalSurveyCertification INTEGER NOT NULL CHECK (legalSurveyCertification IN (0,1)),
  current2026Geometry INTEGER NOT NULL CHECK (current2026Geometry IN (0,1)),
  archiveSha256 TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, singleton),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  CHECK (legalSurveyCertification = 0 AND current2026Geometry = 0),
  CHECK (authority = 'official-SGIS-statistical-boundary')
) STRICT;

CREATE TABLE map_observed_spatial_geometry (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  singleton INTEGER NOT NULL CHECK (singleton = 1),
  path TEXT COLLATE BINARY NOT NULL,
  sha256 TEXT COLLATE BINARY NOT NULL,
  crs TEXT COLLATE BINARY NOT NULL,
  features INTEGER NOT NULL CHECK (features >= 0 AND features <= 9007199254740991),
  PRIMARY KEY (dataset_id, edition_id, singleton),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, singleton) REFERENCES map_observed_spatial(dataset_id, edition_id, singleton) DEFERRABLE INITIALLY DEFERRED,
  CHECK (crs = 'OGC:CRS84'),
  CHECK (features > 0)
) STRICT;

CREATE TABLE map_observed_county (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  edition TEXT COLLATE BINARY NOT NULL,
  countyTitleId TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  PRIMARY KEY (dataset_id, edition_id, edition, countyTitleId),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, countyTitleId) REFERENCES map_observed_boundary_feature(dataset_id, edition_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (edition = 'dated'),
  UNIQUE (dataset_id, edition_id, edition, ordinal)
) STRICT;

CREATE TABLE map_observed_slot (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  edition TEXT COLLATE BINARY NOT NULL,
  countyTitleId TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  slotId TEXT COLLATE BINARY NOT NULL,
  dongId TEXT COLLATE BINARY NOT NULL,
  name TEXT COLLATE BINARY NOT NULL,
  jurisdictionGuRef TEXT COLLATE BINARY NOT NULL,
  electoralDongId TEXT COLLATE BINARY NOT NULL,
  fragmentId TEXT COLLATE BINARY,
  sourceEdition TEXT COLLATE BINARY NOT NULL,
  sourcePointer TEXT COLLATE BINARY NOT NULL,
  geometryVerified INTEGER NOT NULL CHECK (geometryVerified IN (0,1)),
  PRIMARY KEY (dataset_id, edition_id, edition, slotId),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, edition, countyTitleId) REFERENCES map_observed_county(dataset_id, edition_id, edition, countyTitleId) DEFERRABLE INITIALLY DEFERRED,
  CHECK (edition = 'dated' AND fragmentId IS NULL AND geometryVerified = 1),
  UNIQUE (dataset_id, edition_id, edition, countyTitleId, ordinal),
  UNIQUE (dataset_id, edition_id, dongId),
  UNIQUE (dataset_id, edition_id, electoralDongId)
) STRICT;

CREATE TABLE map_observed_slot_source (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  edition TEXT COLLATE BINARY NOT NULL,
  slotId TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  ref TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, edition, slotId, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, edition, slotId) REFERENCES map_observed_slot(dataset_id, edition_id, edition, slotId) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (dataset_id, edition_id, ref) REFERENCES map_observed_source_record(dataset_id, edition_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (edition = 'dated')
) STRICT;

CREATE TABLE map_observed_slot_geometry (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  edition TEXT COLLATE BINARY NOT NULL,
  slotId TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  ref TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, edition, slotId, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, edition, slotId) REFERENCES map_observed_slot(dataset_id, edition_id, edition, slotId) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (dataset_id, edition_id, ref) REFERENCES map_observed_boundary_feature(dataset_id, edition_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (edition = 'dated')
) STRICT;

CREATE TABLE map_observed_electoral_edition (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  kind TEXT COLLATE BINARY NOT NULL,
  id TEXT COLLATE BINARY NOT NULL,
  electionDate TEXT COLLATE BINARY,
  seoulCompositionMatchesCurrentAppendix INTEGER CHECK (seoulCompositionMatchesCurrentAppendix IN (0,1)),
  PRIMARY KEY (dataset_id, edition_id, kind),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  CHECK (kind = 'electoral'),
  CHECK (electionDate IS NOT NULL AND seoulCompositionMatchesCurrentAppendix IS NOT NULL),
  UNIQUE (dataset_id, edition_id, id)
) STRICT;

CREATE TABLE map_observed_electoral_source (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  kind TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  ref TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, kind, ordinal),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id, kind) REFERENCES map_observed_electoral_edition(dataset_id, edition_id, kind) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (dataset_id, edition_id, ref) REFERENCES map_observed_source_record(dataset_id, edition_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (kind = 'electoral')
) STRICT;

CREATE TABLE map_observed_source_record (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  id TEXT COLLATE BINARY NOT NULL,
  sha256 TEXT COLLATE BINARY NOT NULL,
  role TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, id),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  UNIQUE (dataset_id, edition_id, ordinal)
) STRICT;

CREATE TABLE map_observed_evidence (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  kind TEXT COLLATE BINARY NOT NULL,
  path TEXT COLLATE BINARY NOT NULL,
  sha256 TEXT COLLATE BINARY NOT NULL,
  PRIMARY KEY (dataset_id, edition_id, kind),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id),
  CHECK (kind IN ('membership','spatial'))
) STRICT;

CREATE TABLE map_observed_seal (
  dataset_id TEXT COLLATE BINARY NOT NULL,
  edition_id TEXT COLLATE BINARY NOT NULL,
  observed_semantic_sha256 TEXT NOT NULL CHECK (length(observed_semantic_sha256) = 64 AND observed_semantic_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (dataset_id, edition_id),
  FOREIGN KEY (dataset_id, edition_id) REFERENCES map_observed_binding(dataset_id, edition_id)
) STRICT;

CREATE TRIGGER map_observed_binding_immutable_INSERT
BEFORE INSERT ON map_observed_binding
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_binding_immutable_UPDATE
BEFORE UPDATE ON map_observed_binding
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_binding_immutable_DELETE
BEFORE DELETE ON map_observed_binding
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_source_immutable_INSERT
BEFORE INSERT ON map_observed_boundary_source
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_source_immutable_UPDATE
BEFORE UPDATE ON map_observed_boundary_source
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_source_immutable_DELETE
BEFORE DELETE ON map_observed_boundary_source
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_feature_immutable_INSERT
BEFORE INSERT ON map_observed_boundary_feature
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_feature_immutable_UPDATE
BEFORE UPDATE ON map_observed_boundary_feature
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_feature_immutable_DELETE
BEFORE DELETE ON map_observed_boundary_feature
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_property_immutable_INSERT
BEFORE INSERT ON map_observed_boundary_property
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_property_immutable_UPDATE
BEFORE UPDATE ON map_observed_boundary_property
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_property_immutable_DELETE
BEFORE DELETE ON map_observed_boundary_property
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_dong_immutable_INSERT
BEFORE INSERT ON map_observed_boundary_dong
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_dong_immutable_UPDATE
BEFORE UPDATE ON map_observed_boundary_dong
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_dong_immutable_DELETE
BEFORE DELETE ON map_observed_boundary_dong
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_gu_immutable_INSERT
BEFORE INSERT ON map_observed_boundary_gu
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_gu_immutable_UPDATE
BEFORE UPDATE ON map_observed_boundary_gu
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_gu_immutable_DELETE
BEFORE DELETE ON map_observed_boundary_gu
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_polygon_immutable_INSERT
BEFORE INSERT ON map_observed_boundary_polygon
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_polygon_immutable_UPDATE
BEFORE UPDATE ON map_observed_boundary_polygon
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_polygon_immutable_DELETE
BEFORE DELETE ON map_observed_boundary_polygon
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_ring_immutable_INSERT
BEFORE INSERT ON map_observed_boundary_ring
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_ring_immutable_UPDATE
BEFORE UPDATE ON map_observed_boundary_ring
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_ring_immutable_DELETE
BEFORE DELETE ON map_observed_boundary_ring
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_point_immutable_INSERT
BEFORE INSERT ON map_observed_boundary_point
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_point_immutable_UPDATE
BEFORE UPDATE ON map_observed_boundary_point
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_boundary_point_immutable_DELETE
BEFORE DELETE ON map_observed_boundary_point
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_spatial_immutable_INSERT
BEFORE INSERT ON map_observed_spatial
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_spatial_immutable_UPDATE
BEFORE UPDATE ON map_observed_spatial
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_spatial_immutable_DELETE
BEFORE DELETE ON map_observed_spatial
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_spatial_geometry_immutable_INSERT
BEFORE INSERT ON map_observed_spatial_geometry
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_spatial_geometry_immutable_UPDATE
BEFORE UPDATE ON map_observed_spatial_geometry
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_spatial_geometry_immutable_DELETE
BEFORE DELETE ON map_observed_spatial_geometry
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_county_immutable_INSERT
BEFORE INSERT ON map_observed_county
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_county_immutable_UPDATE
BEFORE UPDATE ON map_observed_county
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_county_immutable_DELETE
BEFORE DELETE ON map_observed_county
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_slot_immutable_INSERT
BEFORE INSERT ON map_observed_slot
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_slot_immutable_UPDATE
BEFORE UPDATE ON map_observed_slot
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_slot_immutable_DELETE
BEFORE DELETE ON map_observed_slot
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_slot_source_immutable_INSERT
BEFORE INSERT ON map_observed_slot_source
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_slot_source_immutable_UPDATE
BEFORE UPDATE ON map_observed_slot_source
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_slot_source_immutable_DELETE
BEFORE DELETE ON map_observed_slot_source
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_slot_geometry_immutable_INSERT
BEFORE INSERT ON map_observed_slot_geometry
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_slot_geometry_immutable_UPDATE
BEFORE UPDATE ON map_observed_slot_geometry
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_slot_geometry_immutable_DELETE
BEFORE DELETE ON map_observed_slot_geometry
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_electoral_edition_immutable_INSERT
BEFORE INSERT ON map_observed_electoral_edition
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_electoral_edition_immutable_UPDATE
BEFORE UPDATE ON map_observed_electoral_edition
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_electoral_edition_immutable_DELETE
BEFORE DELETE ON map_observed_electoral_edition
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_electoral_source_immutable_INSERT
BEFORE INSERT ON map_observed_electoral_source
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_electoral_source_immutable_UPDATE
BEFORE UPDATE ON map_observed_electoral_source
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_electoral_source_immutable_DELETE
BEFORE DELETE ON map_observed_electoral_source
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_source_record_immutable_INSERT
BEFORE INSERT ON map_observed_source_record
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_source_record_immutable_UPDATE
BEFORE UPDATE ON map_observed_source_record
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_source_record_immutable_DELETE
BEFORE DELETE ON map_observed_source_record
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_evidence_immutable_INSERT
BEFORE INSERT ON map_observed_evidence
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_evidence_immutable_UPDATE
BEFORE UPDATE ON map_observed_evidence
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id) OR EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_evidence_immutable_DELETE
BEFORE DELETE ON map_observed_evidence
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = OLD.dataset_id AND edition_id = OLD.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_seal_immutable_INSERT
BEFORE INSERT ON map_observed_seal
WHEN EXISTS (SELECT 1 FROM map_observed_seal WHERE dataset_id = NEW.dataset_id AND edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_seal_immutable_UPDATE
BEFORE UPDATE ON map_observed_seal
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;

CREATE TRIGGER map_observed_seal_immutable_DELETE
BEFORE DELETE ON map_observed_seal
BEGIN SELECT RAISE(ABORT, 'immutable observed edition'); END;
