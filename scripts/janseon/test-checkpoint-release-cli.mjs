import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, command } from "./command-store-fixture.mjs";
import { acceptCommandPackage, readCommandReleaseSource, exportCommandLog, prepareCommandLog, withCommandReleaseCheckpoint } from "./command-store.mjs";
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
    const child = spawn(process.execPath, [...nodeArgs, f.cli ?? cli, "--request", f.requestPath, "--authoritative-store", f.databasePath, "--output-dir", output, ...(f.repository ? ["--require-main", f.repository] : [])], { stdio: ["ignore", "pipe", "pipe"] });
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

function mainFixture(t) {
  const f = setup(t), repository = join(f.directory, "repository"), runtime = join(f.directory, "runtime");
  mkdirSync(repository);
  const git = (args, input) => execFileSync("git", ["-C", repository, ...args], { input, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } }).trim();
  git(["init", "--initial-branch=main"]);
  git(["remote", "add", "origin", "https://github.com/islee23520/orbat-mapper.git"]);
  const tree = git(["mktree"], ""), base = git(["commit-tree", tree], "base\n");
  const commit = parent => git(["commit-tree", tree, "-p", parent], "accepted\n");
  const main = commit(base); git(["update-ref", "refs/heads/main", main]);
  cpSync(new URL("./", import.meta.url), runtime, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // Only the disposable runtime has fixture trust enrollment. Shipped registry stays empty.
  writeFileSync(join(runtime, "trusted-main-recorders.json"), JSON.stringify({ fixture: publicKey.export({ type: "spki", format: "pem" }) }));
  const keyPath = join(f.directory, "key.pem"), bindingPath = join(f.directory, "binding.json"), acceptancePath = join(f.directory, "acceptance.json");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(bindingPath, JSON.stringify(f.binding));
  const ledger = withCommandReleaseCheckpoint(f.db, f.binding, value => value);
  const acceptance = { schema: "janseon-main-acceptance-request.v1", recorder: "fixture", baseMain: base, mainCommit: main, previousReceipt: null, ledger };
  const record = (nodeArgs = []) => {
    writeFileSync(acceptancePath, JSON.stringify(acceptance));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...nodeArgs, join(runtime, "record-main-acceptance.mjs"), "--request", acceptancePath,
        "--binding", bindingPath, "--repository", repository, "--authoritative-store", f.databasePath, "--signing-key", keyPath]);
      let out = "", err = "";
      child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { err += b; });
      child.once("error", reject); child.once("close", code => resolve({ code, result: JSON.parse(code === 0 ? out : err) }));
    });
  };
  return { ...f, repository, cli: join(runtime, "build-checkpoint-release.mjs"), runtime, git, commit, main, base, ledger, acceptance, record };
}

test("trusted recorder binds local post-main tuple and actual checkpoint; caller sourceCommit is not proof", { timeout: 20000 }, async t => {
  const f = mainFixture(t), recorded = await f.record();
  assert.equal(recorded.code, 0);
  const built = await run(f, "main-release");
  assert.equal(built.code, 0, built.stderr);
  assert.equal(built.record.mainAcceptance.receiptObject, recorded.result.receiptObject);
  assert.equal(built.record.mainAcceptance.mainCommit, f.main);
  assert.equal(built.record.mainAcceptance.ledgerSha256, semanticDigest(f.ledger));
  assert.notEqual(f.request.provenance.sourceCommit, f.main);
  assert.deepEqual(JSON.parse(readFileSync(join(built.output, "main-acceptance.json"))), built.record.mainAcceptance);
  assert.equal(f.db.prepare("SELECT sequence FROM map_command_head").get().sequence, 1);
});

for (const fault of ["commit", "tuple", "merge-order", "recorder"]) test(`recorder rejects mismatched ${fault} without acceptance ref`, { timeout: 20000 }, async t => {
  const f = mainFixture(t);
  if (fault === "commit") f.acceptance.mainCommit = f.base;
  if (fault === "tuple") f.acceptance.ledger.sequence++;
  if (fault === "merge-order") f.acceptance.baseMain = f.main;
  if (fault === "recorder") f.acceptance.recorder = "caller";
  const result = await f.record();
  assert.equal(result.code, 2);
  assert.equal(result.result.code, { commit: "MAIN_COMMIT_MISMATCH", tuple: "MAIN_TUPLE_MISMATCH", "merge-order": "MAIN_MERGE_ORDER", recorder: "MAIN_RECORDER_UNTRUSTED" }[fault]);
  assert.equal(f.git(["for-each-ref", "--format=%(objectname)", "refs/janseon/main-acceptance"]), "");
});

test("receipt CAS rejects a second clone candidate on the same base", { timeout: 20000 }, async t => {
  const f = mainFixture(t);
  const first = await f.record(); assert.equal(first.code, 0);
  const second = await f.record(); assert.equal(second.result.code, "MAIN_RECEIPT_STALE");
  assert.equal(f.git(["rev-parse", "refs/janseon/main-acceptance"]), first.result.receiptObject);
});

