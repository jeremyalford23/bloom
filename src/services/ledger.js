import { randomUUID } from "node:crypto";
import { audit, rowToObject, rowsToObjects } from "../db.js";

const TRANSACTION_SELECT = `
  SELECT t.*, a.name account_name, a.last_four account_last_four,
    m.name merchant_name, c.name category_name, c.planning_group_id,
    (SELECT COUNT(*) FROM transaction_splits s WHERE s.transaction_id = t.id) split_count
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN merchants m ON m.id = t.merchant_id
  LEFT JOIN categories c ON c.id = t.category_id
`;

export function listTransactions(db, query = {}) {
  const conditions = [];
  const params = [];
  if (query.search) {
    conditions.push("(m.name LIKE ? OR t.original_description LIKE ? OR t.notes LIKE ?)");
    const term = `%${query.search}%`;
    params.push(term, term, term);
  }
  if (query.accountId) { conditions.push("t.account_id = ?"); params.push(query.accountId); }
  if (query.categoryId === "uncategorized") conditions.push("t.category_id IS NULL AND t.is_transfer = 0");
  else if (query.categoryId) { conditions.push("t.category_id = ?"); params.push(query.categoryId); }
  if (query.from) { conditions.push("t.posted_date >= ?"); params.push(query.from); }
  if (query.to) { conditions.push("t.posted_date <= ?"); params.push(query.to); }
  if (query.flagged === "true") conditions.push("t.flagged = 1");
  if (query.transfers === "true") conditions.push("t.is_transfer = 1");
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const allowedSorts = { date: "t.posted_date", amount: "t.amount_minor", merchant: "m.name" };
  const sort = allowedSorts[query.sort] ?? "t.posted_date";
  const direction = query.direction === "asc" ? "ASC" : "DESC";
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const rows = rowsToObjects(db.prepare(`${TRANSACTION_SELECT}${where} ORDER BY ${sort} ${direction}, t.id LIMIT ? OFFSET ?`).all(...params, limit, offset));
  const summary = rowToObject(db.prepare(
    `SELECT COUNT(*) count,
      COALESCE(SUM(CASE WHEN t.is_transfer = 0 AND t.excluded = 0 THEN t.amount_minor ELSE 0 END), 0) amount_minor,
      SUM(t.category_id IS NULL AND t.is_transfer = 0) uncategorized_count
     FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id${where}`
  ).get(...params));
  return { rows, summary, limit, offset };
}

export function getTransaction(db, id) {
  const transaction = rowToObject(db.prepare(`${TRANSACTION_SELECT} WHERE t.id = ?`).get(id));
  if (!transaction) return null;
  transaction.splits = rowsToObjects(db.prepare(
    "SELECT s.*, c.name category_name FROM transaction_splits s JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = ?"
  ).all(id));
  transaction.auditTrail = rowsToObjects(db.prepare(
    "SELECT * FROM audit_events WHERE entity_type = 'transaction' AND entity_id = ? ORDER BY created_at DESC"
  ).all(id)).map((event) => ({ ...event, detail: JSON.parse(event.detailJson) }));
  if (transaction.rawImportRecordId) {
    transaction.source = rowToObject(db.prepare(
      `SELECT r.row_number, r.raw_json, r.created_at, f.file_name, f.content_sha256
       FROM raw_import_records r JOIN import_files f ON f.id = r.import_file_id WHERE r.id = ?`
    ).get(transaction.rawImportRecordId));
  }
  return transaction;
}

function findOrCreateMerchant(db, name) {
  const cleaned = name.trim().replace(/\s+/g, " ");
  let merchant = db.prepare("SELECT id FROM merchants WHERE name = ? COLLATE NOCASE").get(cleaned);
  if (merchant) return merchant.id;
  const id = randomUUID();
  db.prepare("INSERT INTO merchants (id, name, created_at) VALUES (?, ?, ?)").run(id, cleaned, new Date().toISOString());
  return id;
}

