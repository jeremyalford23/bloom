import { randomUUID } from "node:crypto";
import { audit, rowToObject, rowsToObjects } from "../db.js";

function validMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) throw new Error("Month must use YYYY-MM");
  const number = Number(month.slice(5));
  if (number < 1 || number > 12) throw new Error("Month must use YYYY-MM");
  return month;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month, offset) {
  const [year, number] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, number - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}

const ACTIVITY_CTE = `
  WITH activity AS (
    SELECT t.id transaction_id, t.posted_date, t.amount_minor, t.category_id,
      t.merchant_id, m.name merchant_name, t.original_description
    FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id
    WHERE t.is_transfer = 0 AND t.excluded = 0 AND t.category_id IS NOT NULL
    UNION ALL
    SELECT t.id transaction_id, t.posted_date, s.amount_minor, s.category_id,
      t.merchant_id, m.name merchant_name, t.original_description
    FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
    LEFT JOIN merchants m ON m.id = t.merchant_id
    WHERE t.is_transfer = 0 AND t.excluded = 0
  )
`;

function budgetAt(db, categoryId, month) {
  return db.prepare(
    `SELECT * FROM budgets WHERE category_id = ? AND effective_from <= ?
     AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC, created_at DESC LIMIT 1`
  ).get(categoryId, month, month);
}

export function budgetOverview(db, requestedMonth = currentMonth()) {
  const month = validMonth(requestedMonth);
  const settings = getBudgetSettings(db);
  const averageWindow = Math.max(1, Number(settings.averageWindow) || 12);
  const averageFrom = shiftMonth(month, -averageWindow + 1) + "-01";
  const averageTo = shiftMonth(month, 1) + "-01";
  const categories = rowsToObjects(db.prepare(
    ACTIVITY_CTE + `
    SELECT c.id, c.name, c.cadence, c.planning_group_id, p.name planning_group_name, p.kind,
      COALESCE(SUM(CASE WHEN substr(a.posted_date, 1, 7) = ? AND ((p.kind = 'income' AND a.amount_minor > 0) OR (p.kind <> 'income' AND a.amount_minor < 0)) THEN ABS(a.amount_minor) ELSE 0 END), 0) actual_minor,
      COALESCE(SUM(CASE WHEN a.posted_date >= ? AND a.posted_date < ? AND ((p.kind = 'income' AND a.amount_minor > 0) OR (p.kind <> 'income' AND a.amount_minor < 0)) THEN ABS(a.amount_minor) ELSE 0 END), 0) history_minor,
      COUNT(DISTINCT CASE WHEN a.posted_date >= ? AND a.posted_date < ? AND ((p.kind = 'income' AND a.amount_minor > 0) OR (p.kind <> 'income' AND a.amount_minor < 0)) THEN substr(a.posted_date, 1, 7) END) history_month_count,
      COUNT(DISTINCT CASE WHEN substr(a.posted_date, 1, 7) = ? THEN a.transaction_id END) transaction_count
    FROM categories c JOIN planning_groups p ON p.id = c.planning_group_id
    LEFT JOIN activity a ON a.category_id = c.id
    WHERE c.active = 1 GROUP BY c.id ORDER BY p.name, c.name`
  ).all(month, averageFrom, averageTo, averageFrom, averageTo, month));

  for (const category of categories) {
    const budget = budgetAt(db, category.id, month);
    category.budgetId = budget?.id ?? null;
    category.budgetMinor = budget?.amount_minor ?? 0;
    category.averageWindow = averageWindow;
    category.observedMonthCount = category.historyMonthCount;
    category.averageMinor = category.historyMonthCount ? Math.round(category.historyMinor / category.historyMonthCount) : 0;
    category.average12Minor = category.averageMinor;
    category.deltaMinor = category.actualMinor - category.budgetMinor;
  }

  const groups = [];
  for (const category of categories) {
    let group = groups.find((item) => item.id === category.planningGroupId);
    if (!group) {
      group = { id: category.planningGroupId, name: category.planningGroupName, kind: category.kind, categories: [], budgetMinor: 0, actualMinor: 0, averageMinor: 0, average12Minor: 0, averageWindow, observedMonthCount: 0 };
      groups.push(group);
    }
    group.categories.push(category);
    group.budgetMinor += category.budgetMinor;
    group.actualMinor += category.actualMinor;
    group.averageMinor += category.averageMinor;
    group.average12Minor = group.averageMinor;
    group.observedMonthCount = Math.max(group.observedMonthCount, category.observedMonthCount);
  }

  const transactionSummary = rowToObject(db.prepare(
    `SELECT
      COALESCE(SUM(CASE WHEN t.is_transfer = 1 THEN ABS(t.amount_minor) ELSE 0 END), 0) transfer_minor,
      COALESCE(SUM(CASE WHEN p.kind = 'income' AND t.amount_minor > 0 AND t.is_transfer = 0 THEN t.amount_minor ELSE 0 END), 0) income_minor,
      COALESCE(SUM(CASE WHEN p.kind = 'allocation' AND t.amount_minor < 0 AND t.is_transfer = 0 THEN -t.amount_minor ELSE 0 END), 0) saved_minor
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN planning_groups p ON p.id = c.planning_group_id
     WHERE substr(t.posted_date, 1, 7) = ?`
  ).get(month));
  const spendingGroups = groups.filter((group) => group.kind === "expense" && group.id !== "irregular-expenses");
  const spendingMinor = spendingGroups.reduce((total, group) => total + group.actualMinor, 0);
  const spendingBudgetMinor = spendingGroups.reduce((total, group) => total + group.budgetMinor, 0);
  const incomeGroups = groups.filter((group) => group.kind === "income");
  const incomeBudgetMinor = incomeGroups.reduce((total, group) => total + group.budgetMinor, 0);
  return {
    month,
    averageWindow,
    observedMonthCount: Math.max(0, ...categories.map((category) => category.observedMonthCount)),
    previousMonth: shiftMonth(month, -1),
    nextMonth: shiftMonth(month, 1),
    groups,
    summary: {
      spendingMinor,
      spendingBudgetMinor,
      spendingDeltaMinor: spendingMinor - spendingBudgetMinor,
      incomeMinor: transactionSummary.incomeMinor,
      incomeBudgetMinor,
      incomeDeltaMinor: transactionSummary.incomeMinor - incomeBudgetMinor,
      savedMinor: transactionSummary.savedMinor,
      transferMinor: Math.round(transactionSummary.transferMinor / 2)
    }
  };
}

