import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalEncode } from "./canonical.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = value => createHash("sha256").update(value).digest("hex");

/** Local object comparison only. Field ownership is not a file overwrite policy. */
export function reportUpstreamSync({ repository, baseRef, upstreamRef, forkRef }) {
  const git = args => execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commit = ref => {
    if (typeof ref !== "string" || !ref || ref.startsWith("-")) fail("INVALID_REF");
    return git(["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]).trim();
  };
  const base = commit(baseRef), upstream = commit(upstreamRef), fork = commit(forkRef);
  // Both comparison branches must actually descend from the recorded upstream baseline.
  git(["merge-base", "--is-ancestor", base, upstream]);
  git(["merge-base", "--is-ancestor", base, fork]);
  const ownershipPath = "docs/janseon/ownership.md", dispositionPath = "schemas/janseon/field-disposition.json";
  const ownership = git(["show", `${fork}:${ownershipPath}`]);
  const dispositionBytes = git(["show", `${fork}:${dispositionPath}`]);
  const disposition = JSON.parse(dispositionBytes);
  if (disposition.schema !== "janseon-field-disposition.v1" || disposition.source?.orbatBaseline !== base) fail("OWNERSHIP_BASE_MISMATCH");
  const tree = revision => new Map(git(["ls-tree", "-r", "-z", revision]).split("\0").filter(Boolean).map(record => {
    const split = record.indexOf("\t");
    return [record.slice(split + 1), record.slice(0, split)];
  }));
  const b = tree(base), u = tree(upstream), f = tree(fork);
  const upstreamOnlyChanges = [], forkModifiedConflicts = [], cleanIdentical = [], forkOnlyChanges = [];
  for (const path of [...new Set([...b.keys(), ...u.keys(), ...f.keys()])].sort()) {
    const before = b.get(path) ?? null, next = u.get(path) ?? null, ours = f.get(path) ?? null;
    const row = { path, base: before, upstream: next, fork: ours };
    if (next === ours) cleanIdentical.push(row);
    else if (ours === before) upstreamOnlyChanges.push(row);
    else if (next === before) forkOnlyChanges.push(row);
    else forkModifiedConflicts.push(row);
  }
  return { schema: "janseon-upstream-sync-report.v1", status: forkModifiedConflicts.length ? "SYNC_CONFLICT" : "SYNC_CLEAR",
    upstreamRepository: "https://github.com/orbat-mapper/orbat-mapper", base, upstream, fork,
    ownership: { path: ownershipPath, sha256: sha(ownership), dispositionPath, dispositionSha256: sha(dispositionBytes),
      classification: "observed-three-way-tree-identity-not-field-ownership", authorityCutover: disposition.authorityCutover },
    upstreamOnlyChanges, forkModifiedConflicts, cleanIdentical, forkOnlyChanges };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), flags = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!["--repository", "--base", "--upstream", "--fork"].includes(args[i]) || flags.has(args[i]) || !args[i + 1]) fail("USAGE");
      flags.set(args[i], args[i + 1]);
    }
    if (flags.size !== 4) fail("USAGE");
    const report = reportUpstreamSync({ repository: flags.get("--repository"), baseRef: flags.get("--base"), upstreamRef: flags.get("--upstream"), forkRef: flags.get("--fork") });
    console.log(canonicalEncode(report)); process.exitCode = report.status === "SYNC_CONFLICT" ? 3 : 0;
  } catch (error) {
    console.error(JSON.stringify({ schema: "janseon-upstream-sync-report.v1", status: "REJECTED", code: error.code ?? "LOCAL_GIT_INPUT" }));
    process.exitCode = 2;
  }
}
