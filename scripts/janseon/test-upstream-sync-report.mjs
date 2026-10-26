import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const cli = new URL("./report-upstream-sync.mjs", import.meta.url).pathname;
function fixture(t) {
  const repository = mkdtempSync("/tmp/upstream-sync-"); t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Synthetic Test"); git("config", "user.email", "synthetic@example.invalid");
  const write = (path, text) => { mkdirSync(join(repository, path, ".."), { recursive: true }); writeFileSync(join(repository, path), text); };
  const commit = label => { git("add", "--", "."); git("commit", "-m", label); return git("rev-parse", "HEAD"); };
  write("same.txt", "same\n"); write("upstream.txt", "base\n"); write("conflict.txt", "base\n"); write("fork-only.txt", "base\n");
  const base = commit("synthetic base");
  git("switch", "-c", "upstream"); write("upstream.txt", "new upstream\n"); write("conflict.txt", "upstream edit\n"); write("new-upstream.txt", "new\n");
  const upstream = commit("synthetic upstream");
  git("switch", "main");
  write("docs/janseon/ownership.md", "Synthetic field ownership, not a path policy.\n");
  write("schemas/janseon/field-disposition.json", JSON.stringify({ schema: "janseon-field-disposition.v1", authorityCutover: false, source: { orbatBaseline: base } }));
  write("fork-only.txt", "fork customization\n");
  const fork = commit("synthetic fork");
  return { repository, git, write, commit, base, upstream, fork };
}
function run(f, upstream = f.upstream, base = f.base, fork = f.fork) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--repository", f.repository, "--base", base, "--upstream", upstream, "--fork", fork], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject); child.once("close", code => resolve({ code, report: JSON.parse(code === 2 ? stderr : stdout) }));
  });
}
test("local child report separates upstream-only, identical and preserved fork-only paths", { timeout: 10000 }, async t => {
  const f = fixture(t), before = f.git("status", "--porcelain"), result = await run(f);
  assert.equal(result.code, 0); assert.equal(result.report.status, "SYNC_CLEAR");
  assert.equal(result.report.base, f.base); assert.equal(result.report.upstream, f.upstream); assert.equal(result.report.fork, f.fork);
  assert.deepEqual(result.report.upstreamOnlyChanges.map(r => r.path), ["conflict.txt", "new-upstream.txt", "upstream.txt"]);
  assert.deepEqual(result.report.cleanIdentical.map(r => r.path), ["same.txt"]);
  assert.ok(result.report.forkOnlyChanges.some(r => r.path === "fork-only.txt"));
  assert.deepEqual(result.report.forkModifiedConflicts, []);
  assert.equal(f.git("status", "--porcelain"), before); assert.equal(f.git("rev-parse", "HEAD"), f.fork);
  assert.deepEqual(await run(f), result);
});
test("both-side modifications conflict with exact paths and nonzero machine status", { timeout: 10000 }, async t => {
  const f = fixture(t); f.write("conflict.txt", "fork edit\n"); f.fork = f.commit("fork modification");
  const result = await run(f); assert.equal(result.code, 3); assert.equal(result.report.status, "SYNC_CONFLICT");
  assert.deepEqual(result.report.forkModifiedConflicts.map(r => r.path), ["conflict.txt"]);
  assert.notEqual(result.report.forkModifiedConflicts[0].upstream, result.report.forkModifiedConflicts[0].fork);
});
test("identical convergence is clean and deletions remain explicit", { timeout: 10000 }, async t => {
  const f = fixture(t); f.write("conflict.txt", "upstream edit\n"); rmSync(join(f.repository, "fork-only.txt")); f.fork = f.commit("convergent fork and deletion");
  const result = await run(f); assert.equal(result.code, 0);
  assert.ok(result.report.cleanIdentical.some(r => r.path === "conflict.txt"));
  assert.equal(result.report.forkOnlyChanges.find(r => r.path === "fork-only.txt").fork, null);
});
test("ownership baseline mismatch and unknown local refs reject without fetching", { timeout: 10000 }, async t => {
  const f = fixture(t); f.write("schemas/janseon/field-disposition.json", JSON.stringify({ schema: "janseon-field-disposition.v1", source: { orbatBaseline: "0".repeat(40) } })); f.fork = f.commit("bad baseline");
  const mismatch = await run(f); assert.equal(mismatch.code, 2); assert.equal(mismatch.report.code, "OWNERSHIP_BASE_MISMATCH");
  const unknown = await run(f, "nonexistent-local-ref"); assert.equal(unknown.code, 2);
});
