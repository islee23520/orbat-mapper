import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** Operator-started loopback process bridge, never a SQLite writer. */
export function createEditorCliBridge(config) {
  if (!config.token || config.token.length < 32 || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(config.origin)) throw Error("BRIDGE_CONFIG");
  for (const key of ["cloneStore", "bindingPath", "reviewPath", "authoritativeStore"]) {
    if (!isAbsolute(config[key])) throw Error("BRIDGE_PATH");
    config[key] = realpathSync(config[key]);
  }
  const cli = fileURLToPath(new URL("./apply-map-commands.mjs", import.meta.url));
  return createServer(async (request, response) => {
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": config.origin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" };
    const send = (status, value) => { response.writeHead(status, headers); response.end(JSON.stringify(value)); };
    if (request.headers.origin !== config.origin) return send(403, { code: "BRIDGE_ORIGIN" });
    if (request.method === "OPTIONS") { response.writeHead(204, headers); return response.end(); }
    if (request.headers.authorization !== "Bearer " + config.token) return send(403, { code: "BRIDGE_TOKEN" });
    if (request.method !== "POST" || !["/package", "/apply"].includes(request.url)) return send(404, { code: "BRIDGE_ROUTE" });
    let directory;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 1048576) throw Error("BRIDGE_BODY_LIMIT"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const packageAction = request.url === "/package";
      const keys = packageAction ? ["commandPackage"] : ["transport", "authoritativeStore"];
      if (!body || Object.keys(body).length !== keys.length || !keys.every(k => Object.hasOwn(body, k))) throw Error("BRIDGE_REQUEST");
      if (!packageAction && (!isAbsolute(body.authoritativeStore) || realpathSync(body.authoritativeStore) !== config.authoritativeStore)) throw Error("BRIDGE_AUTHORITY");
      directory = mkdtempSync(join(tmpdir(), "editor-cli-bridge-"));
      const packagePath = join(directory, "package.json"), requestPath = join(directory, "request.json");
      const args = [cli, packageAction ? "package" : "apply", "--request", requestPath];
      if (packageAction) {
        const commandPath = join(directory, "command.json"); writeFileSync(commandPath, JSON.stringify(body.commandPackage));
        writeFileSync(requestPath, JSON.stringify({ schema: "janseon-command-package-request.v1", cloneStore: config.cloneStore,
          bindingPath: config.bindingPath, reviewPath: config.reviewPath, commandPath, outputPath: packagePath }));
      } else {
        writeFileSync(packagePath, JSON.stringify(body.transport));
        writeFileSync(requestPath, JSON.stringify({ schema: "janseon-command-apply-request.v1", bindingPath: config.bindingPath, packagePath }));
        args.push("--authoritative-store", config.authoritativeStore);
      }
      const result = await new Promise((accept, reject) => {
        const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
        let stdout = "", stderr = "";
        child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
        child.once("error", reject);
        child.once("close", exitCode => { try { accept({ exitCode, result: JSON.parse(exitCode === 0 ? stdout : stderr) }); } catch (error) { reject(error); } });
      });
      send(200, { ...result, ...(packageAction && result.exitCode === 0 ? { transport: JSON.parse(readFileSync(packagePath, "utf8")) } : {}) });
    } catch (error) { send(400, { exitCode: 2, result: { status: "REJECTED", code: error.message } }); }
    finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--config" || !isAbsolute(process.argv[3])) throw Error("BRIDGE_CONFIG_REQUIRED");
  const config = JSON.parse(readFileSync(process.argv[3], "utf8"));
  createEditorCliBridge(config).listen(config.port, "127.0.0.1", () => console.log(JSON.stringify({ event: "editor-cli-bridge-ready", port: config.port })));
}
