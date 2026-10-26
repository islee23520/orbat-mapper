import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withCommandReleaseCheckpoint } from "./command-store.mjs";
import { recordMainAcceptance } from "./main-acceptance.mjs";

let db;
try {
  const flags = new Map(), args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!["--request", "--binding", "--repository", "--authoritative-store", "--signing-key"].includes(args[i])
      || flags.has(args[i]) || !isAbsolute(args[i + 1] ?? "")) throw Object.assign(Error("USAGE"), { code: "USAGE" });
    flags.set(args[i], args[i + 1]);
  }
  if (flags.size !== 5) throw Object.assign(Error("USAGE"), { code: "USAGE" });
  const request = JSON.parse(readFileSync(flags.get("--request"), "utf8"));
  const binding = JSON.parse(readFileSync(flags.get("--binding"), "utf8"));
  const key = readFileSync(flags.get("--signing-key"));
  db = new DatabaseSync(realpathSync(flags.get("--authoritative-store")));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
  const result = withCommandReleaseCheckpoint(db, binding,
    ledger => recordMainAcceptance(flags.get("--repository"), request, ledger, key));
  console.log(JSON.stringify({ status: "RECORDED", ...result }));
} catch (error) {
  process.exitCode = error.errcode === 5 || error.errcode === 6 ? 4 : 2;
  console.error(JSON.stringify({ status: "REJECTED", code: process.exitCode === 4 ? "WRITER_LOCKED" : error.code ?? "INVALID_INPUT" }));
} finally { db?.close(); }
