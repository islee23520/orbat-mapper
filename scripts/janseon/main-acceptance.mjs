import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";

const MAIN = "refs/heads/main", RECEIPT = "refs/janseon/main-acceptance";
const REPOSITORY = "https://github.com/islee23520/orbat-mapper.git";
const ZERO = "0".repeat(40);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonicalEncode(a) === canonicalEncode(b);
const exact = (value, keys) => {
  if (!value || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail("MAIN_RECEIPT_INVALID");
};
function git(repository, args, input) {
  const result = spawnSync("git", ["-C", repository, ...args], { input, encoding: "utf8" });
  if (result.status !== 0) fail("MAIN_GIT_CONFLICT");
  return result.stdout.trim();
}
function current(repository) {
  if (git(repository, ["remote", "get-url", "origin"]) !== REPOSITORY) fail("MAIN_REPOSITORY_MISMATCH");
  return git(repository, ["rev-parse", MAIN]);
}
function policy() {
  return JSON.parse(readFileSync(new URL("./trusted-main-recorders.json", import.meta.url), "utf8"));
}
function authenticated(repository, oid) {
  const envelope = JSON.parse(git(repository, ["cat-file", "blob", oid]));
  exact(envelope, ["payload", "signature"]);
  const p = envelope.payload;
  exact(p, ["schema", "repository", "ref", "recorder", "baseMain", "mainCommit", "previousReceipt", "ledger"]);
  const key = policy()[p.recorder];
  if (!key || p.schema !== "janseon-main-acceptance.v1" || p.repository !== REPOSITORY || p.ref !== MAIN)
    fail("MAIN_RECORDER_UNTRUSTED");
  const publicKey = createPublicKey(key);
  if (publicKey.asymmetricKeyType !== "ed25519" || typeof envelope.signature !== "string"
    || !verify(null, Buffer.from(canonicalEncode(p)), publicKey, Buffer.from(envelope.signature, "base64"))) fail("MAIN_SIGNATURE_INVALID");
  return p;
}
function receiptHead(repository) {
  const value = git(repository, ["for-each-ref", "--format=%(objectname)", RECEIPT]);
  return value || null;
}
function reserve(repository, expectedMain, expectedReceipt, replacement) {
  // Main and acceptance-head CAS share Git's ref transaction. No fetch or merge.
  git(repository, ["update-ref", "--stdin"], `start\nverify ${MAIN} ${expectedMain}\n${replacement
    ? `update ${RECEIPT} ${replacement} ${expectedReceipt ?? ZERO}`
    : `verify ${RECEIPT} ${expectedReceipt}`}\nprepare\ncommit\n`);
}

/** Called only while withCommandReleaseCheckpoint owns the authoritative writer. */
export function recordMainAcceptance(repository, request, ledger, privateKeyBytes) {
  exact(request, ["schema", "recorder", "baseMain", "mainCommit", "previousReceipt", "ledger"]);
  if (request.schema !== "janseon-main-acceptance-request.v1" || !same(request.ledger, ledger)) fail("MAIN_TUPLE_MISMATCH");
  const main = current(repository), previous = receiptHead(repository);
  if (main !== request.mainCommit) fail("MAIN_COMMIT_MISMATCH");
  if (previous !== request.previousReceipt) fail("MAIN_RECEIPT_STALE");
  // Every enrollment denotes a post-integration commit, never the pre-merge base.
  if (git(repository, ["rev-parse", `${main}^1`]) !== request.baseMain) fail("MAIN_MERGE_ORDER");
  if (previous) {
    const old = authenticated(repository, previous);
    if (old.mainCommit !== request.baseMain || old.ledger.datasetId !== ledger.datasetId
      || old.ledger.sequence >= ledger.sequence) fail("MAIN_MERGE_ORDER");
  }
  const trusted = policy()[request.recorder];
  if (!trusted) fail("MAIN_RECORDER_UNTRUSTED");
  const key = createPrivateKey(privateKeyBytes);
  if (key.asymmetricKeyType !== "ed25519"
    || createPublicKey(key).export({ type: "spki", format: "pem" }) !== createPublicKey(trusted).export({ type: "spki", format: "pem" }))
    fail("MAIN_RECORDER_UNTRUSTED");
  const payload = { schema: "janseon-main-acceptance.v1", repository: REPOSITORY, ref: MAIN,
    recorder: request.recorder, baseMain: request.baseMain, mainCommit: main, previousReceipt: previous, ledger };
  const envelope = { payload, signature: sign(null, Buffer.from(canonicalEncode(payload)), key).toString("base64") };
  const oid = git(repository, ["hash-object", "-w", "--stdin"], canonicalEncode(envelope) + "\n");
  reserve(repository, main, previous, oid);
  return { receiptObject: oid, mainCommit: main, ledgerSha256: semanticDigest(ledger) };
}

/** Read the authoritative ref, never a caller-supplied receipt or sourceCommit. */
export function verifyMainAcceptance(repository, ledger) {
  const main = current(repository), oid = receiptHead(repository);
  if (!oid) fail("MAIN_RECEIPT_MISSING");
  const p = authenticated(repository, oid);
  if (p.mainCommit !== main) fail("MAIN_RECEIPT_STALE");
  if (!same(p.ledger, ledger)) fail("MAIN_TUPLE_MISMATCH");
  reserve(repository, main, oid);
  return { receiptObject: oid, mainCommit: main, ledgerSha256: semanticDigest(ledger) };
}
