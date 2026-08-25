import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { API_VERSION } from "../src/api/version.js";
import { createBloomServer } from "../src/server.js";

async function withServer(run) {
  const server = createBloomServer({ databasePath: ":memory:" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("index is reachable", () => withServer(async (baseUrl) => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /Household Financial Decision Engine/i);
}));

test("health endpoint reports version and taxonomy readiness", () => withServer(async (baseUrl) => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok", apiVersion: API_VERSION, checks: { taxonomy: "ok", database: "ok" }
  });
}));

test("domain endpoint exposes versioned Phase 0 definitions", () => withServer(async (baseUrl) => {
  const response = await fetch(`${baseUrl}/api/domain`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.apiVersion, API_VERSION);
  assert.ok(body.models.Transaction);
  assert.ok(body.seedCategories.length > 0);
}));
