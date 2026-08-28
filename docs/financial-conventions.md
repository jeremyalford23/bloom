# Financial conventions

These conventions are normative for Bloom's domain and calculations.

## Money

- Store monetary values as integer minor units, never floating-point currency.
- Store an ISO 4217 currency code with every independent monetary value.
- The initial household currency is USD; mixed-currency aggregation is unsupported until an explicit conversion policy exists.
- Round only at defined calculation boundaries. Allocation remainders are assigned deterministically so splits always equal the transaction total.

## Transaction signs

- Positive amounts increase the account balance; negative amounts decrease it.
- Income is normally positive; purchases are normally negative.
- Financial meaning comes from category and transfer status, not sign alone.
- Refunds and reversals retain links to related activity when known.

## Time

- Calendar dates use ISO `YYYY-MM-DD` strings and represent the institution's posted date without timezone conversion.
- Instants use UTC ISO 8601 timestamps.
- The household timezone is an explicit setting; the initial default is `America/Chicago`.
- Reporting periods follow the calendar unless an explicit fiscal-calendar setting is introduced.

## Sparse-history estimates

- A month without imported evidence is unavailable, not a zero-value month, and is excluded from observed-average denominators.
- Budget averages disclose the number of observed category-months supporting the result.
- Planning estimates annualize the mean of available completed months. When budgets exist, one or two observed months are blended with the budget as a prior; observed evidence receives more weight as it accumulates.
- Activity in an incomplete current month is provisional. It is projected using the applicable budget or a pace estimate capped at twice the observed amount.
- Irregular activity uses an explicit annual expectation when available. Without one, observed spending is a provisional annual floor and its frequency remains unconfirmed.
- Income projections distinguish the amount actually observed from the annualized planning estimate and disclose provisional confidence.

## Identity and imports

- Domain records use opaque stable IDs.
- Raw rows retain their exact source payload and a content fingerprint.
- Deduplication uses institution/account identifiers, available source IDs, dates, amounts, descriptions, and import provenance.
- Suspected duplicates require review; exact re-imports may be suppressed automatically.

## Classification

- A transaction category describes what the activity was.
- A planning group describes its household financial purpose.
- Each active transaction category belongs to exactly one planning group.
- Split allocations must sum exactly to the parent transaction amount.
- Transfers are excluded from spending, income, and savings-rate calculations unless a formula explicitly states otherwise.

## Data precedence

When inputs disagree, Bloom uses this order while preserving all evidence:

1. Explicit user correction
2. Confirmed transfer or split treatment
3. Persistent classification rule
4. Institution mapping
5. Unclassified imported value

Derived plan outputs never overwrite their inputs.
