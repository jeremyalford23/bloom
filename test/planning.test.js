import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { calculatePlan, createObligation, updatePlanningAssumptions } from "../src/services/planning.js";
import { createAccount } from "../src/services/ledger.js";

function transaction(db, { id, categoryId, date, amountMinor }) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO transactions
    (id, account_id, posted_date, amount_minor, original_description, category_id, fingerprint, created_at, updated_at)
    VALUES (?, 'checking', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, date, amountMinor, id, categoryId, id, now, now);
}

test("planning v3 is deterministic and traces results to source inputs", () => {
  const db = openDatabase(":memory:");
  createAccount(db, { id:"ignored", name:"Checking", type:"checking", role:"Operating cash", balanceMinor:300000, balanceAsOf:"2026-08-31" });
  const account = db.prepare("SELECT id FROM accounts WHERE name = 'Checking'").get();
  db.prepare("UPDATE accounts SET id = 'checking' WHERE id = ?").run(account.id);
  updatePlanningAssumptions(db, { asOfDate:"2026-08-31", essentialAverageMonths:6, generalAverageMonths:12, effectiveTaxRateBps:2000 });
  transaction(db, { id:"mortgage-1", categoryId:"mortgage", date:"2026-08-01", amountMinor:-100000 });
  transaction(db, { id:"grocery-1", categoryId:"groceries", date:"2026-08-02", amountMinor:-60000 });
  transaction(db, { id:"income-1", categoryId:"paycheck", date:"2026-08-03", amountMinor:300000 });
  const first = calculatePlan(db), second = calculatePlan(db);
  assert.equal(first.totals.committedMinor, 220000);
  assert.equal(first.results.minimumGrossIncome.formulaVersion, "planning-v3");
  assert.ok(first.results.householdRequirement.inputReferences.some((ref) => ref.id === "mortgage"));
  assert.deepEqual(first, second);
});

test("operating cash considers the highest trailing 31-day ordinary spend", () => {
  const db = openDatabase(":memory:");
  createAccount(db, { name:"Checking", type:"checking", role:"Operating cash", balanceMinor:0, balanceAsOf:"2026-08-31" });
  const account = db.prepare("SELECT id FROM accounts WHERE name = 'Checking'").get();
  db.prepare("UPDATE accounts SET id = 'checking' WHERE id = ?").run(account.id);
  updatePlanningAssumptions(db, { asOfDate:"2026-08-31" });
  transaction(db, { id:"ordinary-1", categoryId:"groceries", date:"2026-07-01", amountMinor:-10000 });
  transaction(db, { id:"ordinary-2", categoryId:"groceries", date:"2026-07-20", amountMinor:-20000 });
  transaction(db, { id:"ordinary-3", categoryId:"groceries", date:"2026-08-25", amountMinor:-40000 });
  transaction(db, { id:"irregular-1", categoryId:"property-taxes", date:"2026-08-26", amountMinor:-90000 });

  const plan = calculatePlan(db);
  assert.equal(plan.cash.operatingTargetMinor, 40000);
  assert.equal(plan.results.operatingCashTarget.formulaName, "greater-of-observed-31-day-peak-or-buffered-monthly-budget");
});

test("sparse history is blended with budgets instead of treating missing months as zero", () => {
  const db = openDatabase(":memory:");
  createAccount(db, { id:"ignored", name:"Checking", type:"checking", role:"Operating cash", balanceMinor:0, balanceAsOf:"2026-08-31" });
  const account = db.prepare("SELECT id FROM accounts WHERE name = 'Checking'").get();
  db.prepare("UPDATE accounts SET id = 'checking' WHERE id = ?").run(account.id);
  updatePlanningAssumptions(db, { asOfDate:"2026-08-31", generalAverageMonths:12 });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO budgets (id, category_id, amount_minor, cadence, effective_from, note, created_at, updated_at)
    VALUES ('mortgage-budget', 'mortgage', 90000, 'monthly', '2025-09', 'test', ?, ?)`
  ).run(now, now);
  transaction(db, { id:"mortgage-actual", categoryId:"mortgage", date:"2026-08-01", amountMinor:-100000 });

  const mortgage = calculatePlan(db).requirementClasses
    .find((group) => group.id === "fixed-contractual").categories
    .find((category) => category.categoryId === "mortgage");
  assert.equal(mortgage.annualMinor, 1090000);
  assert.equal(mortgage.actualMonths, 1);
  assert.equal(mortgage.budgetMonths, 11);
  assert.equal(mortgage.missingMonths, 0);
  assert.equal(mortgage.confidence, "blended");
});

test("operating cash uses the buffered monthly budget when history is sparse", () => {
  const db = openDatabase(":memory:");
  createAccount(db, { id:"ignored", name:"Checking", type:"checking", role:"Operating cash", balanceMinor:0, balanceAsOf:"2026-08-31" });
  const account = db.prepare("SELECT id FROM accounts WHERE name = 'Checking'").get();
  db.prepare("UPDATE accounts SET id = 'checking' WHERE id = ?").run(account.id);
  updatePlanningAssumptions(db, { asOfDate:"2026-08-31", operatingCashBufferBps:1500 });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO budgets (id, category_id, amount_minor, cadence, effective_from, note, created_at, updated_at)
    VALUES ('grocery-budget', 'groceries', 100000, 'monthly', '2026-01', 'test', ?, ?)`
  ).run(now, now);
  transaction(db, { id:"grocery-actual", categoryId:"groceries", date:"2026-08-01", amountMinor:-20000 });

  const plan = calculatePlan(db);
  assert.equal(plan.cash.observedPeakMinor, 20000);
  assert.equal(plan.cash.budgetOperatingFloorMinor, 115000);
  assert.equal(plan.cash.operatingTargetMinor, 115000);
});