export function categoryBudgetDetail(db, categoryId, requestedMonth = currentMonth()) {
  const month = validMonth(requestedMonth);
  const category = rowToObject(db.prepare(
    `SELECT c.*, p.name planning_group_name, p.kind FROM categories c
     JOIN planning_groups p ON p.id = c.planning_group_id WHERE c.id = ?`
  ).get(categoryId));
  if (!category) throw Object.assign(new Error("Category not found"), { statusCode: 404 });
  const months = Array.from({ length: 12 }, (_, index) => shiftMonth(month, index - 11));
  const historyRows = db.prepare(
    ACTIVITY_CTE + ` SELECT substr(posted_date, 1, 7) month,
      COALESCE(SUM(CASE WHEN (? = 'income' AND amount_minor > 0) OR (? <> 'income' AND amount_minor < 0) THEN ABS(amount_minor) ELSE 0 END), 0) actual_minor,
      COUNT(DISTINCT transaction_id) transaction_count
      FROM activity WHERE category_id = ? AND posted_date >= ? AND posted_date < ?
      GROUP BY substr(posted_date, 1, 7)`
  ).all(category.kind, category.kind, categoryId, months[0] + "-01", shiftMonth(month, 1) + "-01");
  const actualByMonth = new Map(historyRows.map((row) => [row.month, row]));
  category.history = months.map((historyMonth) => {
    const actual = actualByMonth.get(historyMonth);
    const budget = budgetAt(db, categoryId, historyMonth);
    return {
      month: historyMonth,
      covered: Boolean(actual?.transaction_count),
      actualMinor: actual?.actual_minor ?? 0,
      transactionCount: actual?.transaction_count ?? 0,
      budgetMinor: budget?.amount_minor ?? 0,
      budgetId: budget?.id ?? null
    };
  });
  const average = (count) => {
    const comparable = category.history.slice(-count).filter((item) => item.covered);
    return {
      amountMinor: comparable.length ? Math.round(comparable.reduce((sum, item) => sum + item.actualMinor, 0) / comparable.length) : 0,
      observedMonthCount: comparable.length,
      requestedMonthCount: count
    };
  };
  const three = average(3), six = average(6), twelve = average(12);
  category.averages = {
    threeMonthMinor: three.amountMinor, sixMonthMinor: six.amountMinor, twelveMonthMinor: twelve.amountMinor,
    threeMonthCount: three.observedMonthCount, sixMonthCount: six.observedMonthCount, twelveMonthCount: twelve.observedMonthCount
  };
  category.current = category.history.at(-1);
  const comparableMonths = category.history.filter((item) => item.covered && item.budgetMinor > 0);
  category.comparableMonthCount = comparableMonths.length;
  category.offPlanMonths = comparableMonths.filter((item) => (
    category.kind === "income" ? item.actualMinor < item.budgetMinor : item.actualMinor > item.budgetMinor
  )).length;
  category.overBudgetMonths = category.offPlanMonths;
  category.budgets = rowsToObjects(db.prepare(
    "SELECT * FROM budgets WHERE category_id = ? ORDER BY effective_from DESC, created_at DESC"
  ).all(categoryId));
  category.transactions = rowsToObjects(db.prepare(
    ACTIVITY_CTE + ` SELECT transaction_id id, posted_date, merchant_name, original_description,
      ABS(amount_minor) amount_minor FROM activity WHERE category_id = ? AND substr(posted_date, 1, 7) = ?
      AND ((? = 'income' AND amount_minor > 0) OR (? <> 'income' AND amount_minor < 0))
      ORDER BY ABS(amount_minor) DESC LIMIT 50`
  ).all(categoryId, month, category.kind, category.kind));
  return category;
}

