import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { commitImport, stageImport } from "../src/services/imports.js";
import { createAccount, createCategory, deleteCategory, updateCategory } from "../src/services/ledger.js";
import {
  budgetOverview, categoryBudgetDetail, createBudget, decideRecurring, deleteBudget, deleteIrregularBudget,
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
  createBudget(db, { categoryId: "paycheck", amountMinor: 300000, effectiveFrom: "2026-08" });
  const overview = budgetOverview(db, "2026-08");
  assert.equal(overview.summary.spendingMinor, 13000);
  assert.equal(overview.summary.spendingBudgetMinor, 16000);
  assert.equal(overview.summary.incomeMinor, 250000);
  assert.equal(overview.summary.incomeBudgetMinor, 300000);
  assert.equal(overview.summary.incomeDeltaMinor, -50000);
  const restaurants = overview.groups.flatMap((group) => group.categories).find((item) => item.id === "restaurants");
  assert.equal(restaurants.actualMinor, 3000);
  assert.equal(restaurants.deltaMinor, -1000);
  const paycheck = overview.groups.flatMap((group) => group.categories).find((item) => item.id === "paycheck");
  assert.equal(paycheck.actualMinor, 250000);
  assert.equal(paycheck.average12Minor, Math.round(250000 / 12));
});

test("income category detail projects and reports positive income activity", () => {
  const { db } = fixture();
  createBudget(db, { categoryId: "paycheck", amountMinor: 300000, effectiveFrom: "2026-08" });
  const detail = categoryBudgetDetail(db, "paycheck", "2026-08");
  assert.equal(detail.kind, "income");
  assert.equal(detail.current.actualMinor, 250000);
  assert.equal(detail.current.budgetMinor, 300000);
  assert.equal(detail.transactions.length, 1);
  assert.equal(detail.transactions[0].amountMinor, 250000);
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

test("categories can be created and unused categories can be deleted with their budgets", () => {
  const { db } = fixture();
  const category = createCategory(db, { name: "Childcare", planningGroupId: "essential-variable", cadence: "monthly" });
  createBudget(db, { categoryId: category.id, amountMinor: 120000, effectiveFrom: "2026-08" });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM budgets WHERE category_id = ?").get(category.id).count, 1);
  assert.deepEqual(deleteCategory(db, category.id), { id: category.id, deleted: true });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM categories WHERE id = ?").get(category.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM budgets WHERE category_id = ?").get(category.id).count, 0);
});

test("categories referenced by transactions cannot be deleted", () => {
  const { db } = fixture();
  assert.throws(() => deleteCategory(db, "restaurants"), /cannot be deleted/);
  assert.ok(db.prepare("SELECT id FROM categories WHERE id = 'restaurants'").get());
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

test("referenced irregular budgets can be removed while retaining transaction history", () => {
  const { db } = fixture();
  db.prepare("UPDATE transactions SET category_id = 'property-taxes' WHERE original_description = 'WENDYS'").run();
  createBudget(db, { categoryId: "property-taxes", amountMinor: 50000, effectiveFrom: "2026-08" });
  const transactionCount = db.prepare("SELECT COUNT(*) count FROM transactions WHERE category_id = 'property-taxes'").get().count;
  assert.equal(deleteIrregularBudget(db, "property-taxes").historyRetained, true);
  assert.equal(db.prepare("SELECT active FROM categories WHERE id = 'property-taxes'").get().active, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM budgets WHERE category_id = 'property-taxes'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM transactions WHERE category_id = 'property-taxes'").get().count, transactionCount);
  assert.equal(irregularExpenses(db, 2026).categories.some((item) => item.id === "property-taxes"), false);
});