export function updateTransactions(db, ids, changes) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("Select at least one transaction");
  const allowed = new Set(["merchantName", "categoryId", "notes", "isTransfer", "excluded", "flagged"]);
  if (!Object.keys(changes).some((key) => allowed.has(key))) throw new Error("No supported changes supplied");
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    for (const id of ids) {
      const current = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
      if (!current) continue;
      const merchantId = changes.merchantName !== undefined
        ? findOrCreateMerchant(db, changes.merchantName)
        : current.merchant_id;
      const categoryId = changes.categoryId !== undefined ? changes.categoryId || null : current.category_id;
      const notes = changes.notes !== undefined ? changes.notes || null : current.notes;
      const isTransfer = changes.isTransfer !== undefined ? Number(Boolean(changes.isTransfer)) : current.is_transfer;
      const excluded = changes.excluded !== undefined ? Number(Boolean(changes.excluded)) : (isTransfer ? 1 : current.excluded);
      const flagged = changes.flagged !== undefined ? Number(Boolean(changes.flagged)) : current.flagged;
      db.prepare(
        "UPDATE transactions SET merchant_id = ?, category_id = ?, notes = ?, is_transfer = ?, excluded = ?, flagged = ?, updated_at = ? WHERE id = ?"
      ).run(merchantId, categoryId, notes, isTransfer, excluded, flagged, now, id);
      audit(db, "transaction", id, "updated", changes);
    }
  });
  transaction();
  return ids.map((id) => getTransaction(db, id)).filter(Boolean);
}

export function replaceSplits(db, transactionId, splits) {
  const source = db.prepare("SELECT amount_minor FROM transactions WHERE id = ?").get(transactionId);
  if (!source) throw Object.assign(new Error("Transaction not found"), { statusCode: 404 });
  if (!Array.isArray(splits) || splits.length < 2) throw new Error("A split requires at least two parts");
  const total = splits.reduce((sum, split) => sum + Number(split.amountMinor), 0);
  if (!splits.every((split) => Number.isSafeInteger(split.amountMinor) && split.categoryId) || total !== source.amount_minor) {
    throw new Error("Split parts must use valid categories and exactly equal the transaction amount");
  }
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM transaction_splits WHERE transaction_id = ?").run(transactionId);
    const insert = db.prepare(
      "INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor, notes) VALUES (?, ?, ?, ?, ?)"
    );
    for (const split of splits) insert.run(randomUUID(), transactionId, split.categoryId, split.amountMinor, split.notes ?? null);
    db.prepare("UPDATE transactions SET category_id = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), transactionId);
    audit(db, "transaction", transactionId, "split", { parts: splits.length });
  });
  transaction();
  return getTransaction(db, transactionId);
}

export function pairTransfers(db, firstId, secondId) {
  if (firstId === secondId) throw new Error("Choose two different transactions");
  const [first, second] = [firstId, secondId].map((id) => db.prepare("SELECT * FROM transactions WHERE id = ?").get(id));
  if (!first || !second) throw Object.assign(new Error("Transaction not found"), { statusCode: 404 });
  if (first.amount_minor + second.amount_minor !== 0) throw new Error("Transfer amounts must have opposite signs and equal values");
  const transaction = db.transaction(() => {
    db.prepare("UPDATE transactions SET is_transfer = 1, excluded = 1, transfer_pair_id = ?, updated_at = ? WHERE id = ?")
      .run(secondId, new Date().toISOString(), firstId);
    db.prepare("UPDATE transactions SET is_transfer = 1, excluded = 1, transfer_pair_id = ?, updated_at = ? WHERE id = ?")
      .run(firstId, new Date().toISOString(), secondId);
    audit(db, "transaction", firstId, "transfer_paired", { pairedWith: secondId });
    audit(db, "transaction", secondId, "transfer_paired", { pairedWith: firstId });
  });
  transaction();
  return [getTransaction(db, firstId), getTransaction(db, secondId)];
}

export function listAccounts(db) {
  return rowsToObjects(db.prepare(
    `SELECT a.*, COUNT(t.id) transaction_count, MAX(t.posted_date) last_import
     FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
     GROUP BY a.id ORDER BY a.name`
  ).all());
}

