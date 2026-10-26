import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { linkSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, inventory } from "./rollback-fixture.mjs";
import { rollbackPlan } from "./rollback-plan.mjs";
const cli = new URL("./rollback-apply.mjs", import.meta.url).pathname;
function prepare(t) {
  const f = fixture(t), plan = rollbackPlan({ store: f.store, target: f.entries[0].mapReleaseId, consumerStates: f.states });
  const planPath = join(f.root, "plan.json"); writeFileSync(planPath, JSON.stringify(plan));
  return { ...f, plan, planPath };
}
function run(f, preload = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ["--import", "data:text/javascript," + encodeURIComponent(preload)] : []), cli,
      "--plan", f.planPath, "--store", f.store, "--consumer-states", f.statesPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; }); child.once("error", reject);
    child.once("close", code => resolve({ code, result: JSON.parse(stdout || stderr) }));
  });
}
test("verified apply installs exactly planned bytes and leaves releases/register untouched", { timeout: 10000 }, async t => {
  const f = prepare(t), before = inventory(f.root), r = await run(f);
  assert.equal(r.code, 0); assert.equal(r.result.status, "REHEARSAL_APPLIED"); assert.equal(r.result.applied.length, 3);
  for (const surface of f.plan.surfaces) assert.equal(readFileSync(surface.steps[2].path, "utf8"), surface.steps[0].bytesUtf8);
  const paths = f.states.map(s => s.path.slice(f.root.length));
  assert.deepEqual(inventory(f.root).filter(([path]) => !paths.includes(path)), before.filter(([path]) => !paths.includes(path)));
});
test("injected second-rename failure restores the first swap and every file byte", { timeout: 10000 }, async t => {
  const f = prepare(t), before = inventory(f.root);
  const preload = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync; let count=0;
    fs.renameSync=function(...args){if(++count===2)throw Object.assign(new Error('injected'),{code:'EIO'});return original(...args)};
    syncBuiltinESMExports();`;
  const r = await run(f, preload); assert.equal(r.code, 2); assert.equal(r.result.code, "EIO"); assert.equal(r.result.restored, 1);
  assert.deepEqual(inventory(f.root), before);
});
for (const [operation, failAt] of [["unlinkSync", 1], ["unlinkSync", 2], ["rmdirSync", 2], ["rmdirSync", 3]]) {
  test(`${operation} cleanup failure ${failAt} respects precommit restoration or postcommit ownership`, { timeout: 10000 }, async t => {
    const f = prepare(t), before = inventory(f.root), entries = readdirSync(f.root, { recursive: true }).sort();
    const preload = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs[${JSON.stringify(operation)}]; let count=0;
      fs[${JSON.stringify(operation)}]=function(...args){
        if(++count===${failAt})throw Object.assign(new Error('one-shot cleanup EIO'),{code:'EIO'});
        return original(...args);
      };syncBuiltinESMExports();`;
    const r = await run(f, preload);
    if (operation === "rmdirSync") {
      assert.equal(r.code, 5); assert.equal(r.result.status, "COMMITTED_CLEANUP_REQUIRED");
      assert.equal(r.result.committed, true); assert.equal(r.result.restored, 0);
      for (const surface of f.plan.surfaces) assert.equal(readFileSync(surface.steps[2].path, "utf8"), surface.steps[0].bytesUtf8);
      const added = readdirSync(f.root, { recursive: true }).filter(p => !entries.includes(p)).sort();
      assert.deepEqual(added, r.result.remainingLocks.map(p => p.slice(f.root.length + 1)).sort());
      assert.equal(added.length, 5 - failAt);
      return;
    }
    assert.equal(r.code, 2); assert.equal(r.result.code, "EIO"); assert.equal(r.result.restored, 3);
    assert.deepEqual(inventory(f.root), before);
    assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), entries);
    for (const surface of f.plan.surfaces) assert.notEqual(readFileSync(surface.steps[2].path, "utf8"), surface.steps[0].bytesUtf8);
  });
}
test("writer subscribed to W unlock survives a later lock cleanup fault", { timeout: 10000 }, async t => {
  const f = prepare(t), w = f.states.find(s => s.surface === "W").path;
  const peerBytes = f.plan.surfaces.find(s => s.surface === "W").steps[0].bytesUtf8 + "\n";
  const peer = `import fs from 'node:fs';fs.mkdirSync(${JSON.stringify(w + ".rollback.lock")});
    try{fs.writeFileSync(${JSON.stringify(w)},${JSON.stringify(peerBytes)})}
    finally{fs.rmdirSync(${JSON.stringify(w + ".rollback.lock")})}`;
  const preload = `import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.rmdirSync;let count=0;let peerDone=false;
    fs.rmdirSync=function(path){
      if(++count===3){if(!peerDone)throw new Error('peer did not run');throw Object.assign(new Error('one-shot'),{code:'EIO'})}
      const result=original(path);
      if(path===${JSON.stringify(w + ".rollback.lock")}){
        const peer=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(peer)}],{encoding:'utf8',timeout:5000});
        if(peer.status!==0)throw new Error(peer.stderr);peerDone=true;
      }return result;
    };syncBuiltinESMExports();`;
  const r = await run(f, preload);
  assert.equal(r.code, 5); assert.equal(r.result.status, "COMMITTED_CLEANUP_REQUIRED"); assert.equal(r.result.committed, true); assert.equal(r.result.restored, 0);
  assert.equal(readFileSync(w, "utf8"), peerBytes);
  for (const surface of f.plan.surfaces.filter(s => s.surface !== "W")) assert.equal(readFileSync(surface.steps[2].path, "utf8"), surface.steps[0].bytesUtf8);
  const locks = readdirSync(f.root).filter(p => p.endsWith(".lock")).sort();
  assert.deepEqual(locks, ["G.json.rollback.lock", "M.json.rollback.lock"]);
  assert.deepEqual(r.result.remainingLocks.map(p => p.slice(f.root.length + 1)).sort(), locks);
  assert.ok(!readdirSync(f.root).some(p => p.startsWith(".rollback-")));
});
test("retained-file hardlink conflict aborts before any file mutation", { timeout: 10000 }, async t => {
  const f = prepare(t), member = join(f.entries[1].retentionPath, "game/world-graph.json");
  rmSync(f.states[1].path); linkSync(member, f.states[1].path);
  const before = inventory(f.root), r = await run(f); assert.equal(r.code, 4); assert.equal(r.result.code, "REFERENCED_FILE");
  assert.deepEqual(inventory(f.root), before);
});
test("stale before bytes reject without mutation", { timeout: 10000 }, async t => {
  const f = prepare(t); writeFileSync(f.states[2].path, "stale\n"); const before = inventory(f.root), r = await run(f);
  assert.equal(r.code, 3); assert.equal(r.result.code, "ROLLBACK_STALE"); assert.deepEqual(inventory(f.root), before);
});
test("tampered swap instructions reject despite valid target and current state", { timeout: 10000 }, async t => {
  const f = prepare(t); f.plan.surfaces[0].steps[2].expectedAfterSha256 = "0".repeat(64); writeFileSync(f.planPath, JSON.stringify(f.plan));
  const before = inventory(f.root), r = await run(f); assert.equal(r.code, 2); assert.equal(r.result.code, "PLAN_TAMPERED"); assert.deepEqual(inventory(f.root), before);
});
test("after-image verification failure restores all swapped destinations", { timeout: 10000 }, async t => {
  const f = prepare(t), before = inventory(f.root);
  const preload = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync; let injected=false;
    fs.renameSync=function(source,target){const result=original(source,target);if(!injected){injected=true;fs.writeFileSync(target,'corrupt after rename')}return result};
    syncBuiltinESMExports();`;
  const r = await run(f, preload); assert.equal(r.code, 2); assert.equal(r.result.code, "AFTER_DRIFT"); assert.equal(r.result.restored, 1); assert.deepEqual(inventory(f.root), before);
});
test("invalid chain and drifted target reject without touching supplied states", { timeout: 10000 }, async t => {
  const f = prepare(t); writeFileSync(join(f.entries[0].retentionPath, "wiki/map-core.json"), "drift\n");
  let before = inventory(f.root), r = await run(f); assert.equal(r.result.code, "RELEASE_MEMBER_DRIFT"); assert.deepEqual(inventory(f.root), before);
  writeFileSync(f.store, readFileSync(f.store, "utf8").replace(f.entries[0].sha256, "f".repeat(64)));
  before = inventory(f.root); r = await run(f); assert.equal(r.result.code, "RETENTION_CHAIN"); assert.deepEqual(inventory(f.root), before);
});
