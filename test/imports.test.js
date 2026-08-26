import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { commitImport, csvObjects, stageImport } from "../src/services/imports.js";
import { createAccount, createRule, listTransactions, replaceSplits, updateTransactions } from "../src/services/ledger.js";
import { runRules } from "../src/services/rules.js";

const sampleCsv = `Date,Description,Amount,Notes
08/21/2026,MENARDS #3082,-184.20,deck repair
08/18/2026,FESTIVAL FOODS #12,-212.77,groceries
08/20/2026,ONLINE TRANSFER TO SAV,-1200.00,
`;

function fixture() {
  const db = openDatabase(":memory:");
  const account = createAccount(db, { name: "Chase Checking", type: "checking", lastFour: "4412" });
  return { db, account };
}

test("CSV parser preserves quoted commas and embedded quotes", () => {
  const result = csvObjects('Date,Description,Amount\n08/01/2026,"Store, Inc. ""East""",-12.34\n');
  assert.equal(result.records[0].Description, 'Store, Inc. "East"');
});

test("separate debit and credit columns determine direction regardless of embedded signs", () => {
  const { db, account } = fixture();
  const csv = `Date,Description,Debit,Credit
08/11/2026,MINT MOBILE,360.00,
08/15/2026,MINT MOBILE,,-360.00
08/18/2026,ACE HARDWARE,,70.39`;
  const staged = stageImport(db, {
    files: [{
      name: "credit-card.csv", accountId: account.id, csv,
      mapping: { date: "Date", description: "Description", amount: "", debit: "Debit", credit: "Credit" }
    }]
  });

  assert.deepEqual(staged.preview.map((row) => row.amountMinor), [-36000, 36000, 7039]);
});

test("import stages, applies rules, commits, and remains idempotent", () => {
  const { db, account } = fixture();
  createRule(db, { matchType: "starts-with", matchText: "MENARDS", merchantName: "Menards", categoryId: "home-maintenance" });
  const payload = { files: [{ name: "chase.csv", accountId: account.id, csv: sampleCsv, mapping: { date: "Date", description: "Description", amount: "Amount" } }] };
  const first = stageImport(db, payload);
  assert.deepEqual({ rows: first.rowsRead, fresh: first.newCount, duplicates: first.duplicateCount, exceptions: first.exceptionCount }, { rows: 3, fresh: 3, duplicates: 0, exceptions: 0 });
  assert.equal(commitImport(db, first.id).committed, 3);
  const transactions = listTransactions(db);
  assert.equal(transactions.summary.count, 3);
  const menards = transactions.rows.find((row) => row.originalDescription.startsWith("MENARDS"));
  assert.equal(menards.merchantName, "Menards");
  assert.equal(menards.categoryId, "home-maintenance");

  const second = stageImport(db, payload);
  assert.equal(second.newCount, 0);
  assert.equal(second.duplicateCount, 3);
  assert.equal(commitImport(db, second.id).committed, 0);
  assert.equal(listTransactions(db).summary.count, 3);
});

test("invalid rows are held while an explicit partial commit remains possible", () => {
  const { db, account } = fixture();
  const result = stageImport(db, { files: [{ name: "bad.csv", accountId: account.id, csv: "Date,Description,Amount\n08/32/2026,Store,-10.00\n08/01/2026,Valid,-5.00", mapping: { date: "Date", description: "Description", amount: "Amount" } }] });
  assert.equal(result.exceptionCount, 1);
  assert.throws(() => commitImport(db, result.id), /Resolve exceptions/);
  assert.equal(commitImport(db, result.id, { allowExceptions: true }).committed, 1);
});

test("bulk edits and exact split allocation persist", () => {
  const { db, account } = fixture();
  const staged = stageImport(db, { files: [{ name: "one.csv", accountId: account.id, csv: "Date,Description,Amount\n08/01/2026,Store,-10.00", mapping: { date: "Date", description: "Description", amount: "Amount" } }] });
  commitImport(db, staged.id);
  const id = listTransactions(db).rows[0].id;
  updateTransactions(db, [id], { notes: "repair supplies", flagged: true });
  assert.equal(listTransactions(db).rows[0].flagged, 1);
  assert.throws(() => replaceSplits(db, id, [{ categoryId: "groceries", amountMinor: -700 }, { categoryId: "home-maintenance", amountMinor: -299 }]), /exactly equal/);
  const split = replaceSplits(db, id, [{ categoryId: "groceries", amountMinor: -700 }, { categoryId: "home-maintenance", amountMinor: -300 }]);
  assert.equal(split.splits.length, 2);
});

test("manual rule runs preview safely and classify existing transactions", () => {
  const { db, account } = fixture();
  const staged = stageImport(db, { files: [{ name: "existing.csv", accountId: account.id, csv: "Date,Description,Amount\n08/01/2026,MENARDS #100,-25.00\n08/02/2026,FESTIVAL FOODS,-50.00", mapping: { date: "Date", description: "Description", amount: "Amount" } }] });
  commitImport(db, staged.id);
  createRule(db, { priority: 1, matchType: "starts-with", matchText: "MENARDS", merchantName: "Menards", categoryId: "home-maintenance" });

  const preview = runRules(db, { onlyUncategorized: true });
  assert.deepEqual(preview.summary, { considered: 2, matched: 1, changed: 1, unchanged: 1, skippedManual: 0 });
  assert.equal(listTransactions(db).rows.find((row) => row.originalDescription.startsWith("MENARDS")).categoryId, null);

  const applied = runRules(db, { onlyUncategorized: true, apply: true });
  assert.equal(applied.summary.changed, 1);
  const menards = listTransactions(db).rows.find((row) => row.originalDescription.startsWith("MENARDS"));
  assert.equal(menards.categoryId, "home-maintenance");
  assert.equal(menards.merchantName, "Menards");
});

test("manual rule runs preserve manual classifications by default", () => {
  const { db, account } = fixture();
  const staged = stageImport(db, { files: [{ name: "manual.csv", accountId: account.id, csv: "Date,Description,Amount\n08/01/2026,MENARDS #100,-25.00", mapping: { date: "Date", description: "Description", amount: "Amount" } }] });
  commitImport(db, staged.id);
  const transactionId = listTransactions(db).rows[0].id;
  updateTransactions(db, [transactionId], { categoryId: "groceries" });
  createRule(db, { matchType: "starts-with", matchText: "MENARDS", categoryId: "home-maintenance" });

  const preserved = runRules(db, { onlyUncategorized: false, apply: true });
  assert.equal(preserved.summary.skippedManual, 1);
  assert.equal(listTransactions(db).rows[0].categoryId, "groceries");

  const overwritten = runRules(db, { onlyUncategorized: false, overwriteManual: true, apply: true });
  assert.equal(overwritten.summary.changed, 1);
  assert.equal(listTransactions(db).rows[0].categoryId, "home-maintenance");
});

test("rules accept empty optional scope and action fields from browser forms", () => {
  const { db } = fixture();
  const rule = createRule(db, {
    matchType: "contains",
    matchText: "PAYMENT",
    accountId: "",
    merchantName: "",
    categoryId: "",
    markTransfer: true
  });
  assert.equal(rule.accountId, null);
  assert.equal(rule.categoryId, null);
  assert.equal(rule.markTransfer, 1);
});