export function createAccount(db, input) {
  if (!input.name?.trim() || !input.type) throw new Error("Account name and type are required");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO accounts
      (id, name, institution, last_four, type, role, currency, balance_minor, balance_as_of, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.name.trim(), input.institution ?? null, input.lastFour ?? null, input.type,
    input.role ?? "unassigned", input.currency ?? "USD", input.balanceMinor ?? null,
    input.balanceAsOf ?? null, now, now
  );
  audit(db, "account", id, "created", input);
  return rowToObject(db.prepare("SELECT * FROM accounts WHERE id = ?").get(id));
}

export function updateAccount(db, id, input) {
  const current = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  if (!current) throw Object.assign(new Error("Account not found"), { statusCode: 404 });
  db.prepare(
    `UPDATE accounts SET name = ?, institution = ?, last_four = ?, type = ?, role = ?,
      currency = ?, balance_minor = ?, balance_as_of = ?, updated_at = ? WHERE id = ?`
  ).run(
    input.name ?? current.name, input.institution ?? current.institution, input.lastFour ?? current.last_four,
    input.type ?? current.type, input.role ?? current.role, input.currency ?? current.currency,
    input.balanceMinor ?? current.balance_minor, input.balanceAsOf ?? current.balance_as_of,
    new Date().toISOString(), id
  );
  audit(db, "account", id, "updated", input);
  return rowToObject(db.prepare("SELECT * FROM accounts WHERE id = ?").get(id));
}

export function listCategories(db) {
  return rowsToObjects(db.prepare(
    `SELECT c.*, p.name planning_group_name, p.kind,
      COUNT(t.id) transaction_count,
      COALESCE(-SUM(CASE WHEN t.amount_minor < 0 AND t.is_transfer = 0 AND t.excluded = 0 THEN t.amount_minor ELSE 0 END), 0) spending_minor
     FROM categories c JOIN planning_groups p ON p.id = c.planning_group_id
     LEFT JOIN transactions t ON t.category_id = c.id
     GROUP BY c.id ORDER BY p.name, c.name`
  ).all());
}

export function updateCategory(db, id, input) {
  const current = db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
  if (!current) throw Object.assign(new Error("Category not found"), { statusCode: 404 });
  db.prepare(
    "UPDATE categories SET name = ?, planning_group_id = ?, cadence = ?, active = ? WHERE id = ?"
  ).run(input.name ?? current.name, input.planningGroupId ?? current.planning_group_id, input.cadence ?? current.cadence,
    input.active === undefined ? current.active : Number(Boolean(input.active)), id);
  audit(db, "category", id, "updated", input);
  return rowToObject(db.prepare("SELECT * FROM categories WHERE id = ?").get(id));
}

export function createRule(db, input) {
  if (!input.matchText?.trim()) throw new Error("Rule match text is required");
  if (!input.merchantName && !input.categoryId && !input.markTransfer) throw new Error("Rule must perform at least one action");
  const id = randomUUID();
  const now = new Date().toISOString();
  const priority = input.priority ?? (db.prepare("SELECT COALESCE(MAX(priority), 0) + 1 priority FROM classification_rules").get().priority);
  db.prepare(
    `INSERT INTO classification_rules
      (id, priority, match_type, match_text, account_id, merchant_name, category_id, mark_transfer, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, priority, input.matchType ?? "contains", input.matchText.trim(), input.accountId ?? null,
    input.merchantName ?? null, input.categoryId ?? null, Number(Boolean(input.markTransfer)), now, now);
  audit(db, "classification_rule", id, "created", input);
  return rowToObject(db.prepare("SELECT * FROM classification_rules WHERE id = ?").get(id));
}

export function listRules(db) {
  return rowsToObjects(db.prepare(
    `SELECT r.*, a.name account_name, c.name category_name
     FROM classification_rules r LEFT JOIN accounts a ON a.id = r.account_id
     LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.priority, r.created_at`
  ).all());
}
