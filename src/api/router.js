import { API_VERSION } from "./version.js";
import { DOMAIN_DEFINITION } from "../domain/model.js";
import { validateTaxonomy } from "../domain/validation.js";
import { rowToObject, rowsToObjects } from "../db.js";
import { commitImport, importDetail, importHistory, resolveImportRecord, stageImport } from "../services/imports.js";
import {
  createAccount, createCategory, createRule, deleteCategory, deleteRule, getTransaction, listAccounts, listCategories, listRules,
  listTransactions, pairTransfers, replaceSplits, updateAccount, updateCategory, updateTransactions
} from "../services/ledger.js";
import { runRules } from "../services/rules.js";
import {
  budgetOverview, categoryBudgetDetail, createBudget, decideRecurring, deleteBudget,
  getBudgetSettings, irregularExpenses, recurringExpenses, updateBudgetSettings
} from "../services/budget.js";
import { calculatePlan, createObligation, deleteObligation, getPlanningAssumptions, listObligations, updatePlanningAssumptions } from "../services/planning.js";

export function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw Object.assign(new Error("Request is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON request"), { statusCode: 400 }); }
}

function matchPath(pathname, pattern) {
  const names = [];
  const regex = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
    names.push(name);
    return "([^/]+)";
  }) + "$");
  const match = pathname.match(regex);
  return match ? Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])])) : null;
}

