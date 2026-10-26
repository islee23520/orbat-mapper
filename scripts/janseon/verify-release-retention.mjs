import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { validateReleaseManifest } from "./release-manifest.mjs";

const fail = (code, path) => { throw Object.assign(new Error(code), { code, path }); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => canonicalEncode(a) === canonicalEncode(b);
const absolute = path => { if (typeof path !== "string" || !isAbsolute(path)) fail("ABSOLUTE_PATH_REQUIRED"); return path; };

/** Byte integrity only: neither source authentication nor release admission. */
export function verifyRelease(directory, context) {
  absolute(directory);
  const files = [], payloads = new Map();
  function walk(path = "") {
    const full = join(directory, path), stat = lstatSync(full);
    if (stat.isSymbolicLink()) fail("RELEASE_SYMLINK", path);
    if (stat.isDirectory()) { for (const name of readdirSync(full).sort()) walk(path ? path + "/" + name : name); }
    else if (stat.isFile()) {
      const bytes = readFileSync(full); payloads.set(path, bytes);
      files.push({ path, sizeBytes: bytes.length, sha256: sha(bytes) });
    } else fail("RELEASE_FILE_TYPE", path);
  }
  walk(); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = JSON.parse(payloads.get("release-manifest.json")?.toString() ?? "null");
  const ids = validateReleaseManifest(manifest, context);
  const expected = ["release-manifest.json", "source-receipt.json", ...manifest.semantic.members.map(m => m.path)].sort();
  if (!equal(files.map(f => f.path), expected)) fail("RELEASE_MEMBERS");
  const semantic = structuredClone(manifest.semantic);
  for (const member of semantic.members) {
    const bytes = payloads.get(member.path);
    member.sizeBytes = bytes.length; member.rawSha256 = sha(bytes);
    const declared = manifest.semantic.members.find(m => m.path === member.path);
    if (!equal(member, declared)) fail("RELEASE_MEMBER_DRIFT", member.path);
  }
  if (semanticDigest(semantic) !== ids.mapReleaseId) fail("RELEASE_R_MISMATCH");
  return { ...ids, ledger: manifest.provenance.ledger ?? null, files };
}

export function readRegister(store, allowMissing = false) {
  absolute(store);
  if (!existsSync(store)) { if (allowMissing) return []; fail("RETENTION_STORE_MISSING", store); }
  if (!lstatSync(store).isFile() || lstatSync(store).isSymbolicLink()) fail("RETENTION_STORE_TYPE", store);
  const text = readFileSync(store, "utf8"), entries = [], seen = new Set();
  if (text && !text.endsWith("\n")) fail("RETENTION_CHAIN");
  for (const line of text ? text.slice(0, -1).split("\n") : []) {
    let entry;
    try { entry = JSON.parse(line); } catch { fail("RETENTION_CHAIN"); }
    const keys = ["schema", "sequence", "previousSha256", "mapReleaseId", "deliveryReceiptId", "ledger", "timestamp", "retentionPath", "context", "files", "sha256"];
    if (!entry || Object.keys(entry).length !== keys.length || !keys.every(k => Object.hasOwn(entry, k))) fail("RETENTION_CHAIN");
    const { sha256, ...body } = entry;
    if (entry.schema !== "janseon-release-retention.v1" || entry.sequence !== entries.length + 1
      || entry.previousSha256 !== (entries.at(-1)?.sha256 ?? null) || semanticDigest(body) !== sha256
      || !/^[a-f0-9]{64}$/u.test(entry.mapReleaseId) || !/^[a-f0-9]{64}$/u.test(entry.deliveryReceiptId)
      || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))
      || new Date(entry.timestamp).toISOString() !== entry.timestamp || !isAbsolute(entry.retentionPath)
      || seen.has(entry.mapReleaseId) || !Array.isArray(entry.files) || !equal(entry.files.map(f => f.path), [...new Set(entry.files.map(f => f.path))].sort())) fail("RETENTION_CHAIN");
    seen.add(entry.mapReleaseId); entries.push(entry);
  }
  return entries;
}

