import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { commitImport, stageImport } from "../src/services/imports.js";
import { createAccount, updateCategory } from "../src/services/ledger.js";
import {
  budgetOverview, categoryBudgetDetail, createBudget, decideRecurring, deleteBudget,
  getBudgetSettings, irregularExpenses, recurringExpenses, updateBudgetSettings
} from "../src/services/budget.js";

function fixture() {
  const db = openDatabase(":memory:");
  const account = createAccount(db, { name: "Checking", type: "checking" });
  const csv = `Date,Description,Amount
06/12/2026,WENDYS,-20.00
07/12/2026,WENDYS,-25.00
08/12/2026,WENDYS,-30.00
08/15/2026,FESTIVAL FOODS,-100.00
08/20/2026,PAYROLL,2500.00`;
  const staged = stageImport(db, { files: [{ name: "history.csv", accountId: account.id, csv, mapping: { date: "Date", description: "Description", amount: "Amount" } }] });
  commitImport(db, staged.id);
  const transactions = db.prepare("SELECT id, original_description FROM transactions").all();
  const restaurants = db.prepare("SELECT id FROM categories WHERE id = 'restaurants'").get();
  const groceries = db.prepare("SELECT id FROM categories WHERE id = 'groceries'").get();
  const income = db.prepare("SELECT id FROM categories WHERE id = 'paycheck'").get();
  for (const row of transactions) {
    const categoryId = row.original_description === "WENDYS" ? restaurants.id : row.original_description === "FESTIVAL FOODS" ? groceries.id : income.id;
    db.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").run(categoryId, row.id);
  }
  return { db };
}

test("budget overview separates spending and income and rolls up categories", () => {
  const { db } = fixture();
  createBudget(db, { categoryId: "restaurants", amountMinor: 4000, effectiveFrom: "2026-08" });
  createBudget(db, { categoryId: "groceries", amountMinor: 12000, effectiveFrom: "2026-08" });
  const overview = budgetOverview(db, "2026-08");
  assert.equal(overview.summary.spendingMinor, 13000);
  assert.equal(overview.summary.spendingBudgetMinor, 16000);
  assert.equal(overview.summary.incomeMinor, 250000);
  const restaurants = overview.groups.flatMap((group) => group.categories).find((item) => item.id === "restaurants");
  assert.equal(restaurants.actualMinor, 3000);
  assert.equal(restaurants.deltaMinor, -1000);
});

test("category detail supports adding and deleting independent budget records", () => {
  const { db } = fixture();
  const first = createBudget(db, { categoryId: "restaurants", amountMinor: 4000, effectiveFrom: "2026-06", note: "initial" });
  const second = createBudget(db, { categoryId: "restaurants", amountMinor: 5000, effectiveFrom: "2026-08", note: "updated" });
  let detail = categoryBudgetDetail(db, "restaurants", "2026-08");
  assert.equal(detail.current.budgetMinor, 5000);
  assert.equal(detail.budgets.length, 2);
  assert.equal(deleteBudget(db, second.id).deleted, true);
  detail = categoryBudgetDetail(db, "restaurants", "2026-08");
  assert.equal(detail.current.budgetMinor, 4000);
  assert.equal(detail.budgets.length, 1);
  assert.throws(() => deleteBudget(db, second.id), /not found/);
  assert.equal(detail.budgets[0].id, first.id);
});

test("recurring detection can be confirmed or dismissed", () => {
  const { db } = fixture();
  const detected = recurringExpenses(db);
  const candidate = detected.candidates.find((item) => item.merchantName.toLowerCase() === "wendys");
  assert.ok(candidate);
  const decided = decideRecurring(db, { merchantId: candidate.merchantId, merchantName: candidate.merchantName, categoryId: "restaurants", amountMinor: candidate.averageMinor, cadence: "monthly", state: "confirmed" });
  assert.equal(decided.confirmed.length, 1);
  assert.equal(decided.confirmed[0].merchantName.toLowerCase(), "wendys");
});

test("irregular targets and budget settings persist", () => {
  const { db } = fixture();
  updateCategory(db, "home-maintenance", { cadence: "irregular", targetBalanceMinor: 1200000, currentBalanceMinor: 745000, annualExpectedMinor: 300000 });
  const irregular = irregularExpenses(db, 2026);
  const home = irregular.categories.find((item) => item.id === "home-maintenance");
  assert.equal(home.targetBalanceMinor, 1200000);
  assert.equal(irregular.summary.targetMinor >= 1200000, true);
  assert.equal(getBudgetSettings(db).averageWindow, 12);
  assert.equal(updateBudgetSettings(db, { averageWindow: 6, rollover: true }).averageWindow, 6);
  assert.equal(getBudgetSettings(db).rollover, true);
});