export async function handleApi(request, response, url, db) {
  const { pathname } = url;
  const method = request.method;
  let params;
  if (method === "GET" && pathname === "/api/health") {
    const taxonomyErrors = validateTaxonomy();
    let database = "ok";
    try { db.prepare("SELECT 1").get(); } catch { database = "error"; }
    const ok = !taxonomyErrors.length && database === "ok";
    sendJson(response, ok ? 200 : 503, { status: ok ? "ok" : "degraded", apiVersion: API_VERSION, checks: { taxonomy: taxonomyErrors.length ? taxonomyErrors : "ok", database } });
    return true;
  }
  if (method === "GET" && pathname === "/api/version") { sendJson(response, 200, { name: "Bloom API", version: API_VERSION }); return true; }
  if (method === "GET" && pathname === "/api/domain") { sendJson(response, 200, { apiVersion: API_VERSION, ...DOMAIN_DEFINITION }); return true; }
  if (method === "GET" && pathname === "/api/overview") {
    const overview = rowToObject(db.prepare("SELECT COUNT(*) transaction_count, SUM(category_id IS NULL AND is_transfer = 0) review_count, COALESCE(SUM(CASE WHEN is_transfer = 0 AND excluded = 0 THEN amount_minor ELSE 0 END), 0) net_minor FROM transactions").get());
    sendJson(response, 200, { ...overview, accountCount: Number(db.prepare("SELECT COUNT(*) count FROM accounts").get().count), ruleCount: Number(db.prepare("SELECT COUNT(*) count FROM classification_rules").get().count) }); return true;
  }
  if (method === "GET" && pathname === "/api/accounts") { sendJson(response, 200, listAccounts(db)); return true; }
  if (method === "POST" && pathname === "/api/accounts") { sendJson(response, 201, createAccount(db, await readJson(request))); return true; }
  if ((params = matchPath(pathname, "/api/accounts/:id")) && method === "PATCH") { sendJson(response, 200, updateAccount(db, params.id, await readJson(request))); return true; }
  if (method === "GET" && pathname === "/api/categories") { sendJson(response, 200, listCategories(db)); return true; }
  if (method === "POST" && pathname === "/api/categories") { sendJson(response, 201, createCategory(db, await readJson(request))); return true; }
  if (method === "GET" && pathname === "/api/budget") { sendJson(response, 200, budgetOverview(db, url.searchParams.get("month") || undefined)); return true; }
  if (method === "POST" && pathname === "/api/budgets") { sendJson(response, 201, createBudget(db, await readJson(request))); return true; }
  if ((params = matchPath(pathname, "/api/budgets/:id")) && method === "DELETE") { sendJson(response, 200, deleteBudget(db, params.id)); return true; }
  if ((params = matchPath(pathname, "/api/categories/:id/budget")) && method === "GET") { sendJson(response, 200, categoryBudgetDetail(db, params.id, url.searchParams.get("month") || undefined)); return true; }
  if (method === "GET" && pathname === "/api/budget-settings") { sendJson(response, 200, getBudgetSettings(db)); return true; }
  if (method === "PATCH" && pathname === "/api/budget-settings") { sendJson(response, 200, updateBudgetSettings(db, await readJson(request))); return true; }
  if (method === "GET" && pathname === "/api/recurring") { sendJson(response, 200, recurringExpenses(db)); return true; }
  if (method === "POST" && pathname === "/api/recurring/decision") { sendJson(response, 200, decideRecurring(db, await readJson(request))); return true; }
  if (method === "GET" && pathname === "/api/irregular") { sendJson(response, 200, irregularExpenses(db, Number(url.searchParams.get("year")) || undefined)); return true; }
  if (method === "GET" && pathname === "/api/planning-groups") { sendJson(response, 200, rowsToObjects(db.prepare("SELECT * FROM planning_groups ORDER BY name").all())); return true; }
  if (method === "GET" && pathname === "/api/plan") { sendJson(response, 200, calculatePlan(db)); return true; }
  if (method === "GET" && pathname === "/api/plan/assumptions") { sendJson(response, 200, getPlanningAssumptions(db)); return true; }
  if (method === "PATCH" && pathname === "/api/plan/assumptions") { sendJson(response, 200, updatePlanningAssumptions(db, await readJson(request))); return true; }
  if (method === "GET" && pathname === "/api/plan/obligations") { sendJson(response, 200, listObligations(db)); return true; }
  if (method === "POST" && pathname === "/api/plan/obligations") { sendJson(response, 201, createObligation(db, await readJson(request))); return true; }
  if ((params = matchPath(pathname, "/api/plan/obligations/:id")) && method === "DELETE") { sendJson(response, 200, deleteObligation(db, params.id)); return true; }
  if ((params = matchPath(pathname, "/api/categories/:id")) && method === "PATCH") { sendJson(response, 200, updateCategory(db, params.id, await readJson(request))); return true; }
  if ((params = matchPath(pathname, "/api/categories/:id")) && method === "DELETE") { sendJson(response, 200, deleteCategory(db, params.id)); return true; }
  if (method === "GET" && pathname === "/api/rules") { sendJson(response, 200, listRules(db)); return true; }
  if (method === "POST" && pathname === "/api/rules") { sendJson(response, 201, createRule(db, await readJson(request))); return true; }
  if ((params = matchPath(pathname, "/api/rules/:id")) && method === "DELETE") { sendJson(response, 200, deleteRule(db, params.id)); return true; }
  if (method === "POST" && pathname === "/api/rules/run") { sendJson(response, 200, runRules(db, await readJson(request))); return true; }
  if (method === "GET" && pathname === "/api/transactions") { sendJson(response, 200, listTransactions(db, Object.fromEntries(url.searchParams))); return true; }
  if (method === "PATCH" && pathname === "/api/transactions") { const body = await readJson(request); sendJson(response, 200, updateTransactions(db, body.ids, body.changes ?? {})); return true; }
  if ((params = matchPath(pathname, "/api/transactions/:id")) && method === "GET") { const value = getTransaction(db, params.id); sendJson(response, value ? 200 : 404, value ?? { error: "Transaction not found" }); return true; }
  if ((params = matchPath(pathname, "/api/transactions/:id")) && method === "PATCH") { sendJson(response, 200, updateTransactions(db, [params.id], await readJson(request))[0]); return true; }
  if ((params = matchPath(pathname, "/api/transactions/:id/splits")) && method === "PUT") { const body = await readJson(request); sendJson(response, 200, replaceSplits(db, params.id, body.splits)); return true; }
  if (method === "POST" && pathname === "/api/transfers/pair") { const body = await readJson(request); sendJson(response, 200, pairTransfers(db, body.firstId, body.secondId)); return true; }
  if (method === "POST" && pathname === "/api/imports/stage") { sendJson(response, 201, stageImport(db, await readJson(request))); return true; }
  if (method === "GET" && pathname === "/api/imports") { sendJson(response, 200, importHistory(db)); return true; }
  if ((params = matchPath(pathname, "/api/imports/:id")) && method === "GET") { const value = importDetail(db, params.id); sendJson(response, value ? 200 : 404, value ?? { error: "Import run not found" }); return true; }
  if ((params = matchPath(pathname, "/api/imports/:id/commit")) && method === "POST") { sendJson(response, 200, commitImport(db, params.id, await readJson(request))); return true; }
  if ((params = matchPath(pathname, "/api/import-records/:id")) && method === "PATCH") { sendJson(response, 200, resolveImportRecord(db, params.id, await readJson(request))); return true; }
  return false;
}
