-- Immutable command packages are replay inputs, never replacement map snapshots.
CREATE TABLE map_command_log (
  dataset_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  operation_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  base_generation TEXT NOT NULL,
  base_edition_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  authored_semantic_sha256 TEXT NOT NULL,
  context_sha256 TEXT NOT NULL,
  command_json TEXT NOT NULL,
  review_json TEXT NOT NULL,
  PRIMARY KEY (dataset_id, sequence),
  UNIQUE (dataset_id, operation_id),
  UNIQUE (dataset_id, generation_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE map_command_head (
  dataset_id TEXT NOT NULL PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  generation_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  map_semantic_sha256 TEXT NOT NULL,
  context_sha256 TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TRIGGER map_command_log_insert BEFORE INSERT ON map_command_log
WHEN NOT EXISTS (SELECT 1 FROM map_command_head h WHERE h.dataset_id = NEW.dataset_id AND h.sequence + 1 = NEW.sequence AND h.generation_id = NEW.base_generation AND h.edition_id = NEW.base_edition_id AND h.context_sha256 = NEW.context_sha256)
BEGIN SELECT RAISE(ABORT, 'E_COMMAND_STORE_STALE'); END;
CREATE TRIGGER map_command_log_conflict BEFORE INSERT ON map_command_log
WHEN EXISTS (SELECT 1 FROM map_command_log l WHERE l.dataset_id = NEW.dataset_id AND (l.sequence = NEW.sequence OR l.operation_id = NEW.operation_id OR l.generation_id = NEW.generation_id))
BEGIN SELECT RAISE(ABORT, 'E_COMMAND_STORE_IMMUTABLE'); END;
CREATE TRIGGER map_command_log_update BEFORE UPDATE ON map_command_log
BEGIN SELECT RAISE(ABORT, 'E_COMMAND_STORE_IMMUTABLE'); END;
CREATE TRIGGER map_command_log_delete BEFORE DELETE ON map_command_log
BEGIN SELECT RAISE(ABORT, 'E_COMMAND_STORE_IMMUTABLE'); END;
CREATE TRIGGER map_command_head_insert BEFORE INSERT ON map_command_head
WHEN NEW.sequence != 0
BEGIN SELECT RAISE(ABORT, 'E_COMMAND_STORE_STALE'); END;
CREATE TRIGGER map_command_head_conflict BEFORE INSERT ON map_command_head
WHEN EXISTS (SELECT 1 FROM map_command_head h WHERE h.dataset_id = NEW.dataset_id)
BEGIN SELECT RAISE(ABORT, 'E_COMMAND_STORE_IMMUTABLE'); END;
CREATE TRIGGER map_command_head_update BEFORE UPDATE ON map_command_head
WHEN NEW.dataset_id != OLD.dataset_id OR NEW.context_sha256 != OLD.context_sha256 OR NEW.sequence != OLD.sequence + 1 OR NOT EXISTS (SELECT 1 FROM map_command_log l WHERE l.dataset_id = OLD.dataset_id AND l.sequence = NEW.sequence AND l.base_generation = OLD.generation_id AND l.base_edition_id = OLD.edition_id AND l.generation_id = NEW.generation_id AND l.edition_id = NEW.edition_id)
BEGIN SELECT RAISE(ABORT, 'E_COMMAND_STORE_STALE'); END;
CREATE TRIGGER map_command_head_delete BEFORE DELETE ON map_command_head
BEGIN SELECT RAISE(ABORT, 'E_COMMAND_STORE_IMMUTABLE'); END;
