import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, command, station } from "./command-store-fixture.mjs";
import { acceptCommandPackage, readCommandEdition } from "./command-store.mjs";
const cli = new URL("./apply-map-commands.mjs", import.meta.url).pathname;
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", code => resolve({ code, stdout, stderr, record: JSON.parse(code === 0 ? stdout : stderr) }));
});
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "command-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clone = fixture(t, join(directory, "clone.sqlite")), authority = fixture(t, join(directory, "authority.sqlite"));
  const bindingPath = join(directory, "binding.json"); writeFileSync(bindingPath, JSON.stringify(clone.binding));
  const json = (name, value) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value)); return path; };
  return { clone, authority, directory, bindingPath, json, authorityPath: join(directory, "authority.sqlite"), clonePath: join(directory, "clone.sqlite") };
}
async function exported(f, name = "package.json") {
  const packagePath = join(f.directory, name);
  const request = f.json("export-" + name, { schema: "janseon-command-export-request.v1", cloneStore: f.clonePath, bindingPath: f.bindingPath, outputPath: packagePath });
  const result = await run(["export", "--request", request]);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.record.status, "EXPORTED");
  return f.json("apply-" + name, { schema: "janseon-command-apply-request.v1", bindingPath: f.bindingPath, packagePath });
}
test("child CLI exports clone history and deterministically accepts then idempotently reapplies to explicit authority", { timeout: 20000 }, async t => {
  const f = setup(t);
  acceptCommandPackage(f.clone.db, command(f.clone.db, f.clone.binding, "first"));
  acceptCommandPackage(f.clone.db, command(f.clone.db, f.clone.binding, "second", station("é")));
  const request = await exported(f);
  const applied = await run(["apply", "--request", request, "--authoritative-store", f.authorityPath]);
  assert.equal(applied.code, 0, applied.stderr); assert.deepEqual(applied.record.commands.map(r => r.replayed), [false, false]);
  assert.deepEqual(readCommandEdition(f.authority.db, f.authority.binding), readCommandEdition(f.clone.db, f.clone.binding));
  const repeated = await run(["apply", "--request", request, "--authoritative-store", f.authorityPath]);
  assert.equal(repeated.code, 0, repeated.stderr); assert.deepEqual(repeated.record.commands.map(r => r.replayed), [true, true]);
  assert.equal(f.authority.db.prepare("SELECT count(*) n FROM map_command_log").get().n, 2);
  const missingAuthority = await run(["apply", "--request", request]);
  assert.equal(missingAuthority.code, 2); assert.equal(missingAuthority.record.code, "USAGE");
});
test("stale clone exits STALE_BASE with rebuild instruction and preserves authority", { timeout: 20000 }, async t => {
  const f = setup(t);
  acceptCommandPackage(f.clone.db, command(f.clone.db, f.clone.binding, "clone-change"));
  const request = await exported(f);
  acceptCommandPackage(f.authority.db, command(f.authority.db, f.authority.binding, "accepted-main", station("é")));
  const before = readCommandEdition(f.authority.db, f.authority.binding);
  const result = await run(["apply", "--request", request, "--authoritative-store", f.authorityPath]);
  assert.equal(result.code, 3); assert.equal(result.record.code, "STALE_BASE"); assert.match(result.record.instruction, /rebuild and re-review/u);
  assert.deepEqual(readCommandEdition(f.authority.db, f.authority.binding), before);
});
test("writer lock rejects immediately through child CLI without a partial acceptance", { timeout: 20000 }, async t => {
  const f = setup(t); acceptCommandPackage(f.clone.db, command(f.clone.db, f.clone.binding, "first"));
  const request = await exported(f);
  // The real writer lock is acquired before spawning the competing process.
  f.authority.db.exec("BEGIN IMMEDIATE");
  try {
    const result = await run(["apply", "--request", request, "--authoritative-store", f.authorityPath]);
    assert.equal(result.code, 4); assert.equal(result.record.code, "WRITER_LOCKED");
    assert.equal(f.authority.db.prepare("SELECT count(*) n FROM map_command_log").get().n, 0);
  } finally { f.authority.db.exec("ROLLBACK"); }
});
test("tampered transport and package-supplied write target reject without authority changes", { timeout: 20000 }, async t => {
  const f = setup(t); acceptCommandPackage(f.clone.db, command(f.clone.db, f.clone.binding, "first"));
  const requestPath = await exported(f), request = JSON.parse(readFileSync(requestPath));
  const transport = JSON.parse(readFileSync(request.packagePath)); transport.log.commands[0].commandPackage.operationId = "tampered";
  writeFileSync(request.packagePath, JSON.stringify(transport));
  const result = await run(["apply", "--request", requestPath, "--authoritative-store", f.authorityPath]);
  assert.equal(result.code, 2); assert.equal(result.record.code, "PACKAGE_TAMPERED");
  const injected = f.json("injected.json", { ...request, cloneStore: f.clonePath });
  const rejected = await run(["apply", "--request", injected, "--authoritative-store", f.authorityPath]);
  assert.equal(rejected.code, 2); assert.equal(rejected.record.code, "INVALID_REQUEST");
  assert.equal(f.authority.db.prepare("SELECT count(*) n FROM map_command_log").get().n, 0);
});
