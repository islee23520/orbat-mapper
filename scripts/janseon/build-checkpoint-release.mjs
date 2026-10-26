import { readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { canonicalEncode } from "./canonical.mjs";
import { withCommandReleaseCheckpoint } from "./command-store.mjs";
import { verifyMainAcceptance } from "./main-acceptance.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const absolute = value => { if (typeof value !== "string" || !isAbsolute(value)) fail("ABSOLUTE_PATH_REQUIRED"); return value; };
let db;
try {
  const args = process.argv.slice(2), flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--request", "--authoritative-store", "--output-dir", "--require-main"].includes(args[i]) || flags.has(args[i]) || !args[i + 1]) fail("USAGE");
    flags.set(args[i], absolute(args[i + 1]));
  }
  if (!["--request", "--authoritative-store", "--output-dir"].every(key => flags.has(key))) fail("USAGE");
  const request = JSON.parse(readFileSync(flags.get("--request"), "utf8")); canonicalEncode(request);
  const keys = ["schema", "binding", "provenance", "context", "license", "sourceRows"];
  if (!request || Object.keys(request).length !== keys.length || !keys.every(k => Object.hasOwn(request, k))
    || request.schema !== "janseon-checkpoint-release-request.v1" || Object.hasOwn(request.provenance, "ledger")) fail("INVALID_REQUEST");
  const databasePath = realpathSync(flags.get("--authoritative-store"));
  db = new DatabaseSync(databasePath); db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
  if (db.prepare("PRAGMA journal_mode").get().journal_mode === "wal") fail("E_BUILD_CHECKPOINT_REQUIRED");
  const result = withCommandReleaseCheckpoint(db, request.binding, ledger => {
    const mainAcceptance = flags.has("--require-main") ? verifyMainAcceptance(flags.get("--require-main"), ledger) : null;
    // Raw inode reads/secondary connection closes must not occur in the process
    // holding SQLite's POSIX record lock. Keep generation in a separate process.
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { buildMapRelease } from ${JSON.stringify(new URL("./build-map-release.mjs", import.meta.url).href)};
      try {
        const release = buildMapRelease(JSON.parse(readFileSync(0, 'utf8')));
        console.log(JSON.stringify({ manifest: release.manifest, sourceReceipt: release.sourceReceipt,
          members: Object.fromEntries(Object.entries(release.members).map(([path, bytes]) => [path, bytes.toString('base64')])) }));
      } catch (error) { console.error(JSON.stringify({ code: error.code ?? 'INVALID_INPUT' })); process.exitCode = 2; }
    `], { input: JSON.stringify({ ...request, databasePath, provenance: { ...request.provenance, ledger } }), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
    if (child.error) throw child.error;
    if (child.status !== 0) fail(JSON.parse(child.stderr).code);
    const release = JSON.parse(child.stdout);
    if (mainAcceptance && canonicalEncode(verifyMainAcceptance(flags.get("--require-main"), ledger)) !== canonicalEncode(mainAcceptance)) fail("MAIN_RECEIPT_STALE");
    const output = flags.get("--output-dir");
    // A fresh explicit directory prevents overwriting a store, request or prior release.
    mkdirSync(output);
    for (const [path, bytes] of Object.entries(release.members)) {
      mkdirSync(dirname(join(output, path)), { recursive: true }); writeFileSync(join(output, path), Buffer.from(bytes, "base64"), { flag: "wx" });
    }
    writeFileSync(join(output, "release-manifest.json"), canonicalEncode(release.manifest) + "\n", { flag: "wx" });
    writeFileSync(join(output, "source-receipt.json"), canonicalEncode(release.sourceReceipt) + "\n", { flag: "wx" });
    if (mainAcceptance) {
      verifyMainAcceptance(flags.get("--require-main"), ledger);
      writeFileSync(join(output, "main-acceptance.json"), canonicalEncode(mainAcceptance) + "\n", { flag: "wx" });
    }
    return { mapReleaseId: release.manifest.mapReleaseId, deliveryReceiptId: release.manifest.deliveryReceiptId, ledger, ...(mainAcceptance ? { mainAcceptance } : {}) };
  });
  console.log(JSON.stringify({ schema: "janseon-checkpoint-release-result.v1", status: "BUILT", ...result, outputDirectory: flags.get("--output-dir") }));
} catch (error) {
  const locked = error.errcode === 5 || error.errcode === 6;
  process.exitCode = locked ? 4 : 2;
  console.error(JSON.stringify({ schema: "janseon-checkpoint-release-result.v1", status: "REJECTED", code: locked ? "WRITER_LOCKED" : error.code ?? "INVALID_INPUT" }));
} finally { db?.close(); }
