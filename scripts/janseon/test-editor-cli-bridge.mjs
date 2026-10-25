import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fixture, command, station } from "./command-store-fixture.mjs";
import { acceptCommandPackage } from "./command-store.mjs";
import { createEditorCliBridge } from "./editor-cli-bridge.mjs";
test("real bridge packages readonly then passes accept stale lock and tamper to merged CLI", { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "editor-bridge-test-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clonePath = join(directory, "clone.sqlite"), authorityPath = join(directory, "authority.sqlite");
  const clone = fixture(t, clonePath), authority = fixture(t, authorityPath);
  const bindingPath = join(directory, "binding.json"), reviewPath = join(directory, "review.json");
  writeFileSync(bindingPath, JSON.stringify(clone.binding));
  const first = command(clone.db, clone.binding, "previewed-op"); writeFileSync(reviewPath, JSON.stringify(first.review));
  const token = "synthetic-token-".repeat(4), origin = "http://127.0.0.1:5178";
  const server = createEditorCliBridge({ token, origin, cloneStore: clonePath, authoritativeStore: authorityPath, bindingPath, reviewPath });
  const listening = once(server, "listening"); server.listen(0, "127.0.0.1"); await listening;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, bearer = token) => (await fetch(url + path, { method: "POST", headers: { Origin: origin, Authorization: "Bearer " + bearer }, body: JSON.stringify(body) })).json();
  assert.equal((await post("/package", { commandPackage: first.commandPackage }, "wrong")).code, "BRIDGE_TOKEN");
  const pkg = await post("/package", { commandPackage: first.commandPackage }); assert.equal(pkg.exitCode, 0);
  assert.equal(clone.db.prepare("SELECT count(*) n FROM map_command_log").get().n, 0);
  authority.db.exec("BEGIN IMMEDIATE");
  try { const locked = await post("/apply", { transport: pkg.transport, authoritativeStore: authorityPath }); assert.equal(locked.result.code, "WRITER_LOCKED"); }
  finally { authority.db.exec("ROLLBACK"); }
  const accepted = await post("/apply", { transport: pkg.transport, authoritativeStore: authorityPath }); assert.equal(accepted.result.status, "ACCEPTED");
  const second = command(clone.db, clone.binding, "stale-op", station("é")); writeFileSync(reviewPath, JSON.stringify(second.review));
  const stalePkg = await post("/package", { commandPackage: second.commandPackage }); assert.equal(stalePkg.exitCode, 0);
  const stale = await post("/apply", { transport: stalePkg.transport, authoritativeStore: authorityPath }); assert.equal(stale.result.code, "STALE_BASE");
  const tampered = structuredClone(pkg.transport); tampered.sha256 = "f".repeat(64);
  assert.equal((await post("/apply", { transport: tampered, authoritativeStore: authorityPath })).result.code, "PACKAGE_TAMPERED");
  assert.equal((await post("/apply", { transport: pkg.transport, authoritativeStore: clonePath })).result.code, "BRIDGE_AUTHORITY");
  const unreviewed = command(clone.db, clone.binding, "unreviewed");
  assert.equal((await post("/package", { commandPackage: unreviewed.commandPackage })).result.code, "E_COMMAND_REVIEW");
  assert.equal(authority.db.prepare("SELECT count(*) n FROM map_command_log").get().n, 1);
});