export function createBudget(db, input) {
  if (!input.categoryId) throw new Error("Category is required");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw new Error("Budget amount must be a non-negative number of cents");
  const effectiveFrom = validMonth(input.effectiveFrom || currentMonth());
  const effectiveTo = input.effectiveTo ? validMonth(input.effectiveTo) : null;
  if (effectiveTo && effectiveTo < effectiveFrom) throw new Error("Budget end cannot precede its start");
  if (!db.prepare("SELECT id FROM categories WHERE id = ?").get(input.categoryId)) throw new Error("Category not found");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO budgets (id, category_id, amount_minor, cadence, effective_from, effective_to, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.categoryId, input.amountMinor, input.cadence || "monthly", effectiveFrom, effectiveTo, input.note || null, now, now);
  audit(db, "budget", id, "created", input);
  return rowToObject(db.prepare("SELECT * FROM budgets WHERE id = ?").get(id));
}

export function deleteBudget(db, id) {
  const existing = db.prepare("SELECT * FROM budgets WHERE id = ?").get(id);
  if (!existing) throw Object.assign(new Error("Budget not found"), { statusCode: 404 });
  db.prepare("DELETE FROM budgets WHERE id = ?").run(id);
  audit(db, "budget", id, "deleted", { categoryId: existing.category_id, amountMinor: existing.amount_minor });
  return { id, deleted: true };
}

export function deleteIrregularBudget(db, id) {
  const category = db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
  if (!category) throw Object.assign(new Error("Irregular budget not found"), { statusCode: 404 });
  if (category.cadence !== "irregular" && category.planning_group_id !== "irregular-expenses") {
    throw Object.assign(new Error("Category is not an irregular budget"), { statusCode: 400 });
  }
  db.transaction(() => {
    db.prepare("DELETE FROM budgets WHERE category_id = ?").run(id);
    db.prepare("UPDATE categories SET active = 0 WHERE id = ?").run(id);
    audit(db, "category", id, "deactivated", { name: category.name, reason: "irregular budget deleted" });
  })();
  return { id, deleted: true, historyRetained: true };
}

export function getBudgetSettings(db) {
  return Object.fromEntries(db.prepare("SELECT key, value_json FROM budget_settings").all().map((row) => [row.key, JSON.parse(row.value_json)]));
}

