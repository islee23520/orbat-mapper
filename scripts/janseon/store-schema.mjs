/*
Adapted from seoul-dengoku-wiki/scripts/cast-sqlite/{world-graph-document,geography-store,boundary-geometries}.{sql,mjs}
https://github.com/islee23520/seoul-dengoku-wiki/tree/50ae1e930981d3115847f723d366bbb9e3247ec0
Modified: fixed whole-schema installation and graph/observed composition boundary.

Copyright (c) 2026 iz (ilseob lee)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { readFileSync } from "node:fs";
import { canonicalEncode } from "./canonical.mjs";

const fail = detail => { throw Object.assign(new Error("E_STORE_SCHEMA: " + detail), { code: "E_STORE_SCHEMA" }); };

// Deliberately limited to the DDL grammar of these two code-owned files. An
// unsupported statement cannot disappear from a successful matchAll result.
function schemaObjects(source) {
  const objects = [], names = new Set();
  let offset = 0;
  while (offset < source.length) {
    const trivia = /^(?:\s+|--[^\n]*(?:\n|$))*/.exec(source.slice(offset))[0];
    offset += trivia.length;
    if (offset === source.length) break;
    const start = offset;
    const header = /^CREATE (TABLE|TRIGGER) (map_(?:graph|observed|command)_\w+)\b/.exec(source.slice(offset));
    if (!header) fail("unsupported DDL at offset " + offset);
    const [, type, name] = header;
    if (names.has(name)) fail("duplicate schema object " + name);
    names.add(name);
    offset += header[0].length;
    let depth = 0, quoted = false, ended = false;
    for (; offset < source.length; offset++) {
      const char = source[offset];
      if (char === "'") {
        if (quoted && source[offset + 1] === "'") { offset++; continue; }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      // Current schema has comments only between statements and no quoted identifiers.
      if (char === '"' || char === "`" || char === "[" || source.startsWith("--", offset)
          || source.startsWith("/*", offset)) fail("unsupported DDL token in " + name);
      if (char === "(") depth++;
      if (char === ")" && --depth < 0) fail("unbalanced DDL in " + name);
      if (char !== ";" || depth !== 0) continue;
      const sql = source.slice(start, offset);
      if (type === "TABLE") {
        if (!/^CREATE TABLE \w+ \([\s\S]*\) STRICT(?:, WITHOUT ROWID)?$/.test(sql)) fail("unsupported table DDL " + name);
      } else {
        const prefix = /^CREATE TRIGGER \w+\s+BEFORE (?:INSERT|UPDATE|DELETE) ON map_(?:graph|observed|command)_\w+\s+(?:WHEN [\s\S]+?\s+)?BEGIN SELECT RAISE\(ABORT, '(?:[^']|'')*'\)/;
        if (prefix.test(sql) && !sql.endsWith("END")) continue; // RAISE statement's semicolon.
        if (!/^CREATE TRIGGER \w+\s+BEFORE (?:INSERT|UPDATE|DELETE) ON map_(?:graph|observed|command)_\w+\s+(?:WHEN [^;]+\s+)?BEGIN SELECT RAISE\(ABORT, '(?:[^']|'')*'\); END$/.test(sql)) fail("unsupported trigger DDL " + name);
      }
      objects.push({ type: type.toLowerCase(), name, sql });
      offset++;
      ended = true;
      break;
    }
    if (!ended || quoted || depth !== 0) fail("incomplete DDL " + name);
  }
  if (!objects.length) fail("empty schema source");
  return objects;
}

const GRAPH_SQL = readFileSync(new URL("./graph-schema.sql", import.meta.url), "utf8");
const OBSERVED_SQL = readFileSync(new URL("./observed-geography-schema.sql", import.meta.url), "utf8");
const GRAPH_OBJECTS = schemaObjects(GRAPH_SQL);
const OBSERVED_OBJECTS = schemaObjects(OBSERVED_SQL);
const UNION_OBJECTS = [...GRAPH_OBJECTS, ...OBSERVED_OBJECTS];
const COMMAND_SQL = readFileSync(new URL("./command-schema.sql", import.meta.url), "utf8");
const COMMAND_OBJECTS = [...UNION_OBJECTS, ...schemaObjects(COMMAND_SQL)];
if (new Set(UNION_OBJECTS.map(row => row.name)).size !== UNION_OBJECTS.length) fail("duplicate union object");
const encode = objects => canonicalEncode(objects.toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const GRAPH_EXPECTED = encode(GRAPH_OBJECTS), OBSERVED_EXPECTED = encode(OBSERVED_OBJECTS), UNION_EXPECTED = encode(UNION_OBJECTS);

function expected(mode) {
  switch (mode) {
    case "janseon-graph-store.v1": return GRAPH_EXPECTED;
    case "janseon-observed-geography-store.v1": return OBSERVED_EXPECTED;
    case "janseon-central-store.v1": return UNION_EXPECTED;
    case "janseon-command-store.v1": return encode(COMMAND_OBJECTS);
    default: fail("unsupported schema mode");
  }
}

function connectionBoundary(db) {
  if (db.prepare("PRAGMA database_list").all().some(row => !["main", "temp"].includes(row.name))
      || db.prepare("SELECT count(*) AS n FROM sqlite_temp_schema").get().n !== 0
      || db.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) fail("connection boundary");
}

/** The mode selects a fixed whole schema, never caller trust or extra objects. */
export function assertStoreSchema(db, mode) {
  const identity = expected(mode);
  connectionBoundary(db);
  const actual = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
  if (canonicalEncode(actual.map(row => ({ ...row }))) !== identity) fail("schema drift");
}

/** Install one of three fixed schemas into an entirely fresh database. */
export function initializeStoreSchema(db, mode) {
  expected(mode);
  const started = !db.isTransaction;
  if (started) db.exec("PRAGMA foreign_keys=ON");
  connectionBoundary(db);
  if (db.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n) fail("database is not empty");
  if (started) db.exec("BEGIN IMMEDIATE");
  let savepoint = false;
  try {
    db.exec("SAVEPOINT map_schema_install"); savepoint = true;
    if (mode !== "janseon-observed-geography-store.v1") db.exec(GRAPH_SQL);
    if (mode !== "janseon-graph-store.v1") db.exec(OBSERVED_SQL);
    if (mode === "janseon-command-store.v1") db.exec(COMMAND_SQL);
    assertStoreSchema(db, mode);
    db.exec(started ? "COMMIT" : "RELEASE map_schema_install");
  } catch (error) {
    if (db.isTransaction) {
      if (savepoint) db.exec("ROLLBACK TO map_schema_install; RELEASE map_schema_install");
      if (started) db.exec("ROLLBACK");
    }
    throw error;
  }
}