for (const change of ["main", "tuple"]) test(`checkpoint rejects stale accepted ${change} without output`, { timeout: 20000 }, async t => {
  const f = mainFixture(t); assert.equal((await f.record()).code, 0);
  if (change === "main") f.git(["update-ref", "refs/heads/main", f.commit(f.main)]);
  else acceptCommandPackage(f.db, command(f.db, f.binding, "after-recording"));
  const result = await run(f, "stale");
  assert.equal(result.code, 2);
  assert.equal(result.record.code, change === "main" ? "MAIN_RECEIPT_STALE" : "MAIN_TUPLE_MISMATCH");
  assert.equal(existsSync(result.output), false);
});

for (const fault of ["missing", "unsigned", "untrusted", "tampered"]) test(`real checkpoint rejects ${fault} receipt, never trusting sourceCommit`, { timeout: 20000 }, async t => {
  const f = mainFixture(t);
  if (fault !== "missing") {
    const recorded = await f.record(); assert.equal(recorded.code, 0);
    const receipt = JSON.parse(f.git(["cat-file", "blob", recorded.result.receiptObject]));
    if (fault === "unsigned") delete receipt.signature;
    if (fault === "untrusted") receipt.payload.recorder = "caller";
    if (fault === "tampered") receipt.payload.ledger.sequence++;
    const oid = f.git(["hash-object", "-w", "--stdin"], JSON.stringify(receipt));
    f.git(["update-ref", "refs/janseon/main-acceptance", oid]);
  }
  f.request.provenance.sourceCommit = f.main; writeFileSync(f.requestPath, JSON.stringify(f.request));
  const result = await run(f, "forgery");
  assert.equal(result.code, 2);
  assert.equal(result.record.code, { missing: "MAIN_RECEIPT_MISSING", unsigned: "MAIN_RECEIPT_INVALID", untrusted: "MAIN_RECORDER_UNTRUSTED", tampered: "MAIN_SIGNATURE_INVALID" }[fault]);
  assert.equal(existsSync(result.output), false);
});

test("live command writer excludes recorder and later changed tuple rejects its old request", { timeout: 20000 }, async t => {
  const f = mainFixture(t);
  f.db.exec("BEGIN IMMEDIATE");
  try { assert.equal((await f.record()).result.code, "WRITER_LOCKED"); }
  finally { f.db.exec("ROLLBACK"); }
  acceptCommandPackage(f.db, command(f.db, f.binding, "changed-before-recording"));
  assert.equal((await f.record()).result.code, "MAIN_TUPLE_MISMATCH");
});

for (const target of ["main", "receipt"]) test(`Git transaction rejects ${target} movement between verification and CAS`, { timeout: 20000 }, async t => {
  const f = mainFixture(t), next = f.commit(f.main);
  const blob = f.git(["hash-object", "-w", "--stdin"], "unsigned competitor\n");
  const preload = `
    import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const original=cp.spawnSync; let changed=false;
    cp.spawnSync=function(exe,args,options){
      if(!changed && exe==='git' && args.includes('--stdin') && args.includes('update-ref')){
        changed=true;
        const result=original('git',['-C',${JSON.stringify(f.repository)},'update-ref',
          ${JSON.stringify(target === "main" ? "refs/heads/main" : "refs/janseon/main-acceptance")},
          ${JSON.stringify(target === "main" ? next : blob)}],{encoding:'utf8'});
        if(result.status!==0) throw Error(result.stderr);
      }
      return original.call(this,exe,args,options);
    };syncBuiltinESMExports();`;
  const result = await f.record(["--import", "data:text/javascript," + encodeURIComponent(preload)]);
  assert.equal(result.code, 2); assert.equal(result.result.code, "MAIN_GIT_CONFLICT");
  assert.equal(f.git(["for-each-ref", "--format=%(objectname)", "refs/janseon/main-acceptance"]), target === "main" ? "" : blob);
});

test("next accepted tuple must follow the signed previous main and receipt", { timeout: 20000 }, async t => {
  const f = mainFixture(t), first = await f.record(); assert.equal(first.code, 0);
  acceptCommandPackage(f.db, command(f.db, f.binding, "next-main"));
  f.acceptance.ledger = withCommandReleaseCheckpoint(f.db, f.binding, value => value);
  f.acceptance.previousReceipt = first.result.receiptObject;
  f.acceptance.baseMain = f.main;
  f.acceptance.mainCommit = f.commit(f.main);
  f.git(["update-ref", "refs/heads/main", f.acceptance.mainCommit]);
  const next = await f.record(); assert.equal(next.code, 0);
  assert.equal(f.git(["rev-parse", "refs/janseon/main-acceptance"]), next.result.receiptObject);
  const envelope = JSON.parse(f.git(["cat-file", "blob", next.result.receiptObject]));
  assert.equal(envelope.payload.previousReceipt, first.result.receiptObject);
  assert.equal(envelope.payload.ledger.sequence, 2);
});
