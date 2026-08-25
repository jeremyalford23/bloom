import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION } from "./api/version.js";
import { openDatabase } from "./db.js";
import { handleApi, sendJson } from "./api/router.js";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
const contentTypes = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"
};

export function createBloomServer(options = {}) {
  const db = options.db ?? openDatabase(options.databasePath);
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        if (!await handleApi(request, response, url, db)) sendJson(response, 404, { error: "API route not found" });
        return;
      }
    } catch (error) {
      console.error(error);
      sendJson(response, error.statusCode ?? 400, { error: error.message });
      return;
    }
    if (request.method !== "GET") { sendJson(response, 405, { error: "Method not allowed" }); return; }
    const relativePath = url.pathname === "/" || !extname(url.pathname) ? "index.html" : url.pathname.slice(1);
    if (relativePath.includes("..")) {
      sendJson(response, 400, { error: "Invalid path" });
      return;
    }
    try {
      const file = await readFile(join(publicDirectory, relativePath));
      response.writeHead(200, { "content-type": contentTypes[extname(relativePath)] ?? "application/octet-stream" });
      response.end(file);
    } catch (error) {
      if (error.code === "ENOENT") sendJson(response, 404, { error: "Not found" });
      else sendJson(response, 500, { error: "Unexpected server error" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createBloomServer().listen(port, host, () => {
    console.log(`Bloom ${API_VERSION} listening on http://${host}:${port}`);
  });
}
