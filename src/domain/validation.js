import { PLANNING_GROUPS, SEED_CATEGORIES } from "./taxonomy.js";

export function validateTaxonomy(groups = PLANNING_GROUPS, categories = SEED_CATEGORIES) {
  const errors = [];
  const groupIds = new Set();
  const categoryIds = new Set();

  for (const group of groups) {
    if (groupIds.has(group.id)) errors.push(`Duplicate planning group id: ${group.id}`);
    groupIds.add(group.id);
  }

  for (const category of categories) {
    if (categoryIds.has(category.id)) errors.push(`Duplicate category id: ${category.id}`);
    categoryIds.add(category.id);
    if (!groupIds.has(category.planningGroupId)) {
      errors.push(`Category ${category.id} references unknown planning group ${category.planningGroupId}`);
    }
  }
  return errors;
}

export function validateSplitTotal(transactionAmountMinor, splits) {
  if (!Number.isSafeInteger(transactionAmountMinor)) return false;
  if (!Array.isArray(splits) || splits.length === 0) return false;
  return splits.every(({ amountMinor }) => Number.isSafeInteger(amountMinor))
    && splits.reduce((total, split) => total + split.amountMinor, 0) === transactionAmountMinor;
}