export function updateBudgetSettings(db, input) {
  const allowed = new Set(["period", "rollover", "averageWindow", "annualView"]);
  const statement = db.prepare(
    `INSERT INTO budget_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  );
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    if (key === "averageWindow" && (!Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 12)) {
      throw new Error("Average window must be between 1 and 12 months");
    }
    statement.run(key, JSON.stringify(key === "averageWindow" ? Number(value) : value), now);
  }
  return getBudgetSettings(db);
}

export function recurringExpenses(db) {
  const detected = rowsToObjects(db.prepare(
    `SELECT t.merchant_id, m.name merchant_name, t.category_id, c.name category_name,
      COUNT(*) hit_count, COUNT(DISTINCT substr(t.posted_date, 1, 7)) month_count,
      ROUND(AVG(ABS(t.amount_minor))) average_minor, MIN(t.posted_date) first_date, MAX(t.posted_date) last_date,
      MIN(ABS(t.amount_minor)) minimum_minor, MAX(ABS(t.amount_minor)) maximum_minor
     FROM transactions t JOIN merchants m ON m.id = t.merchant_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.amount_minor < 0 AND t.is_transfer = 0 AND t.excluded = 0
     GROUP BY t.merchant_id HAVING COUNT(*) >= 1 ORDER BY month_count DESC, hit_count DESC`
  ).all());
  const decisions = rowsToObjects(db.prepare(
    `SELECT r.*, c.name category_name FROM recurring_items r
     LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.next_due_date, r.merchant_name`
  ).all());
  const decisionMap = new Map(decisions.map((item) => [item.merchantId, item]));
  const candidates = detected.map((item) => {
    const decision = decisionMap.get(item.merchantId);
    const variance = item.averageMinor ? Math.round(((item.maximumMinor - item.minimumMinor) / item.averageMinor) * 100) : 0;
    const confidence = item.monthCount >= 3 && variance <= 10 ? "high" : item.hitCount >= 2 ? "low" : "provisional";
    const suggestedCadence = item.monthCount >= 2 && item.hitCount === item.monthCount ? "monthly" : "unknown";
    return { ...item, variancePercent: variance, confidence, suggestedCadence, decision: decision?.state ?? "review" };
  });
  return {
    candidates: candidates.filter((item) => item.decision === "review"),
    confirmed: decisions.filter((item) => item.state === "confirmed"),
    dismissed: decisions.filter((item) => item.state === "dismissed")
  };
}

export function decideRecurring(db, input) {
  if (!input.merchantName || !input.state) throw new Error("Merchant and decision are required");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO recurring_items (id, merchant_id, merchant_name, category_id, amount_minor, cadence, next_due_date, state, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'detected', ?, ?)
     ON CONFLICT(merchant_name, cadence) DO UPDATE SET category_id = excluded.category_id,
       amount_minor = excluded.amount_minor, next_due_date = excluded.next_due_date,
       state = excluded.state, updated_at = excluded.updated_at`
  ).run(id, input.merchantId || null, input.merchantName, input.categoryId || null, input.amountMinor || 0, input.cadence || "monthly", input.nextDueDate || null, input.state, now, now);
  return recurringExpenses(db);
}

export function irregularExpenses(db, year = new Date().getUTCFullYear()) {
  const categories = rowsToObjects(db.prepare(
    ACTIVITY_CTE + ` SELECT c.*, p.name planning_group_name,
      COALESCE(SUM(CASE WHEN substr(a.posted_date, 1, 4) = ? AND a.amount_minor < 0 THEN -a.amount_minor ELSE 0 END), 0) spent_year_minor
     FROM categories c JOIN planning_groups p ON p.id = c.planning_group_id
     LEFT JOIN activity a ON a.category_id = c.id
     WHERE c.active = 1 AND (c.cadence = 'irregular' OR c.planning_group_id = 'irregular-expenses')
     GROUP BY c.id ORDER BY c.name`
  ).all(String(year)));
  return {
    year,
    categories,
    summary: {
      targetMinor: categories.reduce((sum, item) => sum + Number(item.targetBalanceMinor || 0), 0),
      heldMinor: categories.reduce((sum, item) => sum + Number(item.currentBalanceMinor || 0), 0),
      expectedMinor: categories.reduce((sum, item) => sum + Number(item.annualExpectedMinor || 0), 0),
      spentMinor: categories.reduce((sum, item) => sum + Number(item.spentYearMinor || 0), 0)
    }
  };
}
