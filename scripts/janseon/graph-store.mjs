/*
Adapted from seoul-dengoku-wiki/scripts/cast-sqlite/world-graph-document.{sql,mjs}
https://github.com/islee23520/seoul-dengoku-wiki/tree/50ae1e930981d3115847f723d366bbb9e3247ec0
Modified: namespaced graph editions, constraints, seals and semantic projection.

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

import { createHash } from "node:crypto";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { assertStoreSchema, initializeStoreSchema } from "./store-schema.mjs";

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code }); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const quote = (name) => `"${name}"`;

const ROOT_KEYS = ['schema', 'districts', 'stations', 'edges', 'aliases', 'source'];
const STATION_KEYS = ['id', 'nameKo', 'nameEn', 'district', 'lat', 'lon'];
const EDGE_KEYS = ['a', 'b'];
const SOURCE_KEYS = ['original', 'railAdjacency'];
const RAIL_KEYS = ['revision', 'officialSource', 'WikiCommit', 'scope', 'replacements', 'excluded', 'hubIdentities'];
const OFFICIAL_KEYS = ['url', 'retrievedAt', 'sha256', 'scope'];
const REPLACEMENT_KEYS = ['originalIndex', 'original', 'status', 'chain', 'officialCodes', 'lineId', 'source', 'physicalEvidenceBoundary'];
const EXCLUDED_REQUIRED = ['originalIndex', 'original', 'status', 'support'];
const EXCLUDED_OPTIONAL = ['reason', 'missing'];
const SUPPORT_KEYS = ['index', 'a', 'b', 'mappedA', 'mappedB', 'classification', 'officialAdjacentSupport', 'skippedStopEvidence', 'openingEdgeSupport', 'endpointClassification', 'noSurfaceAdjacencyInference', 'evidence_refs'];
const SKIPPED_KEYS = ['lineId', 'lineName', 'pathIndex', 'codes', 'stationIds', 'names', 'skippedStops'];
const EVIDENCE_REF_KEYS = ['path', 'selector'];
const HUB_KEYS = ['uid', 'officialCodes', 'permanentIds', 'lineIds', 'evidence', 'contract'];
const HUB_EVIDENCE_KEYS = ['lineId', 'lineName', 'code', 'uid', 'name', 'pathIndex', 'stationIndex'];

const CHILD_TABLES = Object.freeze([
  ['map_graph_district', 'district_count'],
  ['map_graph_station', 'station_count'],
  ['map_graph_edge', 'edge_count'],
  ['map_graph_alias', 'alias_count'],
  ['map_graph_replacement', 'replacement_count'],
  ['map_graph_excluded', 'excluded_count'],
  ['map_graph_hub', 'hub_count'],
]);

const GRAPH_TABLES = Object.freeze([
  'map_graph_import',
  'map_graph_root',
  'map_graph_district',
  'map_graph_station',
  'map_graph_edge',
  'map_graph_alias',
  'map_graph_replacement',
  'map_graph_replacement_chain',
  'map_graph_replacement_code',
  'map_graph_excluded',
  'map_graph_excluded_missing',
  'map_graph_excluded_adjacent',
  'map_graph_excluded_opening',
  'map_graph_excluded_endpoint',
  'map_graph_excluded_evidence_ref',
  'map_graph_excluded_skipped',
  'map_graph_excluded_skipped_code',
  'map_graph_excluded_skipped_station',
  'map_graph_excluded_skipped_name',
  'map_graph_hub',
  'map_graph_hub_official_code',
  'map_graph_hub_permanent_id',
  'map_graph_hub_line_id',
  'map_graph_hub_evidence',
]);

function sameKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function text(value) {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
}

function integer(value) {
  return Number.isSafeInteger(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
}

function decimalText(value) {
  if (!finiteNumber(value)) fail('E_GRAPH_SHAPE', 'decimal');
  const rendered = JSON.stringify(value);
  if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(rendered)) fail('E_GRAPH_SHAPE', 'decimal');
  return rendered;
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => !text(item))) fail('E_GRAPH_SHAPE', label);
  return value;
}

function presence(owner, key) {
  if (!own(owner, key)) return ['missing', null];
  if (owner[key] === null) return ['null', null];
  if (!text(owner[key])) fail('E_GRAPH_SHAPE', key);
  return ['value', owner[key]];
}

function officialSource(value, label) {
  if (!sameKeys(value, OFFICIAL_KEYS) || ![value.url, value.retrievedAt, value.sha256, value.scope].every(text)) {
    fail('E_GRAPH_SHAPE', label);
  }
  return value;
}

function inspect(document) {
  canonicalEncode(document);
  if (document?.schema !== "seoul-world-graph-v2") fail("E_GRAPH_SHAPE", "schema");
  if (!sameKeys(document, ROOT_KEYS)) fail('E_GRAPH_SHAPE', 'root');
  if (!text(document.schema)) fail('E_GRAPH_SHAPE', 'schema');
  stringList(document.districts, 'districts');
  if (!Array.isArray(document.stations)) fail('E_GRAPH_SHAPE', 'stations');
  for (const station of document.stations) {
    if (!sameKeys(station, STATION_KEYS)) fail('E_GRAPH_SHAPE', 'station');
    if (![station.id, station.nameKo, station.nameEn, station.district].every(text)) fail('E_GRAPH_SHAPE', 'station text');
    if (!finiteNumber(station.lat) || !finiteNumber(station.lon)) fail('E_GRAPH_SHAPE', 'station coordinate');
  }
  if (!Array.isArray(document.edges)) fail('E_GRAPH_SHAPE', 'edges');
  for (const edge of document.edges) {
    if (!sameKeys(edge, EDGE_KEYS) || !text(edge.a) || !text(edge.b)) fail('E_GRAPH_SHAPE', 'edge');
  }
  if (!document.aliases || typeof document.aliases !== 'object' || Array.isArray(document.aliases)) fail('E_GRAPH_SHAPE', 'aliases');
  for (const value of Object.values(document.aliases)) {
    if (!text(value)) fail('E_GRAPH_SHAPE', 'alias');
  }
  if (!sameKeys(document.source, SOURCE_KEYS) || !text(document.source.original)) fail('E_GRAPH_SHAPE', 'source');
  const rail = document.source.railAdjacency;
  if (!sameKeys(rail, RAIL_KEYS)) fail('E_GRAPH_SHAPE', 'railAdjacency');
  if (![rail.revision, rail.WikiCommit, rail.scope].every(text)) fail('E_GRAPH_SHAPE', 'rail text');
  officialSource(rail.officialSource, 'officialSource');
  if (!Array.isArray(rail.replacements) || !Array.isArray(rail.excluded) || !Array.isArray(rail.hubIdentities)) {
    fail('E_GRAPH_SHAPE', 'rail lists');
  }
  for (const replacement of rail.replacements) {
    if (!sameKeys(replacement, REPLACEMENT_KEYS)) fail('E_GRAPH_SHAPE', 'replacement');
    if (!integer(replacement.originalIndex)) fail('E_GRAPH_SHAPE', 'replacement index');
    if (!sameKeys(replacement.original, EDGE_KEYS) || !text(replacement.original.a) || !text(replacement.original.b)) fail('E_GRAPH_SHAPE', 'replacement original');
    if (!text(replacement.status) || !text(replacement.lineId) || !text(replacement.physicalEvidenceBoundary)) fail('E_GRAPH_SHAPE', 'replacement text');
    stringList(replacement.chain, 'replacement chain');
    stringList(replacement.officialCodes, 'replacement codes');
    officialSource(replacement.source, 'replacement source');
  }
  for (const excluded of rail.excluded) {
    if (!excluded || typeof excluded !== 'object' || Array.isArray(excluded)) fail('E_GRAPH_SHAPE', 'excluded');
    const keys = Object.keys(excluded);
    const allowed = new Set([...EXCLUDED_REQUIRED, ...EXCLUDED_OPTIONAL]);
    if (EXCLUDED_REQUIRED.some((key) => !own(excluded, key)) || keys.some((key) => !allowed.has(key))) fail('E_GRAPH_SHAPE', 'excluded keys');
    const expectedKeys = ['originalIndex', 'original', 'status',
      ...EXCLUDED_OPTIONAL.filter(key => own(excluded, key)), 'support'];
    if (!sameKeys(excluded, expectedKeys)) fail('E_GRAPH_SHAPE', 'excluded order');
    if (!integer(excluded.originalIndex) || !text(excluded.status)) fail('E_GRAPH_SHAPE', 'excluded scalar');
    if (!sameKeys(excluded.original, EDGE_KEYS) || !text(excluded.original.a) || !text(excluded.original.b)) fail('E_GRAPH_SHAPE', 'excluded original');
    presence(excluded, 'reason');
    if (own(excluded, 'missing')) stringList(excluded.missing, 'excluded missing');
    if (own(excluded, 'reason') && own(excluded, 'missing')) fail('E_GRAPH_SHAPE', 'excluded alternatives');
    const support = excluded.support;
    if (!sameKeys(support, SUPPORT_KEYS)) fail('E_GRAPH_SHAPE', 'support');
    if (!integer(support.index) || ![support.a, support.b, support.mappedA, support.mappedB, support.classification].every(text)) fail('E_GRAPH_SHAPE', 'support scalar');
    if (typeof support.noSurfaceAdjacencyInference !== 'boolean') fail('E_GRAPH_SHAPE', 'support flag');
    for (const key of ['officialAdjacentSupport', 'openingEdgeSupport']) stringList(support[key], key);
    if (!Array.isArray(support.endpointClassification) || support.endpointClassification.some((item) => !text(item))) fail('E_GRAPH_SHAPE', 'endpoint');
    if (!Array.isArray(support.evidence_refs)) fail('E_GRAPH_SHAPE', 'evidence_refs');
    for (const ref of support.evidence_refs) {
      if (!sameKeys(ref, EVIDENCE_REF_KEYS) || !text(ref.path) || !text(ref.selector)) fail('E_GRAPH_SHAPE', 'evidence ref');
    }
    if (!Array.isArray(support.skippedStopEvidence)) fail('E_GRAPH_SHAPE', 'skipped');
    for (const skipped of support.skippedStopEvidence) {
      if (!sameKeys(skipped, SKIPPED_KEYS)) fail('E_GRAPH_SHAPE', 'skipped keys');
      if (![skipped.lineId, skipped.lineName].every(text) || !integer(skipped.pathIndex) || !integer(skipped.skippedStops)) fail('E_GRAPH_SHAPE', 'skipped scalar');
      stringList(skipped.codes, 'skipped codes');
      stringList(skipped.stationIds, 'skipped stations');
      stringList(skipped.names, 'skipped names');
    }
  }
  for (const hub of rail.hubIdentities) {
    if (!sameKeys(hub, HUB_KEYS) || !text(hub.uid) || !text(hub.contract)) fail('E_GRAPH_SHAPE', 'hub');
    stringList(hub.officialCodes, 'hub codes');
    stringList(hub.permanentIds, 'hub permanent');
    stringList(hub.lineIds, 'hub lines');
    if (!Array.isArray(hub.evidence)) fail('E_GRAPH_SHAPE', 'hub evidence');
    for (const evidence of hub.evidence) {
      if (!sameKeys(evidence, HUB_EVIDENCE_KEYS)) fail('E_GRAPH_SHAPE', 'hub evidence keys');
      if (![evidence.lineId, evidence.lineName, evidence.code, evidence.uid, evidence.name].every(text)) fail('E_GRAPH_SHAPE', 'hub evidence text');
      if (!integer(evidence.pathIndex) || !integer(evidence.stationIndex)) fail('E_GRAPH_SHAPE', 'hub evidence index');
    }
  }
}

function insert(rows, table, row) {
  rows[table].push(row);
}

function documentRows(document, binding, receipt) {
  const db = Object.fromEntries(GRAPH_TABLES.map(table => [table, []]));
  insert(db, "map_graph_import", receipt);
  inspect(document);
  const rail = document.source.railAdjacency;
  const official = rail.officialSource;
  insert(db, 'map_graph_root', {
    singleton: 1,
    schema: document.schema,
    district_count: document.districts.length,
    station_count: document.stations.length,
    edge_count: document.edges.length,
    alias_count: Object.keys(document.aliases).length,
    source_original: document.source.original,
    rail_revision: rail.revision,
    rail_wiki_commit: rail.WikiCommit,
    rail_scope: rail.scope,
    rail_official_url: official.url,
    rail_official_retrieved_at: official.retrievedAt,
    rail_official_sha256: official.sha256,
    rail_official_scope: official.scope,
    replacement_count: rail.replacements.length,
    excluded_count: rail.excluded.length,
    hub_count: rail.hubIdentities.length,
  });
  document.districts.forEach((name, ordinal) => insert(db, 'map_graph_district', { ordinal, name }));
  document.stations.forEach((station, ordinal) => insert(db, 'map_graph_station', {
    ordinal,
    station_id: station.id,
    name_ko: station.nameKo,
    name_en: station.nameEn,
    district: station.district,
    lat: station.lat,
    lon: station.lon,
    lat_text: decimalText(station.lat),
    lon_text: decimalText(station.lon),
  }));
  document.edges.forEach((edge, ordinal) => insert(db, 'map_graph_edge', { ordinal, endpoint_a: edge.a, endpoint_b: edge.b }));
  Object.entries(document.aliases).forEach(([alias_key, alias_value], ordinal) => insert(db, 'map_graph_alias', { ordinal, alias_key, alias_value }));
  rail.replacements.forEach((replacement, ordinal) => {
    insert(db, 'map_graph_replacement', {
      ordinal,
      original_index: replacement.originalIndex,
      original_a: replacement.original.a,
      original_b: replacement.original.b,
      status: replacement.status,
      line_id: replacement.lineId,
      physical_evidence_boundary: replacement.physicalEvidenceBoundary,
      chain_count: replacement.chain.length,
      official_code_count: replacement.officialCodes.length,
      source_url: replacement.source.url,
      source_retrieved_at: replacement.source.retrievedAt,
      source_sha256: replacement.source.sha256,
      source_scope: replacement.source.scope,
    });
    replacement.chain.forEach((value, index) => insert(db, 'map_graph_replacement_chain', { replacement_ordinal: ordinal, ordinal: index, value }));
    replacement.officialCodes.forEach((value, index) => insert(db, 'map_graph_replacement_code', { replacement_ordinal: ordinal, ordinal: index, value }));
  });
  rail.excluded.forEach((excluded, ordinal) => {
    const [reason_presence, reason] = presence(excluded, 'reason');
    const support = excluded.support;
    insert(db, 'map_graph_excluded', {
      ordinal,
      original_index: excluded.originalIndex,
      original_a: excluded.original.a,
      original_b: excluded.original.b,
      status: excluded.status,
      reason_presence,
      reason,
      missing_presence: own(excluded, 'missing') ? 'present' : 'missing',
      missing_count: own(excluded, 'missing') ? excluded.missing.length : 0,
      support_index: support.index,
      support_a: support.a,
      support_b: support.b,
      support_mapped_a: support.mappedA,
      support_mapped_b: support.mappedB,
      support_classification: support.classification,
      support_no_surface_adjacency_inference: support.noSurfaceAdjacencyInference ? 1 : 0,
      adjacent_count: support.officialAdjacentSupport.length,
      skipped_count: support.skippedStopEvidence.length,
      opening_count: support.openingEdgeSupport.length,
      endpoint_count: support.endpointClassification.length,
      evidence_ref_count: support.evidence_refs.length,
    });
    if (own(excluded, 'missing')) {
      excluded.missing.forEach((value, index) => insert(db, 'map_graph_excluded_missing', { excluded_ordinal: ordinal, ordinal: index, value }));
    }
    support.officialAdjacentSupport.forEach((value, index) => insert(db, 'map_graph_excluded_adjacent', { excluded_ordinal: ordinal, ordinal: index, value }));
    support.openingEdgeSupport.forEach((value, index) => insert(db, 'map_graph_excluded_opening', { excluded_ordinal: ordinal, ordinal: index, value }));
    support.endpointClassification.forEach((value, index) => insert(db, 'map_graph_excluded_endpoint', { excluded_ordinal: ordinal, ordinal: index, value }));
    support.evidence_refs.forEach((ref, index) => insert(db, 'map_graph_excluded_evidence_ref', { excluded_ordinal: ordinal, ordinal: index, path: ref.path, selector: ref.selector }));
    support.skippedStopEvidence.forEach((skipped, skippedOrdinal) => {
      insert(db, 'map_graph_excluded_skipped', {
        excluded_ordinal: ordinal,
        ordinal: skippedOrdinal,
        line_id: skipped.lineId,
        line_name: skipped.lineName,
        path_index: skipped.pathIndex,
        skipped_stops: skipped.skippedStops,
        code_count: skipped.codes.length,
        station_id_count: skipped.stationIds.length,
        name_count: skipped.names.length,
      });
      skipped.codes.forEach((value, index) => insert(db, 'map_graph_excluded_skipped_code', { excluded_ordinal: ordinal, skipped_ordinal: skippedOrdinal, ordinal: index, value }));
      skipped.stationIds.forEach((value, index) => insert(db, 'map_graph_excluded_skipped_station', { excluded_ordinal: ordinal, skipped_ordinal: skippedOrdinal, ordinal: index, value }));
      skipped.names.forEach((value, index) => insert(db, 'map_graph_excluded_skipped_name', { excluded_ordinal: ordinal, skipped_ordinal: skippedOrdinal, ordinal: index, value }));
    });
  });
  rail.hubIdentities.forEach((hub, ordinal) => {
    insert(db, 'map_graph_hub', {
      ordinal,
      uid: hub.uid,
      contract: hub.contract,
      official_code_count: hub.officialCodes.length,
      permanent_id_count: hub.permanentIds.length,
      line_id_count: hub.lineIds.length,
      evidence_count: hub.evidence.length,
    });
    hub.officialCodes.forEach((value, index) => insert(db, 'map_graph_hub_official_code', { hub_ordinal: ordinal, ordinal: index, value }));
    hub.permanentIds.forEach((value, index) => insert(db, 'map_graph_hub_permanent_id', { hub_ordinal: ordinal, ordinal: index, value }));
    hub.lineIds.forEach((value, index) => insert(db, 'map_graph_hub_line_id', { hub_ordinal: ordinal, ordinal: index, value }));
    hub.evidence.forEach((evidence, index) => insert(db, 'map_graph_hub_evidence', {
      hub_ordinal: ordinal,
      ordinal: index,
      line_id: evidence.lineId,
      line_name: evidence.lineName,
      code: evidence.code,
      uid: evidence.uid,
      name: evidence.name,
      path_index: evidence.pathIndex,
      station_index: evidence.stationIndex,
    }));
  });
  return namespaceRows(db, binding);
}

function ordered(rows, expected) {
  if (rows.length !== expected || rows.some((row, index) => row.ordinal !== index)) fail('E_GRAPH_INTEGRITY', 'ordinal');
  return rows;
}

function grouped(rows, parentColumn, parentOrdinal, expected, label) {
  const matches = rows.filter((row) => row[parentColumn] === parentOrdinal);
  if (matches.length !== expected || matches.some((row, index) => row.ordinal !== index)) fail('E_GRAPH_INTEGRITY', label);
  return matches;
}

function countOf(db, table) {
  return db[table].length;
}

function readDocument(db) {
  const rootRows = db.map_graph_root;
  if (rootRows.length !== 1 || rootRows[0].singleton !== 1) fail('E_GRAPH_INTEGRITY', 'root');
  const root = rootRows[0];
  const imports = db.map_graph_import;
  if (imports.length !== 1 || imports[0].singleton !== 1) fail('E_GRAPH_INTEGRITY', 'import');
  const receipt = imports[0];
  for (const [table, countColumn] of CHILD_TABLES) {
    if (countOf(db, table) !== root[countColumn]) fail('E_GRAPH_INTEGRITY', table);
  }
  const districts = ordered(db.map_graph_district, root.district_count);
  const stations = ordered(db.map_graph_station, root.station_count);
  const edges = ordered(db.map_graph_edge, root.edge_count);
  const aliases = ordered(db.map_graph_alias, root.alias_count);
  const replacements = ordered(db.map_graph_replacement, root.replacement_count);
  const excluded = ordered(db.map_graph_excluded, root.excluded_count);
  const hubs = ordered(db.map_graph_hub, root.hub_count);
  const replacementChains = db.map_graph_replacement_chain;
  const replacementCodes = db.map_graph_replacement_code;
  const missing = db.map_graph_excluded_missing;
  const adjacent = db.map_graph_excluded_adjacent;
  const opening = db.map_graph_excluded_opening;
  const endpoints = db.map_graph_excluded_endpoint;
  const evidenceRefs = db.map_graph_excluded_evidence_ref;
  const skipped = db.map_graph_excluded_skipped;
  const skippedCodes = db.map_graph_excluded_skipped_code;
  const skippedStations = db.map_graph_excluded_skipped_station;
  const skippedNames = db.map_graph_excluded_skipped_name;
  const hubCodes = db.map_graph_hub_official_code;
  const hubPermanent = db.map_graph_hub_permanent_id;
  const hubLines = db.map_graph_hub_line_id;
  const hubEvidence = db.map_graph_hub_evidence;

  const document = {
    schema: root.schema,
    districts: districts.map((row) => row.name),
    stations: stations.map((row) => {
      const lat = row.lat;
      const lon = row.lon;
      if (JSON.stringify(lat) !== row.lat_text || JSON.stringify(lon) !== row.lon_text) fail('E_GRAPH_INTEGRITY', 'coordinate');
      return { id: row.station_id, nameKo: row.name_ko, nameEn: row.name_en, district: row.district, lat, lon };
    }),
    edges: edges.map((row) => ({ a: row.endpoint_a, b: row.endpoint_b })),
    aliases: Object.fromEntries(aliases.map((row) => [row.alias_key, row.alias_value])),
    source: {
      original: root.source_original,
      railAdjacency: {
        revision: root.rail_revision,
        officialSource: {
          url: root.rail_official_url,
          retrievedAt: root.rail_official_retrieved_at,
          sha256: root.rail_official_sha256,
          scope: root.rail_official_scope,
        },
        WikiCommit: root.rail_wiki_commit,
        scope: root.rail_scope,
        replacements: replacements.map((row) => ({
          originalIndex: row.original_index,
          original: { a: row.original_a, b: row.original_b },
          status: row.status,
          chain: grouped(replacementChains, 'replacement_ordinal', row.ordinal, row.chain_count, 'chain').map((item) => item.value),
          officialCodes: grouped(replacementCodes, 'replacement_ordinal', row.ordinal, row.official_code_count, 'code').map((item) => item.value),
          lineId: row.line_id,
          source: {
            url: row.source_url,
            retrievedAt: row.source_retrieved_at,
            sha256: row.source_sha256,
            scope: row.source_scope,
          },
          physicalEvidenceBoundary: row.physical_evidence_boundary,
        })),
        excluded: excluded.map((row) => {
          const item = {
            originalIndex: row.original_index,
            original: { a: row.original_a, b: row.original_b },
            status: row.status,
          };
          if (row.reason_presence === 'value') item.reason = row.reason;
          else if (row.reason_presence === 'null') item.reason = null;
          else if (row.reason_presence !== 'missing' || row.reason !== null) fail('E_GRAPH_INTEGRITY', 'reason');
          const missingRows = missing.filter((entry) => entry.excluded_ordinal === row.ordinal);
          if (missingRows.length !== row.missing_count || missingRows.some((entry, index) => entry.ordinal !== index)) fail('E_GRAPH_INTEGRITY', 'missing');
          if (row.missing_presence === 'present') item.missing = missingRows.map((entry) => entry.value);
          else if (row.missing_presence !== 'missing' || missingRows.length !== 0) fail('E_GRAPH_INTEGRITY', 'missing presence');
          const adjacentRows = grouped(adjacent, 'excluded_ordinal', row.ordinal, row.adjacent_count, 'adjacent');
          const openingRows = grouped(opening, 'excluded_ordinal', row.ordinal, row.opening_count, 'opening');
          const endpointRows = grouped(endpoints, 'excluded_ordinal', row.ordinal, row.endpoint_count, 'endpoint');
          const refRows = grouped(evidenceRefs, 'excluded_ordinal', row.ordinal, row.evidence_ref_count, 'evidence ref');
          const skippedRows = grouped(skipped, 'excluded_ordinal', row.ordinal, row.skipped_count, 'skipped');
          item.support = {
            index: row.support_index,
            a: row.support_a,
            b: row.support_b,
            mappedA: row.support_mapped_a,
            mappedB: row.support_mapped_b,
            classification: row.support_classification,
            officialAdjacentSupport: adjacentRows.map((entry) => entry.value),
            skippedStopEvidence: skippedRows.map((skippedRow) => ({
              lineId: skippedRow.line_id,
              lineName: skippedRow.line_name,
              pathIndex: skippedRow.path_index,
              codes: nested(skippedCodes, row.ordinal, skippedRow.ordinal, skippedRow.code_count),
              stationIds: nested(skippedStations, row.ordinal, skippedRow.ordinal, skippedRow.station_id_count),
              names: nested(skippedNames, row.ordinal, skippedRow.ordinal, skippedRow.name_count),
              skippedStops: skippedRow.skipped_stops,
            })),
            openingEdgeSupport: openingRows.map((entry) => entry.value),
            endpointClassification: endpointRows.map((entry) => entry.value),
            noSurfaceAdjacencyInference: row.support_no_surface_adjacency_inference === 1,
            evidence_refs: refRows.map((entry) => ({ path: entry.path, selector: entry.selector })),
          };
          if (![0, 1].includes(row.support_no_surface_adjacency_inference)) fail('E_GRAPH_INTEGRITY', 'flag');
          return item;
        }),
        hubIdentities: hubs.map((row) => ({
          uid: row.uid,
          officialCodes: grouped(hubCodes, 'hub_ordinal', row.ordinal, row.official_code_count, 'hub code').map((entry) => entry.value),
          permanentIds: grouped(hubPermanent, 'hub_ordinal', row.ordinal, row.permanent_id_count, 'hub permanent').map((entry) => entry.value),
          lineIds: grouped(hubLines, 'hub_ordinal', row.ordinal, row.line_id_count, 'hub line').map((entry) => entry.value),
          evidence: grouped(hubEvidence, 'hub_ordinal', row.ordinal, row.evidence_count, 'hub evidence').map((entry) => ({
            lineId: entry.line_id,
            lineName: entry.line_name,
            code: entry.code,
            uid: entry.uid,
            name: entry.name,
            pathIndex: entry.path_index,
            stationIndex: entry.station_index,
          })),
          contract: row.contract,
        })),
      },
    },
  };
  const consumed = {
    map_graph_replacement_chain: replacements.reduce((sum, row) => sum + row.chain_count, 0),
    map_graph_replacement_code: replacements.reduce((sum, row) => sum + row.official_code_count, 0),
    map_graph_excluded_missing: excluded.reduce((sum, row) => sum + row.missing_count, 0),
    map_graph_excluded_adjacent: excluded.reduce((sum, row) => sum + row.adjacent_count, 0),
    map_graph_excluded_opening: excluded.reduce((sum, row) => sum + row.opening_count, 0),
    map_graph_excluded_endpoint: excluded.reduce((sum, row) => sum + row.endpoint_count, 0),
    map_graph_excluded_evidence_ref: excluded.reduce((sum, row) => sum + row.evidence_ref_count, 0),
    map_graph_excluded_skipped: excluded.reduce((sum, row) => sum + row.skipped_count, 0),
    map_graph_hub_official_code: hubs.reduce((sum, row) => sum + row.official_code_count, 0),
    map_graph_hub_permanent_id: hubs.reduce((sum, row) => sum + row.permanent_id_count, 0),
    map_graph_hub_line_id: hubs.reduce((sum, row) => sum + row.line_id_count, 0),
    map_graph_hub_evidence: hubs.reduce((sum, row) => sum + row.evidence_count, 0),
  };
  for (const [table, expected] of Object.entries(consumed)) {
    if (countOf(db, table) !== expected) fail('E_GRAPH_INTEGRITY', table);
  }
  const skippedConsumed = skipped.reduce((sums, row) => {
    sums.code += row.code_count;
    sums.station += row.station_id_count;
    sums.name += row.name_count;
    return sums;
  }, { code: 0, station: 0, name: 0 });
  if (countOf(db, 'map_graph_excluded_skipped_code') !== skippedConsumed.code) fail('E_GRAPH_INTEGRITY', 'skipped code');
  if (countOf(db, 'map_graph_excluded_skipped_station') !== skippedConsumed.station) fail('E_GRAPH_INTEGRITY', 'skipped station');
  if (countOf(db, 'map_graph_excluded_skipped_name') !== skippedConsumed.name) fail('E_GRAPH_INTEGRITY', 'skipped name');
  if (sha(JSON.stringify(document)) !== receipt.document_sha256) fail('E_GRAPH_DIGEST', 'document');
  inspect(document);
  validateReferences(document);
  return document;
}

function nested(rows, excludedOrdinal, skippedOrdinal, expected) {
  const matches = rows.filter((row) => row.excluded_ordinal === excludedOrdinal && row.skipped_ordinal === skippedOrdinal);
  if (matches.length !== expected || matches.some((row, index) => row.ordinal !== index)) fail('E_GRAPH_INTEGRITY', 'nested');
  return matches.map((row) => row.value);
}

const BINDING_KEYS = ["dataset_id","edition_id","schema_contract","projection_contract","source_schema","expected_source_sha256","expected_document_sha256","expected_byte_length","source_package_content_id","source_authentication_receipt_sha256","source_revision","source_reader_sha256","source_schema_sha256","field_disposition_sha256","game_source_manifest_sha256","rights_receipt_content_id"];
const RECEIPT_KEYS = ["singleton", "actor", "reason", "source_sha256", "document_sha256", "byte_length"];
const INITIAL_SOURCE = "46985afccc2d3f2b5e4e3152254d30bc023d0688d63745a951a9be0f6ebf097d";
const INITIAL_DOCUMENT = "0af399f295580d8f768594100c0a430621f15db0eb3b30e4581a8c07aa465c29";
const INITIAL_COUNTS = [1, 1, 25, 334, 409, 3, 24, 86, 86, 5, 1, 0, 0, 10, 1, 1, 3, 3, 3, 94, 195, 116, 198, 234];
const ENTITY_KEYS = {
  root: ["graph-document", () => "/"],
  district: ["graph-district", row => row.name],
  station: ["graph-station", row => row.station_id],
  edge: ["graph-edge", row => "/edges/" + row.ordinal],
  alias: ["graph-alias", row => row.alias_key],
  replacement: ["graph-replacement", row => "/source/railAdjacency/replacements/" + row.ordinal],
  excluded: ["graph-exclusion", row => "/source/railAdjacency/excluded/" + row.ordinal],
  hub: ["graph-hub", row => row.uid],
};

function exactRecord(value, keys, label) {
  canonicalEncode(value);
  if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).length !== keys.length || keys.some(key => !own(value, key))) {
    fail("E_GRAPH_SHAPE", label);
  }
}

function validateBinding(binding) {
  exactRecord(binding, BINDING_KEYS, "binding");
  for (const key of BINDING_KEYS) {
    const value = binding[key];
    if (key === "expected_byte_length") {
      if (!integer(value) || value < 0) fail("E_GRAPH_BINDING", key);
    } else if (!text(value) || !value.length || (key.endsWith("_sha256") && !/^[a-f0-9]{64}$/.test(value))) {
      fail("E_GRAPH_BINDING", key);
    }
  }
  if (binding.schema_contract !== "janseon-graph-store.v1"
      || binding.projection_contract !== "janseon-graph-semantic.v1"
      || binding.source_schema !== "seoul-world-graph-v2") fail("E_GRAPH_BINDING", "contract");
  for (const key of ["source_package_content_id", "rights_receipt_content_id"]) {
    if (/[\\/]/.test(binding[key]) || /^[A-Za-z]:/.test(binding[key])) fail("E_GRAPH_BINDING", "opaque content reference");
  }
  if (binding.dataset_id === "seoul-world-graph") {
    if (binding.edition_id !== "source-sha256:" + INITIAL_SOURCE
        || binding.expected_source_sha256 !== INITIAL_SOURCE
        || binding.expected_document_sha256 !== INITIAL_DOCUMENT
        || binding.expected_byte_length !== 217947) fail("E_GRAPH_BINDING", "initial edition pins");
  } else if (!binding.dataset_id.startsWith("synthetic:")) {
    fail("E_GRAPH_BINDING", "unsupported dataset");
  }
}

function validateReceipt(receipt, binding) {
  exactRecord(receipt, RECEIPT_KEYS, "source receipt");
  if (receipt.singleton !== 1 || !text(receipt.actor) || !receipt.actor.trim()
      || !text(receipt.reason) || !receipt.reason.trim()
      || receipt.source_sha256 !== binding.expected_source_sha256
      || receipt.document_sha256 !== binding.expected_document_sha256
      || receipt.byte_length !== binding.expected_byte_length) fail("E_GRAPH_BINDING", "source receipt");
}

function validateReferences(document) {
  const unique = (values, label) => {
    if (new Set(values).size !== values.length) fail("E_GRAPH_REFERENCE", "duplicate " + label);
    return new Set(values);
  };
  const districts = unique(document.districts, "district");
  const stations = unique(document.stations.map(station => station.id), "station");
  if (stations.has("")) fail("E_GRAPH_REFERENCE", "empty station");
  const stationRef = id => { if (!stations.has(id)) fail("E_GRAPH_REFERENCE", "station"); };
  for (const station of document.stations) if (!districts.has(station.district)) fail("E_GRAPH_REFERENCE", "district");
  const pairs = new Set();
  for (const edge of document.edges) {
    stationRef(edge.a); stationRef(edge.b);
    const pair = JSON.stringify([edge.a, edge.b].sort());
    if (edge.a === edge.b || pairs.has(pair)) fail("E_GRAPH_REFERENCE", "duplicate or self edge");
    pairs.add(pair);
  }
  for (const [key, value] of Object.entries(document.aliases)) {
    if (!text(key)) fail("E_GRAPH_SHAPE", "alias key");
    stationRef(value);
  }
  const rail = document.source.railAdjacency;
  unique([...rail.replacements, ...rail.excluded].map(row => row.originalIndex), "original index");
  unique(rail.hubIdentities.map(row => row.uid), "hub uid");
  for (const replacement of rail.replacements) replacement.chain.forEach(stationRef);
  for (const hub of rail.hubIdentities) hub.permanentIds.forEach(stationRef);
}

function namespaceRows(rows, binding) {
  for (const table of GRAPH_TABLES) {
    const entity = ENTITY_KEYS[table.slice("map_graph_".length)];
    rows[table] = rows[table].map(row => ({
      dataset_id: binding.dataset_id, edition_id: binding.edition_id,
      ...(entity ? { entity_kind: entity[0], source_id: entity[1](row) } : {}), ...row,
    }));
  }
  return rows;
}

function schemaBoundary(db, mode) {
  if (!["janseon-graph-store.v1", "janseon-central-store.v1"].includes(mode)) fail("E_GRAPH_SCHEMA", "unsupported schema mode");
  try { assertStoreSchema(db, mode); } catch (error) {
    if (error.code === "E_STORE_SCHEMA") fail("E_GRAPH_SCHEMA", error.message);
    throw error;
  }
}

function transaction(db, action) {
  const started = !db.isTransaction;
  if (started) db.exec("BEGIN IMMEDIATE");
  db.exec("SAVEPOINT map_graph_write");
  try {
    const result = action();
    db.exec(started ? "COMMIT" : "RELEASE map_graph_write");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO map_graph_write");
    db.exec("RELEASE map_graph_write");
    if (started) db.exec("ROLLBACK");
    throw error;
  }
}

function insertRow(db, table, row) {
  const columns = Object.keys(row);
  db.prepare("INSERT INTO " + table + " (" + columns.map(quote).join(",") + ") VALUES (" + columns.map(() => "?").join(",") + ")")
    .run(...columns.map(column => row[column]));
}

function validateRows(rows, document, binding, receipt) {
  const expected = documentRows(document, binding, receipt);
  for (const table of GRAPH_TABLES) {
    if (canonicalEncode(rows[table].map(row => ({ ...row }))) !== canonicalEncode(expected[table])) fail("E_GRAPH_INTEGRITY", table);
  }
  if (binding.dataset_id === "seoul-world-graph"
      && GRAPH_TABLES.some((table, index) => rows[table].length !== INITIAL_COUNTS[index])) fail("E_GRAPH_INTEGRITY", "initial counts");
  if (sha(JSON.stringify(document)) !== binding.expected_document_sha256) fail("E_GRAPH_DIGEST", "document binding");
}

/** Install the fixed schema only. No caller SQL or source database is accepted. */
export function initializeGraphStore(db) {
  try { initializeStoreSchema(db, "janseon-graph-store.v1"); } catch (error) {
    if (error.code === "E_STORE_SCHEMA") fail("E_GRAPH_SCHEMA", error.message);
    throw error;
  }
}

