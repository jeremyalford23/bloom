import { randomUUID } from "node:crypto";
import { audit } from "../db.js";

function matches(rule, description) {
  const source = description.toUpperCase();
  const target = rule.match_text.toUpperCase();
  if (rule.match_type === "equals") return source === target;
  if (rule.match_type === "starts-with") return source.startsWith(target);
  if (rule.match_type === "regex") {
    try {
      return new RegExp(rule.match_text, "i").test(description);
    } catch {
      return false;
    }
  }
  return source.includes(target);
}

export function matchingRule(db, accountId, description) {
  const rules = db.prepare(
    "SELECT * FROM classification_rules WHERE enabled = 1 AND (account_id IS NULL OR account_id = ?) ORDER BY priority, created_at"
  ).all(accountId);
  const rule = rules.find((candidate) => matches(candidate, description));
  return rule ? {
    id: rule.id,
    priority: rule.priority,
    merchantName: rule.merchant_name,
    categoryId: rule.category_id,
    markTransfer: Boolean(rule.mark_transfer)
  } : null;
}

function merchantIdFor(db, name, now) {
  if (!name) return null;
  const existing = db.prepare("SELECT id FROM merchants WHERE name = ? COLLATE NOCASE").get(name);
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare("INSERT INTO merchants (id, name, created_at) VALUES (?, ?, ?)").run(id, name.trim(), now);
  return id;
}

export function runRules(db, options = {}) {
  const apply = Boolean(options.apply);
  const onlyUncategorized = options.onlyUncategorized !== false;
  const overwriteManual = Boolean(options.overwriteManual);
  const ids = Array.isArray(options.ids) ? options.ids.filter(Boolean) : [];
  const conditions = [];
  const parameters = [];
  if (ids.length) {
    conditions.push(`t.id IN (${ids.map(() => "?").join(",")})`);
    parameters.push(...ids);
  }
  if (onlyUncategorized) conditions.push("t.category_id IS NULL AND t.is_transfer = 0");
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const transactions = db.prepare(
    `SELECT t.*, m.name merchant_name FROM transactions t
     LEFT JOIN merchants m ON m.id = t.merchant_id${where}
     ORDER BY t.posted_date DESC, t.id`
  ).all(...parameters);

  const summary = { considered: transactions.length, matched: 0, changed: 0, unchanged: 0, skippedManual: 0 };
  const changes = [];
  const now = new Date().toISOString();

  for (const transaction of transactions) {
    if (transaction.classification_source === "manual" && !overwriteManual) {
      summary.skippedManual += 1;
      continue;
    }
    const rule = matchingRule(db, transaction.account_id, transaction.original_description);
    if (!rule) {
      summary.unchanged += 1;
      continue;
    }
    summary.matched += 1;
    const nextMerchantName = rule.merchantName ?? transaction.merchant_name;
    const nextCategoryId = rule.categoryId ?? transaction.category_id;
    const nextTransfer = rule.markTransfer ? 1 : transaction.is_transfer;
    const changed = nextMerchantName !== transaction.merchant_name
      || nextCategoryId !== transaction.category_id
      || nextTransfer !== transaction.is_transfer;
    if (!changed) {
      summary.unchanged += 1;
      continue;
    }
    summary.changed += 1;
    changes.push({
      transactionId: transaction.id,
      postedDate: transaction.posted_date,
      description: transaction.original_description,
      amountMinor: transaction.amount_minor,
      ruleId: rule.id,
      rulePriority: rule.priority,
      before: { merchantName: transaction.merchant_name, categoryId: transaction.category_id, isTransfer: Boolean(transaction.is_transfer) },
      after: { merchantName: nextMerchantName, categoryId: nextCategoryId, isTransfer: Boolean(nextTransfer) }
    });
  }

  if (apply && changes.length) {
    const perform = db.transaction(() => {
      for (const change of changes) {
        const merchantId = merchantIdFor(db, change.after.merchantName, now);
        db.prepare(
          `UPDATE transactions SET merchant_id = COALESCE(?, merchant_id), category_id = ?,
            is_transfer = ?, excluded = CASE WHEN ? = 1 THEN 1 ELSE excluded END,
            classification_source = 'rule', classification_rule_id = ?, updated_at = ? WHERE id = ?`
        ).run(
          merchantId, change.after.categoryId, Number(change.after.isTransfer),
          Number(change.after.isTransfer), change.ruleId, now, change.transactionId
        );
        db.prepare(
          "UPDATE classification_rules SET match_count = match_count + 1, last_hit_at = ? WHERE id = ?"
        ).run(now, change.ruleId);
        audit(db, "transaction", change.transactionId, "rules_applied", { ruleId: change.ruleId });
      }
    });
    perform();
  }

  return { mode: apply ? "apply" : "preview", options: { onlyUncategorized, overwriteManual, ids }, summary, changes };
}
