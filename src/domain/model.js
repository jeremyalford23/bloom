import { PLANNING_GROUPS, SEED_CATEGORIES } from "./taxonomy.js";

const field = (type, required = true, description = "") => ({ type, required, description });

export const DOMAIN_MODELS = Object.freeze({
  Account: {
    purpose: "A household financial account and its current planning role.",
    fields: {
      id: field("id"), name: field("string"), institutionId: field("id", false),
      type: field("enum"), currency: field("currency"), includedInPlan: field("boolean"),
      balanceMinor: field("integer", false), balanceAsOf: field("date", false)
    }
  },
  ImportRun: {
    purpose: "One auditable attempt to import one or more source files.",
    fields: {
      id: field("id"), startedAt: field("instant"), completedAt: field("instant", false),
      status: field("enum"), fileCount: field("integer"), mappingVersionIds: field("id[]")
    }
  },
  RawImportRecord: {
    purpose: "An immutable source row retained exactly as received.",
    fields: {
      id: field("id"), importRunId: field("id"), accountId: field("id"),
      sourceFileName: field("string"), sourceRowNumber: field("integer"),
      sourcePayload: field("object"), contentFingerprint: field("string"), createdAt: field("instant")
    }
  },
  Transaction: {
    purpose: "Canonical account activity independent of institution format.",
    fields: {
      id: field("id"), accountId: field("id"), rawImportRecordIds: field("id[]"),
      postedDate: field("date"), amountMinor: field("integer"), currency: field("currency"),
      originalDescription: field("string"), merchantId: field("id", false),
      categoryId: field("id", false), status: field("enum"), notes: field("string", false),
      transferPairId: field("id", false), createdAt: field("instant"), updatedAt: field("instant")
    }
  },
  TransactionSplit: {
    purpose: "A categorized allocation whose siblings exactly equal the parent transaction.",
    fields: {
      id: field("id"), transactionId: field("id"), categoryId: field("id"),
      amountMinor: field("integer"), notes: field("string", false)
    }
  },
  Merchant: {
    purpose: "A normalized counterparty name shared across transactions.",
    fields: { id: field("id"), name: field("string"), archivedAt: field("instant", false) }
  },
  Category: {
    purpose: "A transaction classification mapped to one financial planning purpose.",
    fields: { id: field("id"), name: field("string"), planningGroupId: field("id"), active: field("boolean") }
  },
  ClassificationRule: {
    purpose: "A versioned, ordered rule for repeatable transaction normalization.",
    fields: {
      id: field("id"), priority: field("integer"), enabled: field("boolean"),
      conditions: field("object"), actions: field("object"), version: field("integer"),
      createdAt: field("instant"), updatedAt: field("instant")
    }
  },
  BudgetTarget: {
    purpose: "A category target for a calendar period.",
    fields: {
      id: field("id"), categoryId: field("id"), periodType: field("enum"),
      periodStart: field("date"), amountMinor: field("integer"), currency: field("currency")
    }
  },
  PlanningAssumption: {
    purpose: "An explicit, versioned input used where observed data is insufficient.",
    fields: {
      id: field("id"), key: field("string"), value: field("unknown"), unit: field("string"),
      effectiveFrom: field("date"), supersedesId: field("id", false), rationale: field("string")
    }
  },
  CalculationResult: {
    purpose: "A deterministic financial result with complete input provenance.",
    fields: {
      id: field("id"), resultType: field("string"), periodStart: field("date"),
      periodEnd: field("date"), amountMinor: field("integer"), currency: field("currency"),
      formulaName: field("string"), formulaVersion: field("string"),
      inputReferences: field("reference[]"), calculatedAt: field("instant")
    }
  }
});

export const DOMAIN_DEFINITION = Object.freeze({
  household: { tenancy: "single-household", defaultCurrency: "USD", defaultTimezone: "America/Chicago" },
  planningGroups: PLANNING_GROUPS,
  seedCategories: SEED_CATEGORIES,
  models: DOMAIN_MODELS
});

