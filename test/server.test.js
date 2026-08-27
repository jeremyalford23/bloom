import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
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
  const html = await response.text();
  assert.match(html, /Household Financial Decision Engine/i);
  assert.ok(html.includes(`/app.js?v=${API_VERSION}`));
  assert.ok(html.includes(`/styles.css?v=${API_VERSION}`));
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

test("category API creates and deletes a new budget category", () => withServer(async (baseUrl) => {
  const createdResponse = await fetch(`${baseUrl}/api/categories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Childcare", planningGroupId: "essential-variable", cadence: "monthly" })
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.name, "Childcare");

  const deletedResponse = await fetch(`${baseUrl}/api/categories/${created.id}`, { method: "DELETE" });
  assert.equal(deletedResponse.status, 200);
  assert.deepEqual(await deletedResponse.json(), { id: created.id, deleted: true });
}));

test("rule API creates and deletes a global rule", () => withServer(async (baseUrl) => {
  const createdResponse = await fetch(`${baseUrl}/api/rules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ matchText: "COFFEE", categoryId: "groceries" })
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.accountId, null);

  const deletedResponse = await fetch(`${baseUrl}/api/rules/${created.id}`, { method: "DELETE" });
  assert.equal(deletedResponse.status, 200);
  assert.deepEqual(await deletedResponse.json(), { id: created.id, deleted: true });
}));

test("budget modal scopes values and prevents duplicate saves", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /new FormData\(modalNode\.querySelector\("#new-budget-form"\)\)/);
  assert.match(appSource, /if\(save\.disabled\)return/);
  assert.match(appSource, /document\.querySelectorAll\("\.modal-backdrop"\)/);
});

test("irregular budgets expose a confirmed delete action", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /class="button danger delete-irregular"/);
  assert.match(appSource, /request\("\/api\/categories\/"\+button\.dataset\.id,\{method:"DELETE"\}\)/);
  assert.match(appSource, /confirm\('Delete the irregular budget/);
});

test("account roles include income and modals stack above the transaction drawer", async () => {
  const [appSource, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(appSource, /accountRoles = \[[^\]]*"Income"/);
  assert.match(appSource, /b\.onclick=\(\)=>node\.remove\(\)/);
  assert.match(styles, /\.modal-backdrop \{[^}]*z-index:30/);
  assert.match(styles, /\.drawer \{[^}]*z-index:22/);
});

test("account rows are editable and split rows can be added or removed", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /class="account-row"/);
  assert.match(appSource, /class="account-field"/);
  assert.match(appSource, /field\.replaceWith\(editor\)/);
  assert.match(appSource, /class="button primary save-account"/);
  assert.match(appSource, /method:"PATCH"/);
  assert.match(appSource, /id="add-split"/);
  assert.match(appSource, /class="button danger delete-split"/);
  assert.match(appSource, /t\.splits\?\.length >= 2/);
});

test("transaction category filter contains grouped choices and live search", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /class="category-menu"/);
  assert.match(appSource, /class="category-group-label"/);
  assert.match(appSource, /id="filter-category-search"/);
  assert.match(appSource, /groupedCategoryChoices\(filters\.categoryId,filters\.categorySearch\)/);
});
