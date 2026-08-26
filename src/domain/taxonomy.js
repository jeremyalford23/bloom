export const PLANNING_GROUPS = Object.freeze([
  { id: "fixed-contractual", name: "Fixed / Contractual", kind: "expense", description: "Committed costs that are difficult to change quickly." },
  { id: "essential-variable", name: "Essential Variable", kind: "expense", description: "Necessary costs whose amounts vary with use or prices." },
  { id: "lifestyle-discretionary", name: "Lifestyle / Discretionary", kind: "expense", description: "Optional spending that supports the household's chosen lifestyle." },
  { id: "irregular-expenses", name: "Irregular Expenses", kind: "expense", description: "Expected costs that do not occur in a stable monthly pattern." },
  { id: "savings-investing", name: "Savings / Investing", kind: "allocation", description: "Contributions that build reserves or long-term capital." },
  { id: "transfers", name: "Transfers", kind: "transfer", description: "Movement between household accounts, excluded from income and spending." },
  { id: "income", name: "Income", kind: "income", description: "Resources earned or received by the household." }
]);

export const SEED_CATEGORIES = Object.freeze([
  ["mortgage", "Mortgage", "fixed-contractual"],
  ["electricity", "Electricity", "essential-variable"],
  ["natural-gas", "Natural Gas", "essential-variable"],
  ["water", "Water", "essential-variable"],
  ["groceries", "Groceries", "essential-variable"],
  ["restaurants", "Restaurants", "lifestyle-discretionary"],
  ["auto-insurance", "Auto Insurance", "fixed-contractual"],
  ["homeowners-insurance", "Homeowners Insurance", "fixed-contractual"],
  ["property-taxes", "Property Taxes", "irregular-expenses"],
  ["medical", "Medical", "irregular-expenses"],
  ["entertainment", "Entertainment", "lifestyle-discretionary"],
  ["clothing", "Clothing", "lifestyle-discretionary"],
  ["home-maintenance", "Home Maintenance", "irregular-expenses"],
  ["travel", "Travel", "lifestyle-discretionary"],
  ["income", "Income", "income"],
  ["paycheck", "Paycheck", "income"],
  ["account-transfer", "Account Transfer", "transfers"],
  ["retirement-contribution", "Retirement Contribution", "savings-investing"]
].map(([id, name, planningGroupId]) => Object.freeze({ id, name, planningGroupId, active: true })));
