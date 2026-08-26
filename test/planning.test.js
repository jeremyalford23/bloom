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

test("planning v1 is deterministic and traces results to source inputs", () => {
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
  assert.equal(first.results.minimumGrossIncome.formulaVersion, "planning-v1");
  assert.ok(first.results.householdRequirement.inputReferences.some((ref) => ref.id === "mortgage"));
  assert.deepEqual(first, second);
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
