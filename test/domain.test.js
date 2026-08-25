import test from "node:test";
import assert from "node:assert/strict";
import { DOMAIN_DEFINITION, DOMAIN_MODELS } from "../src/domain/model.js";
import { PLANNING_GROUPS, SEED_CATEGORIES } from "../src/domain/taxonomy.js";
import { validateSplitTotal, validateTaxonomy } from "../src/domain/validation.js";

test("seed taxonomy is internally valid", () => assert.deepEqual(validateTaxonomy(), []));

test("every category maps to exactly one known planning group", () => {
  const groupIds = new Set(PLANNING_GROUPS.map(({ id }) => id));
  assert.ok(SEED_CATEGORIES.length > 0);
  for (const category of SEED_CATEGORIES) assert.ok(groupIds.has(category.planningGroupId));
});

test("taxonomy validator reports duplicate and missing references", () => {
  const errors = validateTaxonomy(
    [{ id: "known" }, { id: "known" }],
    [{ id: "duplicate", planningGroupId: "known" }, { id: "duplicate", planningGroupId: "missing" }]
  );
  assert.equal(errors.length, 3);
});

test("transaction splits must sum exactly in integer minor units", () => {
  assert.equal(validateSplitTotal(-1000, [{ amountMinor: -725 }, { amountMinor: -275 }]), true);
  assert.equal(validateSplitTotal(-1000, [{ amountMinor: -725 }, { amountMinor: -274 }]), false);
  assert.equal(validateSplitTotal(-10.5, [{ amountMinor: -10.5 }]), false);
});

test("calculation results carry required traceability fields", () => {
  const fields = DOMAIN_MODELS.CalculationResult.fields;
  for (const name of ["formulaName", "formulaVersion", "inputReferences", "calculatedAt"]) {
    assert.equal(fields[name].required, true);
  }
});

test("domain defaults capture initial household conventions", () => {
  assert.deepEqual(DOMAIN_DEFINITION.household, {
    tenancy: "single-household", defaultCurrency: "USD", defaultTimezone: "America/Chicago"
  });
});

