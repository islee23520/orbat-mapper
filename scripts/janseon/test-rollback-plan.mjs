import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createReleaseManifest } from "./release-manifest.mjs";
import { registerRelease } from "./verify-release-retention.mjs";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
const cli = new URL("./rollback-plan.mjs", import.meta.url).pathname;
const sha = value => createHash("sha256").update(value).digest("hex"), h = sha("synthetic");
function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/rollback-plan-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, "retention.jsonl"), statesPath = join(root, "states.json"), entries = [];
  for (const version of ["previous", "current"]) {
    const directory = join(root, version), ref = domain => ({ domain, datasetId: "synthetic:dataset", editionId: version });
    const receipt = { contentId: "synthetic-receipt", sha256: h };
    const specs = [["wiki/map-core.json", "map-core", ["graph"]], ["wiki/observed-geography.json", "observed-geography", ["observed-geography"]],
      ["wiki/spatial-assignments.json", "spatial-assignments", ["initial-state"]], ["wiki/station-bindings.json", "station-bindings", ["graph"]],
      ["wiki/underground-geometry.json", "underground-geometry", ["graph"]], ["game/world-graph.json", "world-graph", ["graph"]],
      ["game/map-topology.json", "map-topology", ["observed-geography"]], ["game/initial-world.json", "initial-world", ["graph", "initial-state"]],
      ["game/terrain-manifest.json", "terrain-manifest", ["observed-geography"]]].sort(([a], [b]) => a < b ? -1 : 1);
    const members = specs.map(([path, kind, roles]) => {
      const bytes = Buffer.from(JSON.stringify({ synthetic: path, version }) + "\n"); mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), bytes);
      return { path, kind, target: path.split("/")[0], sizeBytes: bytes.length, rawSha256: sha(bytes), visibility: "public",
        license: { id: "synthetic", textSha256: h }, identitySnapshotSha256: h, editionRefs: roles.map(ref) };
    });
    const semantic = { schema: "janseon-map-release-semantic.v1", projectionContract: "janseon-map-release-projection.v1", mapSemanticSha256: h, identitySnapshotSha256: h,
      editions: ["graph", "initial-state", "observed-geography"].map(domain => ({ ...ref(domain), semanticSha256: h })),
      domains: { graph: { semanticSha256: h, editionRefs: [ref("graph")] }, geometry: { semanticSha256: h, editionRefs: [ref("observed-geography")] }, initialState: { semanticSha256: h, editionRefs: [ref("initial-state")] } },
      targets: ["wiki", "game"], targetAllowlists: Object.fromEntries(["wiki", "game"].map(target => [target, members.filter(m => m.target === target).map(m => m.path)])), members };
    const context = { expectedTargets: ["wiki", "game"], budget: { schema: "janseon-map-release-budget.v1", migrationReceipt: receipt,
      members: members.map(m => ({ path: m.path, maxBytes: 10000 })), maxTotalBytes: 100000 } };
    const provenance = { sourceCommit: "1".repeat(40), snapshot: { contentId: "synthetic-snapshot", databaseSha256: h, mapSemanticSha256: h }, exporter: { revision: "2".repeat(40), version: "synthetic" },
      identityReceipt: receipt, sourceReceipts: semantic.editions.map(e => ({ editionRef: ref(e.domain), receipt })), approvalReceipts: [{ memberPaths: members.map(m => m.path), receipt }],
      budgetReceipt: { contentId: "synthetic-budget", sha256: semanticDigest(context.budget) }, memberLocations: members.map(m => ({ path: m.path, storage: "git", contentId: null })),
      ledger: { datasetId: "synthetic:dataset", sequence: entries.length, generationId: sha(version), editionId: version, mapSemanticSha256: h, contextSha256: h, commandLogSha256: h } };
    writeFileSync(join(directory, "release-manifest.json"), canonicalEncode(createReleaseManifest({ semantic, provenance }, context)) + "\n");
    writeFileSync(join(directory, "source-receipt.json"), '{"synthetic":true}\n'); entries.push(registerRelease(directory, context, store).entry);
  }
  const current = entries[1], states = ["M", "W", "G"].map(surface => {
    const path = join(root, surface + ".json"), bytes = JSON.stringify({ schema: "janseon-rollback-rehearsal-binding.v1", surface,
      mapReleaseId: current.mapReleaseId, deliveryReceiptId: current.deliveryReceiptId, ledger: current.ledger, retentionPath: current.retentionPath }) + "\n";
    writeFileSync(path, bytes); return { surface, path, expectedBeforeSha256: sha(bytes), currentReleaseId: current.mapReleaseId };
  });
  writeFileSync(statesPath, JSON.stringify(states)); return { root, store, statesPath, states, entries };
}
function inventory(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
    const path = join(e.parentPath, e.name); return [path.slice(root.length), sha(readFileSync(path))];
  }).sort(([a], [b]) => a < b ? -1 : 1);
}
function run(f, target = f.entries[0].mapReleaseId, withStates = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--store", f.store, "--target", target, ...(withStates ? ["--consumer-states", f.statesPath] : [])], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; }); child.once("error", reject);
    child.once("close", code => resolve({ code, result: JSON.parse(code === 0 ? stdout : stderr) }));
  });
}
test("three explicit surfaces plan exact atomic file hashes without modifying any bytes", { timeout: 10000 }, async t => {
  const f = fixture(t), before = inventory(f.root), a = await run(f), b = await run(f);
  assert.equal(a.code, 0); assert.deepEqual(a, b); assert.deepEqual(inventory(f.root), before);
  assert.equal(a.result.status, "REHEARSAL_PLANNED"); assert.equal(a.result.executable, false);
  assert.equal(a.result.authorityTransition.requiresNewCurrentGeneration, true); assert.equal(a.result.authorityTransition.replaceCommandStore, false);
  for (const [i, surface] of a.result.surfaces.entries()) {
    assert.equal(surface.currentBinding.mapReleaseId, f.entries[1].mapReleaseId); assert.equal(surface.targetBinding.mapReleaseId, f.entries[0].mapReleaseId);
    assert.equal(surface.steps[1].expectedBeforeSha256, f.states[i].expectedBeforeSha256);
    assert.equal(surface.steps[2].path, f.states[i].path); assert.equal(dirname(surface.steps[2].sourcePath), dirname(surface.steps[2].path));
    assert.equal(sha(surface.steps[0].bytesUtf8), surface.steps[2].expectedAfterSha256);
    assert.equal(JSON.parse(surface.steps[0].bytesUtf8).mapReleaseId, f.entries[0].mapReleaseId);
  }
});
test("latest selects last registration and absent consumer inputs stay explicitly unbound", { timeout: 10000 }, async t => {
  const f = fixture(t), r = await run(f, "latest", false); assert.equal(r.code, 0); assert.equal(r.result.targetReleaseId, f.entries[1].mapReleaseId);
  assert.equal(r.result.status, "CONSUMER_INPUT_REQUIRED"); assert.ok(r.result.surfaces.every(s => s.currentBinding === null && s.steps.length === 0));
});
test("changed current bytes or mismatched registered binding rejects ROLLBACK_STALE", { timeout: 10000 }, async t => {
  const f = fixture(t); writeFileSync(f.states[1].path, "changed\n"); const before = inventory(f.root), r = await run(f);
  assert.equal(r.code, 3); assert.equal(r.result.code, "ROLLBACK_STALE"); assert.equal(r.result.path, f.states[1].path); assert.deepEqual(inventory(f.root), before);
  const wrongBinding = JSON.stringify({ schema: "janseon-rollback-rehearsal-binding.v1", surface: "W", mapReleaseId: f.entries[0].mapReleaseId,
    deliveryReceiptId: f.entries[0].deliveryReceiptId, ledger: f.entries[0].ledger, retentionPath: f.entries[0].retentionPath });
  writeFileSync(f.states[1].path, wrongBinding); f.states[1].expectedBeforeSha256 = sha(wrongBinding); writeFileSync(f.statesPath, JSON.stringify(f.states));
  const invalid = await run(f); assert.equal(invalid.code, 3); assert.equal(invalid.result.code, "ROLLBACK_STALE");
});
test("unknown target and invalid chain reject before planning", { timeout: 10000 }, async t => {
  const f = fixture(t); const missing = await run(f, "f".repeat(64)); assert.equal(missing.code, 2); assert.equal(missing.result.code, "ROLLBACK_TARGET_MISSING");
  const entries = readFileSync(f.store, "utf8").trimEnd().split("\n"); const entry = JSON.parse(entries[0]); entry.timestamp = "2020-01-01T00:00:00.000Z";
  entries[0] = JSON.stringify(entry); writeFileSync(f.store, entries.join("\n") + "\n"); const before = inventory(f.root), invalid = await run(f);
  assert.equal(invalid.code, 2); assert.equal(invalid.result.code, "RETENTION_CHAIN"); assert.deepEqual(inventory(f.root), before);
});
test("missing or drifted target release cannot produce a plan", { timeout: 10000 }, async t => {
  const f = fixture(t), member = join(f.entries[0].retentionPath, "game/world-graph.json"); writeFileSync(member, "drift\n");
  const drift = await run(f); assert.equal(drift.code, 2); assert.equal(drift.result.code, "RELEASE_MEMBER_DRIFT");
  rmSync(f.entries[0].retentionPath, { recursive: true }); assert.equal((await run(f)).code, 2);
});
