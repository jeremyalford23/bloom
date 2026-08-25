# Bloom architecture

## Product boundary

Bloom serves one household and remains independent from Cistern. CSV imports are the system's initial data-entry boundary; paid account aggregation, multi-tenancy, billing, and public registration are out of scope.

## Layered model

Data flows in one direction:

1. **Raw imports** preserve the source file, row values, institution mapping, and import metadata.
2. **Normalized transactions** represent activity in a canonical, institution-independent form.
3. **Rules** normalize merchants and assign categories or transfer treatment.
4. **Budget model** combines category targets with actual transaction activity.
5. **Planning model** derives household requirements from budgets, activity, balances, and explicit assumptions.
6. **Action engine** compares calculated targets with current state and prioritizes gaps.
7. **Presentation** explains results and links them to their supporting inputs.

Dependencies may point down this list, never upward. Financial formulas belong in pure domain modules rather than HTTP handlers or UI components.

## Source-of-truth rules

- Raw imported values are immutable. Corrections update normalized records without overwriting source evidence.
- Derived values record the input IDs, assumption IDs, formula version, and calculation time used to produce them.
- A repeated import of the same source activity must not create another normalized transaction.
- Manual values are used only when activity cannot reasonably provide the answer and are visibly labeled as assumptions.
- Transfers move value between household accounts and do not count as spending or income.

## Initial bounded contexts

| Context | Owns | Does not own |
| --- | --- | --- |
| Imports | Files, mappings, source rows, import runs | Categorization decisions |
| Ledger | Accounts, normalized transactions, splits, transfers | Budgets or plan targets |
| Classification | Merchants, categories, planning groups, rules | Source rows |
| Budgeting | Period targets, actuals, irregular schedules | Transaction mutation |
| Planning | Assumptions, requirements, reserves, sinking funds | UI state |
| Actions | Gaps, priority policy, recommendations | Financial calculations |

## Traceable calculation contract

Every future calculated result must carry a stable result type and period, monetary value and currency, formula name and version, references to all contributing inputs, and its calculation time. Given identical versioned inputs, a calculation must return identical output.

## Phase boundaries

Phase 0 defines the language, invariants, and seams. It intentionally does not include persistence, authentication, CSV parsing, budgeting formulas, or plan recommendations. Those features build on these contracts in subsequent phases.

