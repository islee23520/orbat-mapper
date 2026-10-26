import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createReleaseManifest } from "./release-manifest.mjs";
import { registerRelease } from "./verify-release-retention.mjs";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
const sha = value => createHash("sha256").update(value).digest("hex"), h = sha("synthetic");
export function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/rollback-plan-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, "retention.jsonl"), statesPath = join(root, "states.json"), entries = [];
  for (const version of ["previous", "current"]) {
    const directory = join(root, version), ref = domain => ({ domain, datasetId: "synthetic:dataset", editionId: version });
    const receipt = { contentId: "synthetic-receipt", sha256: h };
    const specs = [["wiki/map-core.json", "map-core", ["graph"]], ["wiki/observed-geography.json", "observed-geography", ["observed-geography"]],
      ["wiki/spatial-assignments.json", "spatial-assignments", ["initial-state"]], ["wiki/station-bindings.json", "station-bindings", ["graph"]],
      ["wiki/underground-geometry.json", "underground-geometry", ["graph"]], ["game/world-graph.json", "world-graph", ["graph"]],
      ["game/map-topology.json", "map-topology", ["observed-geography"]], ["game/initial-world.json", "initial-world", ["graph", "initial-state"]],
      ["game/terrain-manifest.json", "terrain-manifest", ["observed-geography"]]].sort(([a], [b]) => a < b ? -1 : 1);
    const members = specs.map(([path, kind, roles]) => {
      const bytes = Buffer.from(JSON.stringify({ synthetic: path, version }) + "\n"); mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), bytes);
      return { path, kind, target: path.split("/")[0], sizeBytes: bytes.length, rawSha256: sha(bytes), visibility: "public",
        license: { id: "synthetic", textSha256: h }, identitySnapshotSha256: h, editionRefs: roles.map(ref) };
    });
    const semantic = { schema: "janseon-map-release-semantic.v1", projectionContract: "janseon-map-release-projection.v1", mapSemanticSha256: h, identitySnapshotSha256: h,
      editions: ["graph", "initial-state", "observed-geography"].map(domain => ({ ...ref(domain), semanticSha256: h })),
      domains: { graph: { semanticSha256: h, editionRefs: [ref("graph")] }, geometry: { semanticSha256: h, editionRefs: [ref("observed-geography")] }, initialState: { semanticSha256: h, editionRefs: [ref("initial-state")] } },
      targets: ["wiki", "game"], targetAllowlists: Object.fromEntries(["wiki", "game"].map(target => [target, members.filter(m => m.target === target).map(m => m.path)])), members };
    const context = { expectedTargets: ["wiki", "game"], budget: { schema: "janseon-map-release-budget.v1", migrationReceipt: receipt,
      members: members.map(m => ({ path: m.path, maxBytes: 10000 })), maxTotalBytes: 100000 } };
    const provenance = { sourceCommit: "1".repeat(40), snapshot: { contentId: "synthetic-snapshot", databaseSha256: h, mapSemanticSha256: h }, exporter: { revision: "2".repeat(40), version: "synthetic" },
      identityReceipt: receipt, sourceReceipts: semantic.editions.map(e => ({ editionRef: ref(e.domain), receipt })), approvalReceipts: [{ memberPaths: members.map(m => m.path), receipt }],
      budgetReceipt: { contentId: "synthetic-budget", sha256: semanticDigest(context.budget) }, memberLocations: members.map(m => ({ path: m.path, storage: "git", contentId: null })),
      ledger: { datasetId: "synthetic:dataset", sequence: entries.length, generationId: sha(version), editionId: version, mapSemanticSha256: h, contextSha256: h, commandLogSha256: h } };
    writeFileSync(join(directory, "release-manifest.json"), canonicalEncode(createReleaseManifest({ semantic, provenance }, context)) + "\n");
    writeFileSync(join(directory, "source-receipt.json"), '{"synthetic":true}\n'); entries.push(registerRelease(directory, context, store).entry);
  }
  const current = entries[1], states = ["M", "W", "G"].map(surface => {
    const path = join(root, surface + ".json"), bytes = JSON.stringify({ schema: "janseon-rollback-rehearsal-binding.v1", surface,
      mapReleaseId: current.mapReleaseId, deliveryReceiptId: current.deliveryReceiptId, ledger: current.ledger, retentionPath: current.retentionPath }) + "\n";
    writeFileSync(path, bytes); return { surface, path, expectedBeforeSha256: sha(bytes), currentReleaseId: current.mapReleaseId };
  });
  writeFileSync(statesPath, JSON.stringify(states)); return { root, store, statesPath, states, entries };
}
export function inventory(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
    const path = join(e.parentPath, e.name); return [path.slice(root.length), sha(readFileSync(path))];
  }).sort(([a], [b]) => a < b ? -1 : 1);
}
