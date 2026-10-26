import { canonicalEncode, semanticDigest } from "./canonical.mjs";

const SCHEMA = "janseon-map-release.v1";
const TARGETS = ["wiki", "game"];
const GEOMETRY = ["observed-geography", "legacy-atlas", "physical-rail", "station-bindings", "terrain", "roads", "buildings"];
const DOMAINS = ["graph", "initial-state", ...GEOMETRY];
const FIXED = [
  ["wiki/map-core.json", "map-core", "graph"],
  ["wiki/observed-geography.json", "observed-geography", "observed-geography"],
  ["wiki/spatial-assignments.json", "spatial-assignments", "initial-state"],
  ["wiki/station-bindings.json", "station-bindings", "graph"],
  ["wiki/underground-geometry.json", "underground-geometry", "graph"],
  ["game/world-graph.json", "world-graph", "graph"],
  ["game/map-topology.json", "map-topology", "observed-geography"],
  ["game/initial-world.json", "initial-world", "initial-state"],
  ["game/terrain-manifest.json", "terrain-manifest", null],
];
const EXTRA = ["terrain", "roads", "buildings"];
const KINDS = [...FIXED.map(([, kind]) => kind), ...EXTRA];
const fail = (code, detail) => { throw Object.assign(new Error(`${code}: ${detail}`), { code }); };
const shape = (valid, detail) => { if (!valid) fail("E_RELEASE_SHAPE", detail); };
const reference = (valid, detail) => { if (!valid) fail("E_RELEASE_REFERENCE", detail); };
const budgetCheck = (valid, detail) => { if (!valid) fail("E_RELEASE_BUDGET", detail); };

function exact(value, keys) {
  shape(value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "exact keys");
}

function text(value) {
  shape(typeof value === "string" && value.isWellFormed() && value.trim().length > 0
    && !/[\x00-\x1f\x7f]/u.test(value), "text");
}

function opaque(value) {
  text(value);
  shape(![".", ".."].includes(value) && !/[\\/%]/u.test(value) && !/^[A-Za-z]:/u.test(value), "opaque content id");
}

function hash(value) { shape(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "SHA-256"); }
function commit(value) { shape(typeof value === "string" && /^[a-f0-9]{40}$/u.test(value), "commit"); }
function choice(value, values) { shape(values.includes(value), "supported literal"); }
function positive(value) { shape(Number.isSafeInteger(value) && value > 0, "positive safe integer"); }
function list(value, inspect) { shape(Array.isArray(value), "array"); value.forEach(inspect); }
function receipt(value) { exact(value, ["contentId", "sha256"]); opaque(value.contentId); hash(value.sha256); }
function edition(value, digest = false) {
  exact(value, ["domain", "datasetId", "editionId", ...(digest ? ["semanticSha256"] : [])]);
  choice(value.domain, DOMAINS); text(value.datasetId); text(value.editionId);
  if (digest) hash(value.semanticSha256);
}
const tuple = value => [value.domain, value.datasetId, value.editionId];
const editionKey = value => JSON.stringify(tuple(value));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function tupleCompare(a, b) {
  for (let index = 0; index < a.length; index++) {
    const result = compare(a[index], b[index]);
    if (result) return result;
  }
  return 0;
}
function sorted(values, select = value => [value]) {
  reference(values.every((value, index) => index === 0 || tupleCompare(select(values[index - 1]), select(value)) < 0), "sorted unique inventory");
}
function coverage(actual, expected) {
  const values = new Set(actual);
  reference(values.size === actual.length && values.size === expected.length && expected.every(value => values.has(value)), "inventory coverage");
}

