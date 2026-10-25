import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { exportCommandLog, readCommandEdition, replayCommandLog } from "./command-store.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => {
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key))) fail("INVALID_REQUEST");
};
const absolute = path => { if (typeof path !== "string" || !isAbsolute(path)) fail("ABSOLUTE_PATH_REQUIRED"); return path; };
const json = path => { const value = JSON.parse(readFileSync(absolute(path), "utf8")); canonicalEncode(value); return value; };

// Apply never takes a write target from the transport or request. The operator
// must designate the authoritative store separately; exports are read-only.
let db;
try {
  const [action, ...args] = process.argv.slice(2);
  const expected = action === "export" ? ["--request"] : action === "apply" ? ["--request", "--authoritative-store"] : [];
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!expected.includes(args[i]) || flags.has(args[i]) || !args[i + 1]) fail("USAGE");
    flags.set(args[i], args[i + 1]);
  }
  if (!expected.length || flags.size !== expected.length) fail("USAGE");
  const request = json(flags.get("--request"));
  if (action === "export") {
    exact(request, ["schema", "cloneStore", "bindingPath", "outputPath"]);
    if (request.schema !== "janseon-command-export-request.v1") fail("INVALID_REQUEST");
    const binding = json(request.bindingPath), cloneStore = realpathSync(absolute(request.cloneStore));
    db = new DatabaseSync(cloneStore, { readOnly: true }); db.exec("PRAGMA foreign_keys=ON; PRAGMA query_only=ON");
    const log = exportCommandLog(db, binding);
    const transport = { schema: "janseon-command-transport.v1", log, sha256: semanticDigest(log) };
    // Exclusive output prevents silently replacing a binding, store or package.
    writeFileSync(absolute(request.outputPath), canonicalEncode(transport) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ schema: "janseon-command-cli-result.v1", status: "EXPORTED", commands: log.commands.length,
      packageSha256: transport.sha256, outputPath: request.outputPath }));
  } else {
    exact(request, ["schema", "bindingPath", "packagePath"]);
    if (request.schema !== "janseon-command-apply-request.v1") fail("INVALID_REQUEST");
    const binding = json(request.bindingPath), transport = json(request.packagePath);
    exact(transport, ["schema", "log", "sha256"]);
    if (transport.schema !== "janseon-command-transport.v1" || semanticDigest(transport.log) !== transport.sha256) fail("PACKAGE_TAMPERED");
    const store = realpathSync(absolute(flags.get("--authoritative-store")));
    db = new DatabaseSync(store); db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
    const results = replayCommandLog(db, { binding, package: transport.log });
    const head = readCommandEdition(db, binding);
    console.log(JSON.stringify({ schema: "janseon-command-cli-result.v1", status: "ACCEPTED", authoritativeStore: store,
      commands: results.map(result => ({ operationId: result.operationId, replayed: result.replayed })),
      generationId: head.generationId, editionId: head.authored.editionId, mapSemanticSha256: head.mapSemanticSha256 }));
  }
} catch (error) {
  const stale = ["E_COMMAND_STALE", "E_COMMAND_STORE_STALE"].includes(error.code);
  const locked = error.errcode === 5 || error.errcode === 6;
  const code = stale ? "STALE_BASE" : locked ? "WRITER_LOCKED" : error.code ?? "INVALID_INPUT";
  process.exitCode = stale ? 3 : locked ? 4 : 2;
  console.error(JSON.stringify({ schema: "janseon-command-cli-result.v1", status: "REJECTED", code,
    ...(stale ? { instruction: "Refresh the clone from the current authoritative head, rebuild and re-review the commands, then export again. Do not rewrite the old package base pins." } : {}) }));
} finally { db?.close(); }
