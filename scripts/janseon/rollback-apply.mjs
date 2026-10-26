import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalEncode } from "./canonical.mjs";
import { rollbackPlan } from "./rollback-plan.mjs";
import { readRegister } from "./verify-release-retention.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = (code, path = null) => { throw Object.assign(new Error(code), { code, path }); };
const same = (a, b) => canonicalEncode(a) === canonicalEncode(b);
const absolute = path => { if (typeof path !== "string" || !isAbsolute(path)) fail("ABSOLUTE_PATH_REQUIRED"); return path; };

// Check paths and inode aliases, not merely duplicate content hashes: identical
// independent files are not references to the same filesystem object.
function protectReferences(entries, states, target) {
  for (const state of states) {
    const path = realpathSync(absolute(state.path)), stat = lstatSync(path);
    for (const entry of entries) {
      for (const member of entry.files) {
        const referenced = resolve(entry.retentionPath, member.path);
        const other = existsSync(referenced) ? lstatSync(referenced) : null;
        if (referenced === path || (other && stat.dev === other.dev && stat.ino === other.ino)) {
          fail(entry.mapReleaseId === target ? "RETAINED_TARGET_FILE" : "REFERENCED_FILE", path);
        }
      }
    }
  }
}

/** Cooperative local rehearsal transaction. No command-store or live activation. */
export function rollbackApply({ plan, store, consumerStates }) {
  absolute(store);
  if (!Array.isArray(consumerStates) || consumerStates.length !== 3) fail("CONSUMER_INPUT_REQUIRED");
  const locks = [], rows = [], owned = new Set(), swapped = [];
  const writeOwned = (path, bytes, mode) => {
    const fd = openSync(path, "wx", mode); owned.add(path);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  };
  const cleanupFiles = () => {
    for (const path of owned) { unlinkSync(path); owned.delete(path); }
  };
  const releaseLocks = () => {
    while (locks.length) { rmdirSync(locks.at(-1)); locks.pop(); }
  };
  const check = () => {
    protectReferences(readRegister(store), consumerStates, plan.targetReleaseId);
    const fresh = rollbackPlan({ store, target: plan.targetReleaseId, consumerStates });
    if (fresh.status !== "REHEARSAL_PLANNED" || !same(plan, fresh)) fail("PLAN_TAMPERED");
    return fresh;
  };
  check(); // All reference conflicts reject before even creating a lock.
  try {
    const lockPaths = [realpathSync(store) + ".lock", ...consumerStates.map(s => realpathSync(s.path) + ".rollback.lock")].sort();
    for (const path of lockPaths) { mkdirSync(path); locks.push(path); }
    const fresh = check();
    for (const surface of fresh.surfaces) {
      const [stage, compare, swap] = surface.steps;
      const before = readFileSync(compare.path), stat = lstatSync(compare.path), backup = stage.path + ".before";
      if (sha(before) !== compare.expectedBeforeSha256) fail("ROLLBACK_STALE", compare.path);
      if (existsSync(backup)) fail("ROLLBACK_STALE", backup);
      rows.push({ stage, compare, swap, before, mode: stat.mode & 0o777, backup });
    }
    // Prepare every rollback copy and after-image before the first rename.
    for (const row of rows) {
      writeOwned(row.backup, row.before, row.mode);
      if (sha(readFileSync(row.backup)) !== row.compare.expectedBeforeSha256) fail("BACKUP_DRIFT", row.backup);
      writeOwned(row.stage.path, row.stage.bytesUtf8, row.mode);
      if (sha(readFileSync(row.stage.path)) !== row.stage.expectedAfterSha256) fail("STAGE_DRIFT", row.stage.path);
    }
    if (sha(readFileSync(store)) !== fresh.preflight.registerSha256) fail("ROLLBACK_STALE", store);
    for (const row of rows) {
      if (sha(readFileSync(row.compare.path)) !== row.compare.expectedBeforeSha256) fail("ROLLBACK_STALE", row.compare.path);
      renameSync(row.stage.path, row.swap.path); owned.delete(row.stage.path); swapped.push(row);
      if (sha(readFileSync(row.swap.path)) !== row.swap.expectedAfterSha256) fail("AFTER_DRIFT", row.swap.path);
    }
    // Last rollback-capable operation. Every consumer lock is still held.
    cleanupFiles();
  } catch (error) {
    const failures = [];
    for (const row of swapped.reverse()) {
      try {
        if (!owned.has(row.backup)) writeOwned(row.backup, row.before, row.mode);
        renameSync(row.backup, row.swap.path); owned.delete(row.backup);
        if (sha(readFileSync(row.swap.path)) !== row.compare.expectedBeforeSha256) fail("RESTORE_DRIFT", row.swap.path);
      } catch (restore) { failures.push({ path: row.swap.path, code: restore.code ?? "RESTORE_FAILED", backup: row.backup }); }
    }
    // Preserve surviving backups only when restoration needs operator recovery.
    if (failures.length) for (const row of rows) owned.delete(row.backup);
    try { cleanupFiles(); releaseLocks(); }
    catch (cleanupError) {
      failures.push({ path: cleanupError.path ?? null, code: cleanupError.code ?? "CLEANUP_FAILED" });
    }
    if (failures.length) {
      throw Object.assign(new Error("ROLLBACK_RECOVERY_REQUIRED"), { code: "ROLLBACK_RECOVERY_REQUIRED", failures, causeCode: error.code });
    }
    throw Object.assign(error, { restored: swapped.length });
  }
  // Commit precedes the first unlock. A peer may own a released destination;
  // never restore or reacquire it after crossing this boundary.
  const result = { schema: "janseon-rollback-apply.v1", status: "REHEARSAL_APPLIED", committed: true, restored: 0,
    targetReleaseId: plan.targetReleaseId,
    applied: rows.map(row => ({ path: row.swap.path, beforeSha256: row.compare.expectedBeforeSha256, afterSha256: row.swap.expectedAfterSha256 })),
    authorityTransition: "NOT_IMPLEMENTED", liveConsumersActivated: false };
  try { releaseLocks(); }
  catch (error) {
    return { ...result, status: "COMMITTED_CLEANUP_REQUIRED", code: error.code ?? "CLEANUP_FAILED", remainingLocks: [...locks] };
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), flags = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!["--plan", "--store", "--consumer-states"].includes(args[i]) || flags.has(args[i]) || !args[i + 1]) fail("USAGE");
      flags.set(args[i], absolute(args[i + 1]));
    }
    if (flags.size !== 3) fail("USAGE");
    const plan = JSON.parse(readFileSync(flags.get("--plan"), "utf8")), consumerStates = JSON.parse(readFileSync(flags.get("--consumer-states"), "utf8"));
    // Inputs themselves must not be replacement destinations.
    const inputs = [...flags.values()].map(p => realpathSync(p));
    if (consumerStates.some(s => inputs.includes(realpathSync(s.path)))) fail("INPUT_PATH_COLLISION");
    const result = rollbackApply({ plan, store: flags.get("--store"), consumerStates });
    console.log(canonicalEncode(result));
    process.exitCode = result.status === "COMMITTED_CLEANUP_REQUIRED" ? 5 : 0;
  } catch (error) {
    console.error(JSON.stringify({ schema: "janseon-rollback-apply.v1", status: "REJECTED", code: error.code ?? "INVALID_INPUT",
      path: error.path ?? null, restored: error.restored ?? 0, failures: error.failures ?? [] }));
    process.exitCode = error.code === "ROLLBACK_STALE" ? 3 : error.code === "REFERENCED_FILE" ? 4 : 2;
  }
}
