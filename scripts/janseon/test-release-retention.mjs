import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { createReleaseManifest } from "./release-manifest.mjs";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
const cli = new URL("./verify-release-retention.mjs", import.meta.url).pathname;
const hash = value => createHash("sha256").update(value).digest("hex"), h = hash("synthetic");
function fixture(t) {
  const root = mkdtempSync("/tmp/release-retention-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "release"), store = join(root, "retention.jsonl"), contextPath = join(root, "context.json");
  const ref = domain => ({ domain, datasetId: "synthetic:dataset", editionId: "synthetic:edition" });
  const receipt = { contentId: "synthetic-receipt", sha256: h };
  const specs = [["wiki/map-core.json", "map-core", ["graph"]], ["wiki/observed-geography.json", "observed-geography", ["observed-geography"]],
    ["wiki/spatial-assignments.json", "spatial-assignments", ["initial-state"]], ["wiki/station-bindings.json", "station-bindings", ["graph"]],
    ["wiki/underground-geometry.json", "underground-geometry", ["graph"]], ["game/world-graph.json", "world-graph", ["graph"]],
    ["game/map-topology.json", "map-topology", ["observed-geography"]], ["game/initial-world.json", "initial-world", ["graph", "initial-state"]],
    ["game/terrain-manifest.json", "terrain-manifest", ["observed-geography"]]].sort(([a], [b]) => a < b ? -1 : 1);
  const members = specs.map(([path, kind, roles]) => {
    const bytes = Buffer.from(JSON.stringify({ synthetic: path }) + "\n"); mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), bytes);
    return { path, kind, target: path.split("/")[0], sizeBytes: bytes.length, rawSha256: hash(bytes), visibility: "public",
      license: { id: "synthetic", textSha256: h }, identitySnapshotSha256: h, editionRefs: roles.map(ref) };
  });
  const semantic = { schema: "janseon-map-release-semantic.v1", projectionContract: "janseon-map-release-projection.v1", mapSemanticSha256: h, identitySnapshotSha256: h,
    editions: ["graph", "initial-state", "observed-geography"].map(domain => ({ ...ref(domain), semanticSha256: h })),
    domains: { graph: { semanticSha256: h, editionRefs: [ref("graph")] }, geometry: { semanticSha256: h, editionRefs: [ref("observed-geography")] }, initialState: { semanticSha256: h, editionRefs: [ref("initial-state")] } },
    targets: ["wiki", "game"], targetAllowlists: Object.fromEntries(["wiki", "game"].map(target => [target, members.filter(m => m.target === target).map(m => m.path)])), members };
  const context = { expectedTargets: ["wiki", "game"], budget: { schema: "janseon-map-release-budget.v1", migrationReceipt: receipt,
    members: members.map(m => ({ path: m.path, maxBytes: 10000 })), maxTotalBytes: 100000 } };
  const ledger = { datasetId: "synthetic:dataset", sequence: 0, generationId: h, editionId: "synthetic:edition", mapSemanticSha256: h, contextSha256: h, commandLogSha256: h };
  const provenance = { sourceCommit: "1".repeat(40), snapshot: { contentId: "synthetic-snapshot", databaseSha256: h, mapSemanticSha256: h },
    exporter: { revision: "2".repeat(40), version: "synthetic" }, identityReceipt: receipt,
    sourceReceipts: semantic.editions.map(e => ({ editionRef: ref(e.domain), receipt })), approvalReceipts: [{ memberPaths: members.map(m => m.path), receipt }],
    budgetReceipt: { contentId: "synthetic-budget", sha256: semanticDigest(context.budget) }, memberLocations: members.map(m => ({ path: m.path, storage: "git", contentId: null })), ledger };
  const manifest = createReleaseManifest({ semantic, provenance }, context);
  writeFileSync(join(directory, "release-manifest.json"), canonicalEncode(manifest) + "\n");
  writeFileSync(join(directory, "source-receipt.json"), '{"synthetic":true}\n'); writeFileSync(contextPath, JSON.stringify(context));
  return { root, directory, store, contextPath, manifest, context };
}
function run(f, command) {
  const args = command === "verify-retention" ? ["--store", f.store] : ["--release-dir", f.directory, "--context", f.contextPath, ...(command === "register" ? ["--store", f.store] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, command, ...args], { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; }); child.once("error", reject);
    child.once("close", code => resolve({ code, result: JSON.parse(code === 2 ? stderr : stdout) }));
  });
}
test("release R/P verify, registration is byte-idempotent and retention verifies", { timeout: 10000 }, async t => {
  const f = fixture(t), v = await run(f, "verify-release"); assert.equal(v.code, 0); assert.equal(v.result.mapReleaseId, f.manifest.mapReleaseId); assert.equal(v.result.deliveryReceiptId, f.manifest.deliveryReceiptId);
  const a = await run(f, "register"); assert.equal(a.code, 0); assert.equal(a.result.status, "REGISTERED");
  assert.deepEqual(a.result.entry.ledger, f.manifest.provenance.ledger);
  const before = readFileSync(f.store), b = await run(f, "register"); assert.equal(b.result.status, "ALREADY_REGISTERED"); assert.deepEqual(readFileSync(f.store), before);
  const verified = await run(f, "verify-retention"); assert.equal(verified.code, 0); assert.equal(verified.result.count, 1);
  const { sha256, ...body } = a.result.entry; assert.equal(sha256, hash(canonicalEncode(body)));
});
test("drifted payload and missing members reject standalone and retention reports drift", { timeout: 10000 }, async t => {
  const f = fixture(t); await run(f, "register"); const path = join(f.directory, "wiki/map-core.json"); writeFileSync(path, "drift\n");
  const v = await run(f, "verify-release"); assert.equal(v.code, 2); assert.equal(v.result.code, "RELEASE_MEMBER_DRIFT");
  const r = await run(f, "verify-retention"); assert.equal(r.code, 3); assert.equal(r.result.failures[0].status, "DRIFTED");
  rmSync(path); assert.equal((await run(f, "verify-release")).result.code, "RELEASE_MEMBERS");
});
test("missing release is reported and does not erase the register", { timeout: 10000 }, async t => {
  const f = fixture(t); await run(f, "register"); const before = readFileSync(f.store); rmSync(f.directory, { recursive: true });
  const r = await run(f, "verify-retention"); assert.equal(r.code, 3); assert.equal(r.result.failures[0].status, "MISSING"); assert.deepEqual(readFileSync(f.store), before);
});
test("changed record and partial append reject before registration can modify the store", { timeout: 10000 }, async t => {
  const f = fixture(t); await run(f, "register"); const original = readFileSync(f.store, "utf8"), entry = JSON.parse(original); entry.retentionPath += "-tampered";
  writeFileSync(f.store, JSON.stringify(entry) + "\n"); const before = readFileSync(f.store);
  assert.equal((await run(f, "verify-retention")).result.code, "RETENTION_CHAIN"); assert.equal((await run(f, "register")).code, 2); assert.deepEqual(readFileSync(f.store), before);
  writeFileSync(f.store, original.slice(0, -1)); assert.equal((await run(f, "verify-retention")).result.code, "RETENTION_CHAIN");
});
test("P corruption, auxiliary byte drift, symlinks and missing register reject", { timeout: 10000 }, async t => {
  const f = fixture(t); assert.equal((await run(f, "verify-retention")).result.code, "RETENTION_STORE_MISSING");
  await run(f, "register"); writeFileSync(join(f.directory, "source-receipt.json"), "changed\n"); assert.equal((await run(f, "verify-retention")).code, 3);
  const manifestPath = join(f.directory, "release-manifest.json"); f.manifest.provenance.sourceCommit = "3".repeat(40); writeFileSync(manifestPath, JSON.stringify(f.manifest));
  assert.equal((await run(f, "verify-release")).result.code, "E_RELEASE_DIGEST"); rmSync(manifestPath); symlinkSync(f.contextPath, manifestPath);
  assert.equal((await run(f, "verify-release")).result.code, "RELEASE_SYMLINK");
});
test("two different accepted R values append a chain; reordered records fail", { timeout: 10000 }, async t => {
  const f = fixture(t), g = fixture(t); g.store = f.store;
  g.manifest.semantic.identitySnapshotSha256 = "b".repeat(64); g.manifest.semantic.members.forEach(m => { m.identitySnapshotSha256 = "b".repeat(64); });
  const next = createReleaseManifest({ semantic: g.manifest.semantic, provenance: g.manifest.provenance }, g.context);
  writeFileSync(join(g.directory, "release-manifest.json"), JSON.stringify(next));
  const a = await run(f, "register"), b = await run(g, "register"); assert.equal(a.code, 0); assert.equal(b.code, 0);
  assert.equal(b.result.entry.previousSha256, a.result.entry.sha256); assert.equal(b.result.entry.sequence, 2);
  assert.equal((await run(f, "verify-retention")).result.count, 2);
  writeFileSync(f.store, readFileSync(f.store, "utf8").trimEnd().split("\n").reverse().join("\n") + "\n");
  assert.equal((await run(f, "verify-retention")).result.code, "RETENTION_CHAIN");
});
