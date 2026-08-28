import { randomUUID } from "node:crypto";
import { audit, rowToObject, rowsToObjects } from "../db.js";

const FORMULA_VERSION = "planning-v5";
const allowedAssumptions = new Set([
  "asOfDate", "emergencyCoverageMonths", "emergencyReserveFloorMinor", "emergencyReserveBalanceMinor", "effectiveTaxRateBps",
  "essentialAverageMonths", "generalAverageMonths", "irregularHistoryMonths",
  "obligationHorizonMonths", "investableHorizonYears", "pretaxRetirementMinor",
  "operatingCashBufferBps"
]);

const isoNow = () => new Date().toISOString();
const addMonths = (date, offset) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + offset);
  return value.toISOString().slice(0, 10);
};
const money = (value) => Math.round(Number(value) || 0);
const monthOf = (date) => date.slice(0, 7);
const trailingMonths = (asOf, count) => Array.from({ length: count }, (_, index) => monthOf(addMonths(asOf, index - count + 1)));
const monthIsComplete = (month, asOf) => {
  if (month < monthOf(asOf)) return true;
  if (month > monthOf(asOf)) return false;
  const end = new Date(`${month}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return Number(asOf.slice(8, 10)) >= end.getUTCDate();
};
const projectPartialMonth = (amountMinor, asOf, budgetMinor = 0) => {
  const actual = money(amountMinor);
  const day = Math.max(1, Number(asOf.slice(8, 10)));
  const nextMonth = new Date(`${monthOf(asOf)}-01T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  nextMonth.setUTCDate(0);
  const pace = Math.round(actual * nextMonth.getUTCDate() / day);
  return Math.max(actual, money(budgetMinor), Math.min(actual * 2, pace));
};
const monthlyEstimate = ({ completeAmounts, partialAmount = null, budgetAmounts, asOf }) => {
  const budgetMean = budgetAmounts.length ? Math.round(budgetAmounts.reduce((sum, value) => sum + value, 0) / budgetAmounts.length) : 0;
  const completedMean = completeAmounts.length ? Math.round(completeAmounts.reduce((sum, value) => sum + value, 0) / completeAmounts.length) : 0;
  const projectedPartial = partialAmount == null ? null : projectPartialMonth(partialAmount, asOf, budgetMean);
  if (completeAmounts.length && budgetAmounts.length) {
    const evidenceWeight = completeAmounts.length / (completeAmounts.length + 2);
    const amountMinor = Math.round(completedMean * evidenceWeight + budgetMean * (1 - evidenceWeight));
    return { amountMinor, confidence: completeAmounts.length >= 3 ? "blended" : "provisional", source: `${completeAmounts.length} observed month${completeAmounts.length === 1 ? "" : "s"} blended with budget` };
  }
  if (completeAmounts.length) return { amountMinor: completedMean, confidence: completeAmounts.length >= 3 ? "actual" : "provisional", source: `${completeAmounts.length}-month observed average, annualized` };
  if (projectedPartial != null) return { amountMinor: projectedPartial, confidence: "provisional", source: "partial month projected with a 2× pace cap" };
  if (budgetAmounts.length) return { amountMinor: budgetMean, confidence: "budget", source: `${budgetAmounts.length} budget month${budgetAmounts.length === 1 ? "" : "s"}` };
  return { amountMinor: 0, confidence: "insufficient", source: "no observed months or budget" };
};
const budgetAt = (db, categoryId, month) => db.prepare(
  `SELECT amount_minor FROM budgets WHERE category_id = ? AND effective_from <= ?
   AND (effective_to IS NULL OR effective_to >= ?)
   ORDER BY effective_from DESC, created_at DESC LIMIT 1`
).get(categoryId, month, month);
const planningBalance = (account) => account.type?.toLowerCase() === "credit-card"
  ? -Math.abs(money(account.balanceMinor))
  : money(account.balanceMinor);
const result = (type, amountMinor, formula, inputs, asOfDate) => ({
  resultType: type, amountMinor: money(amountMinor), currency: "USD", formulaName: formula,
  formulaVersion: FORMULA_VERSION, inputReferences: inputs, asOfDate
});

export function getPlanningAssumptions(db) {
  return rowsToObjects(db.prepare("SELECT * FROM planning_assumptions ORDER BY key").all())
    .map((item) => ({ ...item, value: JSON.parse(item.valueJson) }));
}

export function updatePlanningAssumptions(db, input) {
  const now = isoNow();
  const statement = db.prepare("UPDATE planning_assumptions SET value_json = ?, updated_at = ? WHERE key = ?");
  for (const [key, value] of Object.entries(input)) {
    if (!allowedAssumptions.has(key)) continue;
    if (key === "asOfDate" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("As-of date must use YYYY-MM-DD");
    if (key !== "asOfDate" && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error(`${key} must be non-negative`);
    statement.run(JSON.stringify(key === "asOfDate" ? value : Number(value)), now, key);
    audit(db, "planning_assumption", key, "updated", { value });
  }
  return getPlanningAssumptions(db);
}

export function listObligations(db) {
  return rowsToObjects(db.prepare(
    `SELECT o.*, a.name account_name FROM known_obligations o
     LEFT JOIN accounts a ON a.id = o.account_id ORDER BY o.due_date, o.name`
  ).all());
}

export function createObligation(db, input) {
  if (!input.name?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate || "")) throw new Error("Name and due date are required");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw new Error("Amount must use non-negative integer cents");
  const id = randomUUID(), now = isoNow();
  db.prepare(`INSERT INTO known_obligations
    (id, name, due_date, amount_minor, account_id, funded, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.name.trim(), input.dueDate, input.amountMinor, input.accountId || null, Number(Boolean(input.funded)), input.note || null, now, now);
  audit(db, "known_obligation", id, "created", input);
  return rowToObject(db.prepare("SELECT * FROM known_obligations WHERE id = ?").get(id));
}

export function deleteObligation(db, id) {
  if (!db.prepare("SELECT id FROM known_obligations WHERE id = ?").get(id)) throw Object.assign(new Error("Obligation not found"), { statusCode: 404 });
  db.prepare("DELETE FROM known_obligations WHERE id = ?").run(id);
  audit(db, "known_obligation", id, "deleted", {});
  return { id, deleted: true };
}

export function calculatePlan(db) {
  const assumptions = Object.fromEntries(getPlanningAssumptions(db).map((item) => [item.key, item.value]));
  const asOf = assumptions.asOfDate;
  const groups = [
    ["fixed-contractual", assumptions.generalAverageMonths],
    ["essential-variable", assumptions.essentialAverageMonths],
    ["lifestyle-discretionary", assumptions.generalAverageMonths],
    ["irregular-expenses", assumptions.irregularHistoryMonths]
  ];
  const requirementClasses = groups.map(([groupId, months]) => {
    const monthList = trailingMonths(asOf, months);
    const from = `${monthList[0]}-01`;
    const rows = rowsToObjects(db.prepare(`
      WITH activity AS (
        SELECT t.id, t.posted_date, t.amount_minor, t.category_id FROM transactions t
        WHERE t.is_transfer = 0 AND t.excluded = 0 AND t.category_id IS NOT NULL
        UNION ALL
        SELECT t.id, t.posted_date, s.amount_minor, s.category_id FROM transaction_splits s
        JOIN transactions t ON t.id = s.transaction_id WHERE t.is_transfer = 0 AND t.excluded = 0
      )
      SELECT c.id category_id, c.name category_name, c.annual_expected_minor,
        COALESCE(SUM(CASE WHEN a.amount_minor < 0 THEN -a.amount_minor ELSE 0 END), 0) observed_minor,
        COUNT(DISTINCT CASE WHEN a.amount_minor < 0 THEN a.id END) transaction_count
      FROM categories c LEFT JOIN activity a ON a.category_id = c.id AND a.posted_date > ? AND a.posted_date <= ?
      WHERE c.active = 1 AND c.planning_group_id = ? GROUP BY c.id ORDER BY c.name
    `).all(addMonths(from, -1), asOf, groupId));
    const categories = rows.map((row) => {
      if (groupId === "irregular-expenses" && money(row.annualExpectedMinor) > 0) {
        return { ...row, annualMinor: row.annualExpectedMinor, months, actualMonths: 0, budgetMonths: 0, missingMonths: 0, confidence: "explicit", source: "manual annual target" };
      }
      const actualRows = rowsToObjects(db.prepare(`
        WITH activity AS (
          SELECT t.id, t.posted_date, t.amount_minor, t.category_id FROM transactions t
          WHERE t.is_transfer = 0 AND t.excluded = 0 AND t.category_id IS NOT NULL
          UNION ALL
          SELECT t.id, t.posted_date, s.amount_minor, s.category_id FROM transaction_splits s
          JOIN transactions t ON t.id = s.transaction_id WHERE t.is_transfer = 0 AND t.excluded = 0
        )
        SELECT substr(posted_date, 1, 7) month,
          SUM(CASE WHEN amount_minor < 0 THEN -amount_minor ELSE 0 END) amount_minor,
          COUNT(DISTINCT CASE WHEN amount_minor < 0 THEN id END) transaction_count
        FROM activity WHERE category_id = ? AND posted_date >= ? AND posted_date <= ?
        GROUP BY substr(posted_date, 1, 7)
      `).all(row.categoryId, from, asOf)).filter((item) => item.transactionCount > 0);
      const actualByMonth = new Map(actualRows.map((item) => [item.month, money(item.amountMinor)]));
      let actualMonths = 0, budgetMonths = 0, missingMonths = 0;
      const completeAmounts = [], budgetAmounts = [];
      let partialAmount = null;
      for (const month of monthList) {
        if (actualByMonth.has(month)) {
          actualMonths += 1;
          if (monthIsComplete(month, asOf)) completeAmounts.push(actualByMonth.get(month));
          else partialAmount = actualByMonth.get(month);
        } else {
          const budget = budgetAt(db, row.categoryId, month);
          if (budget) {
            budgetAmounts.push(money(budget.amount_minor));
            budgetMonths += 1;
          } else {
            missingMonths += 1;
          }
        }
      }
      const currentBudget = budgetAt(db, row.categoryId, monthOf(asOf));
      if (currentBudget && !budgetAmounts.length) budgetAmounts.push(money(currentBudget.amount_minor));
      if (groupId === "irregular-expenses") {
        const observedYears = new Set(actualRows.map((item) => item.month.slice(0, 4))).size;
        const observedAnnualFloor = observedYears ? Math.round(actualRows.reduce((sum, item) => sum + money(item.amountMinor), 0) / observedYears) : 0;
        const budgetAnnual = budgetAmounts.length ? Math.round(budgetAmounts.reduce((sum, value) => sum + value, 0) / budgetAmounts.length * 12) : 0;
        const annualMinor = Math.max(observedAnnualFloor, budgetAnnual);
        const confidence = observedYears >= 2 ? "actual" : annualMinor ? "provisional" : "insufficient";
        const source = observedAnnualFloor
          ? `${observedYears}-year observed average used as annual floor${money(row.annualExpectedMinor) <= 0 ? "; frequency unconfirmed" : ""}`
          : budgetAnnual ? `${budgetMonths} budget months annualized` : "annual expectation required";
        return { ...row, annualMinor, months, actualMonths, budgetMonths, missingMonths, confidence, source };
      }
      const estimate = monthlyEstimate({ completeAmounts, partialAmount, budgetAmounts, asOf });
      return { ...row, annualMinor: estimate.amountMinor * 12, estimatedMonthlyMinor: estimate.amountMinor, months, actualMonths, completeActualMonths: completeAmounts.length, budgetMonths, missingMonths, confidence: estimate.confidence, source: `${estimate.source}${missingMonths ? `; ${missingMonths} unavailable` : ""}` };
    });
    return { id: groupId, annualMinor: categories.reduce((sum, item) => sum + item.annualMinor, 0), transactionCount: categories.reduce((sum, item) => sum + item.transactionCount, 0), categories };
  });
  const byId = Object.fromEntries(requirementClasses.map((item) => [item.id, item]));
  const committed = byId["fixed-contractual"].annualMinor + byId["essential-variable"].annualMinor;
  const lifestyle = byId["lifestyle-discretionary"].annualMinor;
  const irregular = byId["irregular-expenses"].annualMinor;
  const household = committed + lifestyle + irregular;
  const minimumNet = committed + irregular;
  const gross = (net) => Math.round(net / Math.max(0.01, 1 - assumptions.effectiveTaxRateBps / 10000));
  const incomeMonths = trailingMonths(asOf, 12);
  const incomeCategories = rowsToObjects(db.prepare(`SELECT c.id FROM categories c JOIN planning_groups p ON p.id = c.planning_group_id WHERE c.active = 1 AND p.kind = 'income'`).all());
  let projectedIncome = 0, observedIncome = 0, incomeTransactionCount = 0, incomeActualMonths = 0, incomeCompleteMonths = 0, incomeBudgetMonths = 0, incomeMissingMonths = 0;
  const incomeSources = [];
  for (const category of incomeCategories) {
    const completeAmounts = [], budgetAmounts = [];
    let partialAmount = null;
    for (const month of incomeMonths) {
      const actual = db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) amount_minor, COUNT(*) transaction_count FROM transactions
        WHERE category_id = ? AND is_transfer = 0 AND excluded = 0 AND amount_minor > 0 AND substr(posted_date, 1, 7) = ? AND posted_date <= ?`).get(category.id, month, asOf);
      if (actual.transaction_count) {
        observedIncome += money(actual.amount_minor);
        incomeTransactionCount += actual.transaction_count;
        incomeActualMonths += 1;
        if (monthIsComplete(month, asOf)) { completeAmounts.push(money(actual.amount_minor)); incomeCompleteMonths += 1; }
        else partialAmount = money(actual.amount_minor);
      } else {
        const budget = budgetAt(db, category.id, month);
        if (budget) { budgetAmounts.push(money(budget.amount_minor)); incomeBudgetMonths += 1; }
        else incomeMissingMonths += 1;
      }
    }
    const currentBudget = budgetAt(db, category.id, monthOf(asOf));
    if (currentBudget && !budgetAmounts.length) budgetAmounts.push(money(currentBudget.amount_minor));
    const estimate = monthlyEstimate({ completeAmounts, partialAmount, budgetAmounts, asOf });
    projectedIncome += estimate.amountMinor * 12;
    incomeSources.push(estimate.source);
  }
  const income = { amountMinor: projectedIncome, observedMinor: observedIncome, transactionCount: incomeTransactionCount, actualMonths: incomeActualMonths, completeMonths: incomeCompleteMonths, budgetMonths: incomeBudgetMonths, missingMonths: incomeMissingMonths, sources: incomeSources };
  const operatingFrom = addMonths(asOf, -12);
  const operatingDays = rowsToObjects(db.prepare(`
    WITH activity AS (
      SELECT t.posted_date, t.amount_minor, t.category_id FROM transactions t
      WHERE t.is_transfer = 0 AND t.excluded = 0 AND t.category_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
      UNION ALL
      SELECT t.posted_date, s.amount_minor, s.category_id FROM transaction_splits s
      JOIN transactions t ON t.id = s.transaction_id WHERE t.is_transfer = 0 AND t.excluded = 0
    )
    SELECT a.posted_date, SUM(CASE WHEN a.amount_minor < 0 THEN -a.amount_minor ELSE 0 END) amount_minor
    FROM activity a JOIN categories c ON c.id = a.category_id
    WHERE a.posted_date > ? AND a.posted_date <= ?
      AND c.planning_group_id IN ('fixed-contractual', 'essential-variable', 'lifestyle-discretionary')
    GROUP BY a.posted_date ORDER BY a.posted_date
  `).all(operatingFrom, asOf));
  let operatingTarget = 0, windowStart = 0, windowTotal = 0;
  for (let windowEnd = 0; windowEnd < operatingDays.length; windowEnd += 1) {
    windowTotal += money(operatingDays[windowEnd].amountMinor);
    const endTime = Date.parse(`${operatingDays[windowEnd].postedDate}T00:00:00Z`);
    while (Date.parse(`${operatingDays[windowStart].postedDate}T00:00:00Z`) < endTime - 30 * 86400000) {
      windowTotal -= money(operatingDays[windowStart].amountMinor);
      windowStart += 1;
    }
    operatingTarget = Math.max(operatingTarget, windowTotal);
  }
  const observedOperatingPeak = operatingTarget;
  const plannedMonthlyOrdinary = ["fixed-contractual", "essential-variable", "lifestyle-discretionary"]
    .flatMap((groupId) => byId[groupId].categories)
    .reduce((sum, category) => sum + money(budgetAt(db, category.categoryId, monthOf(asOf))?.amount_minor), 0);
  const budgetOperatingFloor = Math.round(plannedMonthlyOrdinary * (1 + assumptions.operatingCashBufferBps / 10000));
  operatingTarget = Math.max(operatingTarget, budgetOperatingFloor);
  const calculatedEmergencyTarget = Math.round(committed / 12 * assumptions.emergencyCoverageMonths);
  const emergencyTarget = Math.max(calculatedEmergencyTarget, money(assumptions.emergencyReserveFloorMinor));
  const obligationEnd = addMonths(asOf, assumptions.obligationHorizonMonths);
  const obligations = listObligations(db).filter((item) => item.dueDate >= asOf && item.dueDate <= obligationEnd);
  const obligationTarget = obligations.reduce((sum, item) => sum + item.amountMinor, 0);
  const accounts = rowsToObjects(db.prepare("SELECT * FROM accounts ORDER BY name").all())
    .map((account) => ({ ...account, balanceMinor: planningBalance(account) }));
  const role = (needle) => accounts.filter((a) => a.role.toLowerCase().includes(needle)).reduce((sum, a) => sum + money(a.balanceMinor), 0);
  const operatingHeld = role("operating cash");
  const importedEmergencyHeld = role("emergency reserve");
  const manualEmergencyHeld = money(assumptions.emergencyReserveBalanceMinor);
  const emergencyHeld = importedEmergencyHeld + manualEmergencyHeld;
  const obligationHeld = role("known");
  const drawYears = Array.from({ length: 5 }, (_, index) => Number(asOf.slice(0, 4)) - 4 + index);
  const sinkingFunds = rowsToObjects(db.prepare(`SELECT id, name, target_balance_minor, current_balance_minor, annual_expected_minor, next_due_date
    FROM categories WHERE active = 1 AND (cadence = 'irregular' OR planning_group_id = 'irregular-expenses') ORDER BY next_due_date, name`).all())
    .map((item) => {
      const annualDraws = drawYears.map((year) => {
        const draw = db.prepare(`WITH activity AS (
          SELECT t.id, t.posted_date, t.amount_minor, t.category_id FROM transactions t
          WHERE t.is_transfer = 0 AND t.excluded = 0 AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
          UNION ALL
          SELECT t.id, t.posted_date, s.amount_minor, s.category_id FROM transaction_splits s
          JOIN transactions t ON t.id = s.transaction_id WHERE t.is_transfer = 0 AND t.excluded = 0
        ) SELECT COALESCE(SUM(CASE WHEN amount_minor < 0 THEN -amount_minor ELSE 0 END), 0) amount_minor,
          COUNT(DISTINCT CASE WHEN amount_minor < 0 THEN id END) transaction_count
          FROM activity WHERE category_id = ? AND posted_date >= ? AND posted_date <= ?`).get(
          item.id, `${year}-01-01`, year === Number(asOf.slice(0, 4)) ? asOf : `${year}-12-31`
        );
        return { year, amountMinor: money(draw.amount_minor), transactionCount: Number(draw.transaction_count || 0), ytd: year === Number(asOf.slice(0, 4)) };
      });
      return { ...item, targetBalanceMinor: money(item.targetBalanceMinor), currentBalanceMinor: money(item.currentBalanceMinor), shortfallMinor: Math.max(0, money(item.targetBalanceMinor) - money(item.currentBalanceMinor)), heldAs: item.nextDueDate && item.nextDueDate <= addMonths(asOf, assumptions.investableHorizonYears * 12) ? "cash" : "invested", annualDraws, transactionCount: annualDraws.reduce((sum, draw) => sum + draw.transactionCount, 0) };
    });
  const sinkingTarget = sinkingFunds.reduce((sum, item) => sum + item.targetBalanceMinor, 0);
  const sinkingHeld = sinkingFunds.reduce((sum, item) => sum + item.currentBalanceMinor, 0);
  const totalHoldings = accounts.reduce((sum, item) => sum + money(item.balanceMinor), 0) + manualEmergencyHeld;
  const liquidRequirement = operatingTarget + emergencyTarget + obligationTarget;
  const cashHeld = operatingHeld + emergencyHeld + obligationHeld;
  const operatingGap = Math.max(0, operatingTarget - operatingHeld);
  const emergencyGap = Math.max(0, emergencyTarget - emergencyHeld);
  const obligationGap = Math.max(0, obligationTarget - obligationHeld);
  const asOfTime = Date.parse(`${asOf}T00:00:00Z`);
  const annualizedSinkingRequirement = sinkingFunds.reduce((sum, item) => {
    if (!item.shortfallMinor) return sum;
    if (!item.nextDueDate) return sum + item.shortfallMinor;
    const daysUntilDue = Math.max(1, (Date.parse(`${item.nextDueDate}T00:00:00Z`) - asOfTime) / 86400000);
    return sum + Math.round(item.shortfallMinor * Math.min(1, 365 / daysUntilDue));
  }, 0);
  const savingsRequirement = operatingGap + emergencyGap + obligationGap + annualizedSinkingRequirement;
  const comfortableNet = household + savingsRequirement;
  const savingsCapacity = income.amountMinor - household;
  const growthCapital = Math.max(0, totalHoldings - liquidRequirement - sinkingTarget);
  const ref = (type, id, detail) => ({ type, id, detail });
  const transactionRefs = requirementClasses.flatMap((group) => group.categories.filter((item) => item.transactionCount).map((item) => ref("category-transactions", item.categoryId, `${item.transactionCount} records over ${item.months} months`)));
  const assumptionRef = (key) => ref("planning-assumption", key, assumptions[key]);
  const results = {
    householdRequirement: result("household-requirement", household, "sum-requirement-classes", transactionRefs, asOf),
    minimumNetIncome: result("minimum-net-income", minimumNet, "committed-plus-irregular", transactionRefs, asOf),
    minimumGrossIncome: result("minimum-gross-income", gross(minimumNet), "net-divided-by-one-minus-tax-rate", [assumptionRef("effectiveTaxRateBps")], asOf),
    sustainingGrossIncome: result("sustaining-gross-income", gross(household), "net-divided-by-one-minus-tax-rate", [assumptionRef("effectiveTaxRateBps")], asOf),
    comfortableGrossIncome: result("comfortable-gross-income", gross(comfortableNet), "net-plus-derived-savings-divided-by-one-minus-tax-rate", [assumptionRef("effectiveTaxRateBps"), ref("calculated-result", "annual-savings-requirement", savingsRequirement)], asOf),
    operatingCashTarget: result("operating-cash-target", operatingTarget, "greater-of-observed-31-day-peak-or-buffered-monthly-budget", [ref("ordinary-spending", "trailing-12-months", operatingDays.length), ref("monthly-budget", "ordinary-spending", plannedMonthlyOrdinary), assumptionRef("operatingCashBufferBps")], asOf),
    emergencyReserveTarget: result("emergency-reserve-target", emergencyTarget, "greater-of-committed-monthly-times-coverage-or-manual-floor", [assumptionRef("emergencyCoverageMonths"), assumptionRef("emergencyReserveFloorMinor")], asOf),
    liquidRequirement: result("liquid-requirement", liquidRequirement, "operating-plus-emergency-plus-obligations", obligations.map((o) => ref("known-obligation", o.id, o.amountMinor)), asOf),
    savingsCapacity: result("savings-capacity", savingsCapacity, "blended-net-income-minus-household-requirement", [ref("income-transactions", "trailing-12-months", income.transactionCount), ref("income-budgets", "trailing-12-months", income.budgetMonths)], asOf),
    annualSavingsRequirement: result("annual-savings-requirement", savingsRequirement, "cash-gaps-plus-deadline-paced-sinking-shortfalls", [ref("cash-gap", "operating", operatingGap), ref("cash-gap", "emergency", emergencyGap), ref("cash-gap", "known-obligations", obligationGap), ref("sinking-shortfalls", "annualized", annualizedSinkingRequirement)], asOf),
    growthCapital: result("growth-capital", growthCapital, "holdings-minus-liquid-requirement-minus-sinking-targets", accounts.map((a) => ref("account-balance", a.id, a.balanceAsOf)), asOf)
  };
  return {
    formulaVersion: FORMULA_VERSION, asOfDate: asOf, assumptions, requirementClasses,
    totals: { committedMinor: committed, lifestyleMinor: lifestyle, irregularMinor: irregular, householdMinor: household },
    income: { annualNetMinor: income.amountMinor, projectedAnnualNetMinor: income.amountMinor, observedNetMinor: income.observedMinor, transactionCount: income.transactionCount, actualMonths: income.actualMonths, completeMonths: income.completeMonths, budgetMonths: income.budgetMonths, missingMonths: income.missingMonths, confidence: income.completeMonths >= 3 || income.budgetMonths ? "supported" : income.actualMonths ? "provisional" : "insufficient", source: income.sources.join("; ") || "no income evidence", pretaxRetirementMinor: assumptions.pretaxRetirementMinor },
    cash: { operatingTargetMinor: operatingTarget, observedPeakMinor: observedOperatingPeak, plannedMonthlyOrdinaryMinor: plannedMonthlyOrdinary, budgetOperatingFloorMinor: budgetOperatingFloor, operatingHeldMinor: operatingHeld, calculatedEmergencyTargetMinor: calculatedEmergencyTarget, emergencyTargetMinor: emergencyTarget, emergencyHeldMinor: emergencyHeld, importedEmergencyHeldMinor: importedEmergencyHeld, manualEmergencyHeldMinor: manualEmergencyHeld, obligationTargetMinor: obligationTarget, obligationHeldMinor: obligationHeld, liquidRequirementMinor: liquidRequirement, cashHeldMinor: cashHeld },
    obligations, sinkingFunds, accounts,
    capital: { savingsRequirementMinor: savingsRequirement, savingsCapacityMinor: savingsCapacity, totalHoldingsMinor: totalHoldings, sinkingTargetMinor: sinkingTarget, sinkingHeldMinor: sinkingHeld, growthCapitalMinor: growthCapital },
    results
  };
}