/** The caller authenticates expectedBinding independently of document and sourceReceipt. */
export function importGraphEdition(db, options, schemaMode = "janseon-graph-store.v1") {
  exactRecord(options, ["document", "sourceReceipt", "expectedBinding"], "import options");
  const { document, sourceReceipt, expectedBinding: binding } = options;
  validateBinding(binding); validateReceipt(sourceReceipt, binding);
  inspect(document); validateReferences(document);
  const rows = documentRows(document, binding, sourceReceipt);
  validateRows(rows, document, binding, sourceReceipt);
  return transaction(db, () => {
    schemaBoundary(db, schemaMode);
    insertRow(db, "map_graph_binding", binding);
    // Root precedes the import receipt because both are scoped to this edition.
    for (const table of ["map_graph_root", ...GRAPH_TABLES.filter(table => table !== "map_graph_root")]) {
      for (const row of rows[table]) insertRow(db, table, row);
    }
    const graphSemanticSha256 = semanticDigest(graphSemanticProjection({ datasetId: binding.dataset_id, editionId: binding.edition_id, document }));
    insertRow(db, "map_graph_seal", { dataset_id: binding.dataset_id, edition_id: binding.edition_id, graph_semantic_sha256: graphSemanticSha256 });
    readGraphEdition(db, { datasetId: binding.dataset_id, editionId: binding.edition_id, expectedBinding: binding }, schemaMode);
    return { datasetId: binding.dataset_id, editionId: binding.edition_id, graphSemanticSha256 };
  });
}

