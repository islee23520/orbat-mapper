import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, command } from "./command-store-fixture.mjs";
import { acceptCommandPackage, readCommandReleaseSource, exportCommandLog, prepareCommandLog } from "./command-store.mjs";
import { semanticDigest } from "./canonical.mjs";
import { buildMapRelease } from "./build-map-release.mjs";
const cli = new URL("./build-checkpoint-release.mjs", import.meta.url).pathname;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function setup(t) {
  const directory = mkdtempSync("/tmp/checkpoint-release-"); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "authority.sqlite"), f = fixture(t, databasePath);
  acceptCommandPackage(f.db, command(f.db, f.binding, "accepted-before-release"));
  const source = readCommandReleaseSource(f.db, f.binding), ref = (domain, value) => ({ domain, datasetId: value.datasetId, editionId: value.editionId });
  const sourceRows = [{ editionRef: ref("graph", source.central.graph), rowsSha256: semanticDigest(source.central.graph.document) },
    { editionRef: ref("initial-state", source.authored), rowsSha256: semanticDigest(source.authored) },
    { editionRef: ref("observed-geography", source.central.observedGeography), rowsSha256: semanticDigest(source.central.observedGeography.rows) }];
  const paths = ["game/initial-world.json", "game/map-topology.json", "game/terrain-manifest.json", "game/world-graph.json", "wiki/map-core.json", "wiki/observed-geography.json", "wiki/spatial-assignments.json", "wiki/station-bindings.json", "wiki/underground-geometry.json"];
  const receipt = { contentId: "synthetic-receipt", sha256: "a".repeat(64) };
  const budget = { schema: "janseon-map-release-budget.v1", migrationReceipt: receipt, members: paths.map(path => ({ path, maxBytes: 1000000 })), maxTotalBytes: 9000000 };
  const request = { schema: "janseon-checkpoint-release-request.v1", binding: f.binding, sourceRows,
    context: { expectedTargets: ["wiki", "game"], budget }, license: { id: "synthetic", textSha256: "b".repeat(64) },
    provenance: { sourceCommit: "1".repeat(40), snapshot: { contentId: "synthetic-checkpoint", databaseSha256: sha(readFileSync(databasePath)),
      mapSemanticSha256: semanticDigest({ schema: "janseon-release-map.v1", central: source.central.centralSemanticSha256, authored: source.authored.semanticSha256 }) },
      exporter: { revision: "2".repeat(40), version: "synthetic-builder-v1" }, identityReceipt: receipt,
      sourceReceipts: sourceRows.map(row => ({ editionRef: row.editionRef, receipt: { contentId: row.editionRef.domain, sha256: row.rowsSha256 } })),
      approvalReceipts: [{ memberPaths: paths, receipt }], budgetReceipt: { contentId: "synthetic-budget", sha256: semanticDigest(budget) },
      memberLocations: paths.map(path => ({ path, storage: "git", contentId: null })) } };
  const requestPath = join(directory, "request.json"); writeFileSync(requestPath, JSON.stringify(request));
  return { ...f, directory, databasePath, requestPath, request };
}
function run(f, name, nodeArgs = []) {
  const output = join(f.directory, name);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, cli, "--request", f.requestPath, "--authoritative-store", f.databasePath, "--output-dir", output], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject); child.once("close", code => resolve({ code, output, record: JSON.parse(code === 0 ? stdout : stderr), stderr }));
  });
}
test("quiescent child builds complete identical releases and binds P to the actual accepted ledger", { timeout: 20000 }, async t => {
  const f = setup(t), before = sha(readFileSync(f.databasePath));
  const a = await run(f, "first"), b = await run(f, "second");
  assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  const files = readdirSync(a.output, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(a.output.length + 1)).sort();
  assert.equal(files.length, 11);
  for (const path of files) assert.deepEqual(readFileSync(join(a.output, path)), readFileSync(join(b.output, path)));
  const manifest = JSON.parse(readFileSync(join(a.output, "release-manifest.json")));
  const head = f.db.prepare("SELECT * FROM map_command_head").get();
  assert.deepEqual(manifest.provenance.ledger, { datasetId: f.binding.context.authored.datasetId, sequence: 1,
    generationId: head.generation_id, editionId: head.edition_id, mapSemanticSha256: head.map_semantic_sha256,
    contextSha256: head.context_sha256, commandLogSha256: semanticDigest(exportCommandLog(f.db, f.binding)) });
  assert.equal(a.record.deliveryReceiptId, manifest.deliveryReceiptId); assert.equal(a.record.mapReleaseId, b.record.mapReleaseId);
  assert.equal(sha(readFileSync(f.databasePath)), before);
  const forged = { ...f.request, databasePath: f.databasePath, provenance: structuredClone(manifest.provenance) };
  forged.provenance.ledger.sequence = 2;
  assert.throws(() => buildMapRelease(forged), { code: "E_BUILD_LEDGER_BINDING" });
});
test("held writer reservation refuses child build with no output or ledger mutation", { timeout: 20000 }, async t => {
  const f = setup(t); f.db.exec("BEGIN IMMEDIATE");
  try { const result = await run(f, "locked"); assert.equal(result.code, 4); assert.equal(result.record.code, "WRITER_LOCKED"); assert.equal(existsSync(result.output), false); }
  finally { f.db.exec("ROLLBACK"); }
  assert.equal(f.db.prepare("SELECT count(*) n FROM map_command_log").get().n, 1);
});
test("real competing CLI writer during first payload write is refused and built head equals final authority", { timeout: 20000 }, async t => {
  const f = setup(t), pending = command(f.db, f.binding, "competing-during-output");
  const log = prepareCommandLog(f.db, pending);
  const bindingPath = join(f.directory, "binding.json"), packagePath = join(f.directory, "package.json"), applyPath = join(f.directory, "apply.json"), probePath = join(f.directory, "probe.json");
  writeFileSync(bindingPath, JSON.stringify(f.binding));
  writeFileSync(packagePath, JSON.stringify({ schema: "janseon-command-transport.v1", log, sha256: semanticDigest(log) }));
  writeFileSync(applyPath, JSON.stringify({ schema: "janseon-command-apply-request.v1", bindingPath, packagePath }));
  const preload = `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {spawnSync} from 'node:child_process';
    const original=fs.writeFileSync; let probed=false;
    fs.writeFileSync=function(path,...args){
      const result=original.call(this,path,...args);
      if(!probed && String(path).endsWith('/game/initial-world.json')){
        probed=true;
        const child=spawnSync(process.execPath,${JSON.stringify([new URL("./apply-map-commands.mjs", import.meta.url).pathname, "apply", "--request", applyPath, "--authoritative-store", f.databasePath])},{encoding:'utf8',timeout:10000});
        original(${JSON.stringify(probePath)},JSON.stringify({status:child.status,stderr:child.stderr,stdout:child.stdout}));
      }
      return result;
    };syncBuiltinESMExports();`;
  const result = await run(f, "contended", ["--import", "data:text/javascript," + encodeURIComponent(preload)]);
  assert.equal(result.code, 0, result.stderr);
  const probe = JSON.parse(readFileSync(probePath));
  assert.equal(probe.status, 4); assert.equal(JSON.parse(probe.stderr).code, "WRITER_LOCKED");
  const head = f.db.prepare("SELECT * FROM map_command_head").get();
  assert.equal(head.sequence, 1); assert.equal(result.record.ledger.sequence, head.sequence);
  assert.equal(result.record.ledger.generationId, head.generation_id);
  assert.equal(JSON.parse(readFileSync(join(result.output, "release-manifest.json"))).provenance.ledger.sequence, head.sequence);
});
test("a committed log row beyond the materialized head refuses as unapplied", { timeout: 20000 }, async t => {
  const f = setup(t), next = command(f.db, f.binding, "unapplied");
  // Simulate a partial external import using the real insert guard, not disabled triggers.
  const head = f.db.prepare("SELECT * FROM map_command_head").get();
  f.db.prepare("INSERT INTO map_command_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(head.dataset_id, 2, "unapplied", semanticDigest(next.commandPackage), head.generation_id, head.edition_id, "d".repeat(64), "unapplied-edition", "e".repeat(64), head.context_sha256, JSON.stringify(next.commandPackage), JSON.stringify(next.review));
  const result = await run(f, "unapplied"); assert.equal(result.code, 2); assert.equal(result.record.code, "E_RELEASE_UNAPPLIED_COMMANDS"); assert.equal(existsSync(result.output), false);
  assert.equal(f.db.prepare("SELECT sequence FROM map_command_head").get().sequence, 1);
});
test("WAL authority and caller-forged ledger provenance refuse without output", { timeout: 20000 }, async t => {
  const f = setup(t); f.db.exec("PRAGMA journal_mode=WAL");
  const wal = await run(f, "wal"); assert.equal(wal.record.code, "E_BUILD_CHECKPOINT_REQUIRED"); assert.equal(existsSync(wal.output), false);
  f.db.exec("PRAGMA journal_mode=DELETE"); f.request.provenance.ledger = {};
  writeFileSync(f.requestPath, JSON.stringify(f.request));
  const forged = await run(f, "forged"); assert.equal(forged.record.code, "INVALID_REQUEST"); assert.equal(existsSync(forged.output), false);
});