/** A single local writer is enforced; interruption leaves a visible lock to inspect. */
export function registerRelease(directory, context, store) {
  absolute(store);
  const lock = store + ".lock";
  try { mkdirSync(lock); } catch (error) { if (error.code === "EEXIST") fail("RETENTION_LOCKED", lock); throw error; }
  try {
    const entries = readRegister(store, true), verified = verifyRelease(directory, context);
    if (!verified.ledger) fail("RETENTION_LEDGER_REQUIRED");
    const retentionPath = realpathSync(directory), prior = entries.find(e => e.mapReleaseId === verified.mapReleaseId);
    if (prior) {
      if (!equal({ ...verified, context, retentionPath }, { mapReleaseId: prior.mapReleaseId, deliveryReceiptId: prior.deliveryReceiptId,
        ledger: prior.ledger, files: prior.files, context: prior.context, retentionPath: prior.retentionPath })) fail("RETENTION_DUPLICATE_MISMATCH");
      return { status: "ALREADY_REGISTERED", entry: prior };
    }
    const body = { schema: "janseon-release-retention.v1", sequence: entries.length + 1, previousSha256: entries.at(-1)?.sha256 ?? null,
      ...verified, timestamp: new Date().toISOString(), retentionPath, context };
    const entry = { ...body, sha256: semanticDigest(body) };
    appendFileSync(store, canonicalEncode(entry) + "\n", { flag: "a" });
    return { status: "REGISTERED", entry };
  } finally { rmdirSync(lock); }
}

export function verifyRetention(store) {
  const entries = readRegister(store), failures = [];
  for (const entry of entries) {
    try {
      const actual = verifyRelease(entry.retentionPath, entry.context);
      if (!equal(actual, { mapReleaseId: entry.mapReleaseId, deliveryReceiptId: entry.deliveryReceiptId, ledger: entry.ledger, files: entry.files })) fail("RETENTION_DRIFT");
    } catch (error) {
      failures.push({ mapReleaseId: entry.mapReleaseId, retentionPath: entry.retentionPath,
        status: error.code === "ENOENT" ? "MISSING" : "DRIFTED", code: error.code ?? "INVALID_RELEASE", path: error.path ?? null });
    }
  }
  return { status: failures.length ? "RETENTION_FAILED" : "RETENTION_VERIFIED", count: entries.length, headSha256: entries.at(-1)?.sha256 ?? null, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2), flags = new Map();
    const required = command === "verify-release" ? ["--release-dir", "--context"]
      : command === "register" ? ["--release-dir", "--context", "--store"] : command === "verify-retention" ? ["--store"] : [];
    if (!required.length) fail("USAGE");
    for (let i = 0; i < args.length; i += 2) {
      if (!required.includes(args[i]) || flags.has(args[i]) || !args[i + 1]) fail("USAGE");
      flags.set(args[i], absolute(args[i + 1]));
    }
    if (flags.size !== required.length) fail("USAGE");
    const context = flags.has("--context") ? JSON.parse(readFileSync(flags.get("--context"), "utf8")) : null;
    const result = command === "verify-release" ? { status: "RELEASE_VERIFIED", ...verifyRelease(flags.get("--release-dir"), context) }
      : command === "register" ? registerRelease(flags.get("--release-dir"), context, flags.get("--store")) : verifyRetention(flags.get("--store"));
    console.log(canonicalEncode({ schema: "janseon-retention-result.v1", ...result }));
    process.exitCode = result.status === "RETENTION_FAILED" ? 3 : 0;
  } catch (error) {
    console.error(JSON.stringify({ schema: "janseon-retention-result.v1", status: "REJECTED", code: error.code ?? "INVALID_INPUT", path: error.path ?? null }));
    process.exitCode = 2;
  }
}