/** SELECT-only typed read. No source file/archive fallback and no publication approval. */
export function readGraphEdition(db, options, schemaMode = "janseon-graph-store.v1") {
  exactRecord(options, ["datasetId", "editionId", "expectedBinding"], "read options");
  const { datasetId, editionId, expectedBinding: binding } = options;
  validateBinding(binding);
  if (datasetId !== binding.dataset_id || editionId !== binding.edition_id) fail("E_GRAPH_BINDING", "requested edition");
  schemaBoundary(db, schemaMode);
  const bindings = db.prepare("SELECT * FROM map_graph_binding WHERE dataset_id=? AND edition_id=?").all(datasetId, editionId);
  if (bindings.length !== 1 || canonicalEncode({ ...bindings[0] }) !== canonicalEncode(binding)) fail("E_GRAPH_BINDING", "stored binding");
  if (db.prepare("PRAGMA foreign_key_check").all().length
      || db.prepare("PRAGMA integrity_check").all().some(row => row.integrity_check !== "ok")) fail("E_GRAPH_INTEGRITY", "SQLite integrity");
  const rows = {};
  for (const table of GRAPH_TABLES) {
    const suffix = table.slice("map_graph_".length);
    const order = ["root", "import"].includes(suffix) ? "singleton"
      : suffix.startsWith("excluded_skipped_") ? "excluded_ordinal, skipped_ordinal, ordinal"
      : suffix.startsWith("excluded_") ? "excluded_ordinal, ordinal"
      : suffix.startsWith("replacement_") ? "replacement_ordinal, ordinal"
      : suffix.startsWith("hub_") ? "hub_ordinal, ordinal" : "ordinal";
    rows[table] = db.prepare("SELECT * FROM " + table + " WHERE dataset_id=? AND edition_id=? ORDER BY " + order).all(datasetId, editionId);
  }
  if (rows.map_graph_import.length !== 1) fail("E_GRAPH_INTEGRITY", "import receipt");
  const receipt = Object.fromEntries(RECEIPT_KEYS.map(key => [key, rows.map_graph_import[0][key]]));
  validateReceipt(receipt, binding);
  const document = readDocument(rows);
  validateRows(rows, document, binding, receipt);
  const graphSemanticSha256 = semanticDigest(graphSemanticProjection({ datasetId, editionId, document }));
  const seals = db.prepare("SELECT graph_semantic_sha256 FROM map_graph_seal WHERE dataset_id=? AND edition_id=?").all(datasetId, editionId);
  if (seals.length !== 1 || seals[0].graph_semantic_sha256 !== graphSemanticSha256) fail("E_GRAPH_INTEGRITY", "seal");
  return { datasetId, editionId, document, graphSemanticSha256 };
}

export function graphSemanticProjection({ datasetId, editionId, document }) {
  return {
    schema: "janseon-graph-semantic.v1", datasetId, editionId,
    document: { schema: document.schema, districts: document.districts,
      stations: document.stations, edges: document.edges,
      aliases: Object.entries(document.aliases), source: document.source },
  };
}

export function encodeGraphPayload(document) {
  return Buffer.from(JSON.stringify(document) + "\n", "utf8");
}
