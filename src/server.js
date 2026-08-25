import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION } from "./api/version.js";
import { DOMAIN_DEFINITION } from "./domain/model.js";
import { validateTaxonomy } from "./domain/validation.js";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "8712", 10);
const host = process.env.HOST ?? "0.0.0.0";
const contentTypes = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"
};

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createBloomServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    if (url.pathname === "/api/health") {
      const taxonomyErrors = validateTaxonomy();
      sendJson(response, taxonomyErrors.length ? 503 : 200, {
        status: taxonomyErrors.length ? "degraded" : "ok",
        apiVersion: API_VERSION,
        checks: { taxonomy: taxonomyErrors.length ? taxonomyErrors : "ok" }
      });
      return;
    }
    if (url.pathname === "/api/version") {
      sendJson(response, 200, { name: "Bloom API", version: API_VERSION });
      return;
    }
    if (url.pathname === "/api/domain") {
      sendJson(response, 200, { apiVersion: API_VERSION, ...DOMAIN_DEFINITION });
      return;
    }

    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
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

