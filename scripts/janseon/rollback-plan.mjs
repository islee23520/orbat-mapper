import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalEncode } from "./canonical.mjs";
import { readRegister, verifyRelease } from "./verify-release-retention.mjs";

const fail = (code, path = null) => { throw Object.assign(new Error(code), { code, path }); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => canonicalEncode(a) === canonicalEncode(b);
const absolute = path => { if (typeof path !== "string" || !isAbsolute(path)) fail("ABSOLUTE_PATH_REQUIRED"); return path; };
const exact = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !same(Object.keys(value).sort(), [...keys].sort())) fail("INVALID_CONSUMER_STATE");
};
const binding = (surface, entry) => ({ schema: "janseon-rollback-rehearsal-binding.v1", surface,
  mapReleaseId: entry.mapReleaseId, deliveryReceiptId: entry.deliveryReceiptId, ledger: entry.ledger, retentionPath: entry.retentionPath });

/** Plans operator-owned rehearsal files, never command heads or live consumers. */
export function rollbackPlan({ store, target, consumerStates = [] }) {
  absolute(store);
  const registerBytes = readFileSync(store), entries = readRegister(store);
  if (!Buffer.from(registerBytes).equals(readFileSync(store))) fail("ROLLBACK_STALE", store);
  const selected = target === "latest" ? entries.at(-1) : entries.find(e => e.mapReleaseId === target);
  if (!selected) fail("ROLLBACK_TARGET_MISSING");
  const verified = verifyRelease(selected.retentionPath, selected.context);
  if (!same(verified, { mapReleaseId: selected.mapReleaseId, deliveryReceiptId: selected.deliveryReceiptId, ledger: selected.ledger, files: selected.files })) fail("ROLLBACK_TARGET_DRIFT");
  if (!Array.isArray(consumerStates)) fail("INVALID_CONSUMER_STATE");
  const inputs = new Map(), paths = new Set();
  for (const state of consumerStates) {
    exact(state, ["surface", "path", "expectedBeforeSha256", "currentReleaseId"]);
    if (!["M", "W", "G"].includes(state.surface) || inputs.has(state.surface)
      || !/^[a-f0-9]{64}$/u.test(state.expectedBeforeSha256)) fail("INVALID_CONSUMER_STATE");
    absolute(state.path);
    if (!existsSync(state.path)) fail("ROLLBACK_STALE", state.path);
    if (!lstatSync(state.path).isFile() || lstatSync(state.path).isSymbolicLink()) fail("INVALID_CONSUMER_STATE");
    const path = realpathSync(state.path);
    if (paths.has(path) || path === realpathSync(store) || entries.some(e => path === e.retentionPath || path.startsWith(e.retentionPath + sep))) fail("INVALID_CONSUMER_STATE");
    paths.add(path);
    const before = readFileSync(path), beforeSha256 = sha(before);
    if (beforeSha256 !== state.expectedBeforeSha256) fail("ROLLBACK_STALE", path);
    const current = entries.find(e => e.mapReleaseId === state.currentReleaseId);
    if (!current || !same(JSON.parse(before), binding(state.surface, current))) fail("ROLLBACK_STALE", path);
    inputs.set(state.surface, { path, current, beforeSha256 });
  }
  const surfaces = ["M", "W", "G"].map(surface => {
    const input = inputs.get(surface), targetBinding = binding(surface, selected);
    if (!input) return { surface, status: "CONSUMER_INPUT_REQUIRED", currentBinding: null, targetBinding, steps: [] };
    const afterBytes = canonicalEncode(targetBinding) + "\n", afterSha256 = sha(afterBytes);
    const stagePath = join(dirname(input.path), `.rollback-${surface}-${afterSha256}.tmp`);
    if (paths.has(stagePath)) fail("INVALID_CONSUMER_STATE", stagePath);
    if (existsSync(stagePath)) fail("ROLLBACK_STALE", stagePath);
    return { surface, status: "PLANNED", currentBinding: binding(surface, input.current), targetBinding,
      steps: [
        { operation: "stage-exclusive-sibling", path: stagePath, expectedBeforeSha256: null, expectedAfterSha256: afterSha256, bytesUtf8: afterBytes },
        { operation: "compare-before-under-exclusive-consumer-lock", path: input.path, expectedBeforeSha256: input.beforeSha256, expectedAfterSha256: input.beforeSha256 },
        { operation: "atomic-rename-under-same-lock", sourcePath: stagePath, path: input.path, expectedBeforeSha256: input.beforeSha256, expectedAfterSha256: afterSha256 },
        { operation: "verify-after-before-unlock", path: input.path, expectedBeforeSha256: afterSha256, expectedAfterSha256: afterSha256 },
      ] };
  });
  return { schema: "janseon-rollback-plan.v1", status: inputs.size === 3 ? "REHEARSAL_PLANNED" : "CONSUMER_INPUT_REQUIRED",
    scope: "operator-supplied-rehearsal-bindings-not-live-introspection", executable: false,
    preflight: { registerSha256: sha(registerBytes), registerHeadSha256: entries.at(-1)?.sha256 ?? null, chainValid: true, targetVerified: true, suppliedBeforeHashesVerified: true },
    targetReleaseId: selected.mapReleaseId, surfaces,
    authorityTransition: { status: "NOT_IMPLEMENTED", currentLedger: entries.at(-1)?.ledger ?? null, historicalTargetLedger: selected.ledger,
      requiresNewCurrentGeneration: true, replaceCommandStore: false, restoreWikiWriter: false },
    atomicity: "per-file-rename-only; consumer locks and cross-surface coordination are execution prerequisites" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), flags = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!["--store", "--target", "--consumer-states"].includes(args[i]) || flags.has(args[i]) || !args[i + 1]) fail("USAGE");
      flags.set(args[i], args[i + 1]);
    }
    if (!flags.has("--store") || !flags.has("--target")) fail("USAGE");
    const consumerStates = flags.has("--consumer-states") ? JSON.parse(readFileSync(absolute(flags.get("--consumer-states")), "utf8")) : [];
    console.log(canonicalEncode(rollbackPlan({ store: flags.get("--store"), target: flags.get("--target"), consumerStates })));
  } catch (error) {
    console.error(JSON.stringify({ schema: "janseon-rollback-plan.v1", status: "REJECTED", code: error.code ?? "INVALID_INPUT", path: error.path ?? null }));
    process.exitCode = error.code === "ROLLBACK_STALE" ? 3 : 2;
  }
}