test("annual savings requirement is calculated from cash gaps and paced sinking shortfalls", () => {
  const db = openDatabase(":memory:");
  updatePlanningAssumptions(db, { asOfDate:"2026-08-31", emergencyCoverageMonths:0, obligationHorizonMonths:6 });
  createAccount(db, { name:"Obligations", type:"checking", role:"Known near-term obligations", balanceMinor:25000, balanceAsOf:"2026-08-31" });
  createObligation(db, { name:"Property tax", dueDate:"2026-10-15", amountMinor:100000 });
  db.prepare("UPDATE categories SET target_balance_minor = 120000, current_balance_minor = 0, next_due_date = '2028-08-30' WHERE id = 'home-maintenance'").run();

  const plan = calculatePlan(db);
  assert.equal(plan.capital.savingsRequirementMinor, 135000);
  assert.equal(plan.results.annualSavingsRequirement.amountMinor, 135000);
  assert.equal(plan.results.annualSavingsRequirement.formulaName, "cash-gaps-plus-deadline-paced-sinking-shortfalls");
});

test("calculated plan answers are not editable assumptions", () => {
  const db = openDatabase(":memory:");
  const assumptions = db.prepare("SELECT key FROM planning_assumptions ORDER BY key").all().map((row) => row.key);
  assert.ok(!assumptions.includes("operatingCashMonths"));
  assert.ok(!assumptions.includes("annualSavingsRequirementMinor"));
  assert.ok(!assumptions.includes("paycheckTimingBufferMinor"));
});

test("known obligations inside the horizon increase required liquid cash", () => {
  const db = openDatabase(":memory:");
  updatePlanningAssumptions(db, { asOfDate:"2026-08-31", obligationHorizonMonths:6 });
  createObligation(db, { name:"Property tax", dueDate:"2026-10-15", amountMinor:640000 });
  createObligation(db, { name:"Later project", dueDate:"2028-01-01", amountMinor:900000 });
  const plan = calculatePlan(db);
  assert.equal(plan.cash.obligationTargetMinor, 640000);
  assert.equal(plan.obligations.length, 1);
  assert.ok(plan.results.liquidRequirement.inputReferences.some((ref) => ref.type === "known-obligation"));
});

test("credit card balances reduce holdings regardless of their stored sign", () => {
  const db = openDatabase(":memory:");
  createAccount(db, { name:"Checking", type:"checking", role:"Operating cash", balanceMinor:1000000, balanceAsOf:"2026-08-31" });
  createAccount(db, { name:"Positive card", type:"credit-card", role:"Spending · paid in full", balanceMinor:509700, balanceAsOf:"2026-08-31" });
  createAccount(db, { name:"Negative card", type:"credit-card", role:"Spending · paid in full", balanceMinor:-10000, balanceAsOf:"2026-08-31" });

  const plan = calculatePlan(db);
  assert.equal(plan.capital.totalHoldingsMinor, 480300);
  assert.equal(plan.accounts.find((account) => account.name === "Checking").balanceMinor, 1000000);
  assert.equal(plan.accounts.find((account) => account.name === "Positive card").balanceMinor, -509700);
  assert.equal(plan.accounts.find((account) => account.name === "Negative card").balanceMinor, -10000);
});