// All representation and shape checks precede lexical paths, references, budgets
// and digests. No property getter is read before the canonical data guard.
function inspect(input, context, complete) {
  try { canonicalEncode(input); canonicalEncode(context); }
  catch (error) {
    if (error instanceof TypeError) fail("E_RELEASE_SHAPE", "plain canonical data required");
    throw error;
  }
  exact(input, complete ? ["schema", "mapReleaseId", "deliveryReceiptId", "semantic", "provenance"] : ["semantic", "provenance"]);
  if (complete) { choice(input.schema, [SCHEMA]); hash(input.mapReleaseId); hash(input.deliveryReceiptId); }
  exact(context, ["expectedTargets", "budget"]);
  const { semantic: s, provenance: p } = input, { budget: b } = context;
  const paths = [];
  const path = value => { shape(typeof value === "string", "member path string"); paths.push(value); };
  const refs = values => list(values, value => edition(value));
  exact(s, ["schema", "projectionContract", "mapSemanticSha256", "identitySnapshotSha256", "editions", "domains", "targets", "targetAllowlists", "members"]);
  choice(s.schema, ["janseon-map-release-semantic.v1"]);
  choice(s.projectionContract, ["janseon-map-release-projection.v1"]);
  hash(s.mapSemanticSha256); hash(s.identitySnapshotSha256);
  list(s.editions, value => edition(value, true));
  exact(s.domains, ["graph", "geometry", "initialState"]);
  for (const domain of Object.values(s.domains)) {
    exact(domain, ["semanticSha256", "editionRefs"]); hash(domain.semanticSha256); refs(domain.editionRefs);
  }
  list(s.targets, value => choice(value, TARGETS));
  list(context.expectedTargets, value => choice(value, TARGETS));
  exact(s.targetAllowlists, TARGETS);
  for (const target of TARGETS) list(s.targetAllowlists[target], path);
  list(s.members, member => {
    exact(member, ["path", "target", "kind", "sizeBytes", "rawSha256", "visibility", "license", "identitySnapshotSha256", "editionRefs"]);
    path(member.path); choice(member.target, TARGETS); choice(member.kind, KINDS);
    positive(member.sizeBytes); hash(member.rawSha256); choice(member.visibility, ["public", "protected"]);
    exact(member.license, ["id", "textSha256"]); text(member.license.id); hash(member.license.textSha256);
    hash(member.identitySnapshotSha256); refs(member.editionRefs);
  });
  exact(p, ["sourceCommit", "snapshot", "exporter", "identityReceipt", "sourceReceipts", "approvalReceipts", "budgetReceipt", "memberLocations", ...(Object.hasOwn(p, "ledger") ? ["ledger"] : [])]);
  if (Object.hasOwn(p, "ledger")) {
    exact(p.ledger, ["datasetId", "sequence", "generationId", "editionId", "mapSemanticSha256", "contextSha256", "commandLogSha256"]);
    text(p.ledger.datasetId); text(p.ledger.editionId);
    shape(Number.isSafeInteger(p.ledger.sequence) && p.ledger.sequence >= 0, "ledger sequence");
    for (const key of ["generationId", "mapSemanticSha256", "contextSha256", "commandLogSha256"]) hash(p.ledger[key]);
    reference(s.editions.some(e => e.domain === "initial-state" && e.datasetId === p.ledger.datasetId && e.editionId === p.ledger.editionId), "ledger edition");
  }
  commit(p.sourceCommit);
  exact(p.snapshot, ["contentId", "databaseSha256", "mapSemanticSha256"]);
  opaque(p.snapshot.contentId); hash(p.snapshot.databaseSha256); hash(p.snapshot.mapSemanticSha256);
  exact(p.exporter, ["revision", "version"]); commit(p.exporter.revision); text(p.exporter.version);
  receipt(p.identityReceipt); receipt(p.budgetReceipt);
  list(p.sourceReceipts, value => { exact(value, ["editionRef", "receipt"]); edition(value.editionRef); receipt(value.receipt); });
  list(p.approvalReceipts, value => { exact(value, ["memberPaths", "receipt"]); list(value.memberPaths, path); receipt(value.receipt); });
  list(p.memberLocations, value => {
    exact(value, ["path", "storage", "contentId"]); path(value.path);
    choice(value.storage, ["git", "git-lfs", "protected-content"]);
    if (value.storage === "protected-content") opaque(value.contentId);
    else shape(value.contentId === null, "Git location content id must be null");
  });
  exact(b, ["schema", "migrationReceipt", "members", "maxTotalBytes"]);
  choice(b.schema, ["janseon-map-release-budget.v1"]); receipt(b.migrationReceipt); positive(b.maxTotalBytes);
  list(b.members, value => { exact(value, ["path", "maxBytes"]); path(value.path); positive(value.maxBytes); });

  for (const value of paths) {
    if (value === "release-manifest.json" || !value.split("/").every(segment =>
      /^[a-z0-9][a-z0-9._-]*$/u.test(segment) && !segment.endsWith(".")
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/u.test(segment))) {
      fail("E_RELEASE_PATH", "portable release-relative member path required");
    }
  }

  for (const targets of [s.targets, context.expectedTargets]) {
    reference(targets.length === 2 && targets[0] === "wiki" && targets[1] === "game", "complete ordered targets");
  }
  reference(p.snapshot.mapSemanticSha256 === s.mapSemanticSha256, "snapshot semantic identity");
  reference(s.editions.length > 0, "editions required"); sorted(s.editions, tuple);
  reference(new Set(s.editions.map(value => JSON.stringify([value.domain, value.datasetId]))).size === s.editions.length, "one edition per domain/dataset");
  const editions = new Map(s.editions.map(value => [editionKey(value), value]));
  function resolving(values) {
    reference(values.length > 0, "edition references required"); sorted(values, tuple);
    for (const value of values) reference(editions.has(editionKey(value)), "unresolved edition");
  }
  for (const [name, domain] of Object.entries(s.domains)) {
    resolving(domain.editionRefs);
    const allowed = name === "geometry" ? GEOMETRY : [name === "graph" ? "graph" : "initial-state"];
    reference(domain.editionRefs.every(value => allowed.includes(value.domain)), "domain reference role");
  }
  reference(s.domains.geometry.editionRefs.some(value => value.domain === "observed-geography"), "observed geography required");
  if (s.domains.graph.editionRefs.length === 1) {
    reference(s.domains.graph.semanticSha256 === editions.get(editionKey(s.domains.graph.editionRefs[0])).semanticSha256, "single graph digest");
  }
  coverage(Object.values(s.domains).flatMap(domain => domain.editionRefs.map(editionKey)), [...editions.keys()]);
  sorted(s.members, member => [member.path]);
  const memberPaths = s.members.map(member => member.path);
  reference(FIXED.every(([required]) => memberPaths.includes(required)), "missing required member");
  const usedEditions = new Set();
  for (const member of s.members) {
    reference(member.path.startsWith(member.target + "/"), "member target prefix");
    reference(member.identitySnapshotSha256 === s.identitySnapshotSha256, "member identity snapshot");
    reference(member.target !== "wiki" || member.visibility === "public", "wiki visibility");
    resolving(member.editionRefs);
    member.editionRefs.forEach(value => usedEditions.add(editionKey(value)));
    const fixed = FIXED.find(([name]) => name === member.path);
    const extra = EXTRA.find(kind => member.path.startsWith(`game/${kind}/`));
    reference(Boolean(fixed || extra), "member allowlist");
    reference(member.kind === (fixed ? fixed[1] : extra), "member kind/path");
    const role = fixed ? fixed[2] : extra;
    reference(member.editionRefs.some(value => role ? value.domain === role : GEOMETRY.includes(value.domain)), "member reference role");
    const keys = member.editionRefs.map(editionKey);
    if (member.kind === "world-graph") coverage(keys, s.domains.graph.editionRefs.map(editionKey));
    if (member.kind === "initial-world") {
      reference([...s.domains.graph.editionRefs, ...s.domains.initialState.editionRefs].every(value => keys.includes(editionKey(value))), "initial world graph/state coverage");
    }
  }
  coverage([...usedEditions], [...editions.keys()]);
  for (const target of TARGETS) {
    sorted(s.targetAllowlists[target]);
    coverage(s.targetAllowlists[target], s.members.filter(member => member.target === target).map(member => member.path));
  }
  sorted(p.sourceReceipts, value => tuple(value.editionRef));
  coverage(p.sourceReceipts.map(value => editionKey(value.editionRef)), [...editions.keys()]);
  for (const approval of p.approvalReceipts) {
    reference(approval.memberPaths.length > 0, "approval coverage required"); sorted(approval.memberPaths);
  }
  sorted(p.approvalReceipts, value => [value.memberPaths[0]]);
  coverage(p.approvalReceipts.flatMap(value => value.memberPaths), memberPaths);
  sorted(p.memberLocations, value => [value.path]); coverage(p.memberLocations.map(value => value.path), memberPaths);
  p.memberLocations.forEach((location, index) => {
    reference(s.members[index].visibility !== "protected" || location.storage === "protected-content", "protected storage lane");
  });
  sorted(b.members, value => [value.path]); coverage(b.members.map(value => value.path), memberPaths);

  budgetCheck(p.budgetReceipt.sha256 === semanticDigest(b), "independent budget binding");
  let total = 0;
  s.members.forEach((member, index) => {
    total += member.sizeBytes;
    budgetCheck(Number.isSafeInteger(total), "size sum overflow");
    budgetCheck(member.sizeBytes <= b.members[index].maxBytes, "member maximum");
  });
  budgetCheck(total <= b.maxTotalBytes, "total maximum");
}

/** Structural identity only. Caller independently authenticates budget/source/rights. */
export function createReleaseManifest(input, context) {
  inspect(input, context, false);
  // Validated JSON data only: no hooks, unsafe numbers or prototype-bearing values.
  const { semantic, provenance } = JSON.parse(canonicalEncode(input));
  const manifest = { schema: SCHEMA, mapReleaseId: semanticDigest(semantic), semantic, provenance };
  return { ...manifest, deliveryReceiptId: semanticDigest(manifest) };
}

/** Does not parse raw JSON, read payload bytes, verify sources or grant admission. */
export function validateReleaseManifest(manifest, context) {
  inspect(manifest, context, true);
  const { schema, semantic, provenance, mapReleaseId, deliveryReceiptId } = manifest;
  if (mapReleaseId !== semanticDigest(semantic)
    || deliveryReceiptId !== semanticDigest({ schema, mapReleaseId, semantic, provenance })) {
    fail("E_RELEASE_DIGEST", "manifest identity mismatch");
  }
  return { mapReleaseId, deliveryReceiptId };
}
