# Bloom

Bloom is a private, single-household financial decision engine. It turns imported financial activity into a traceable view of household requirements and, eventually, a prioritized action plan.

## Run locally

Bloom currently has no third-party runtime dependencies.

```bash
npm start
```

The server listens on `0.0.0.0:3001` by default. Override the port with `PORT`.

Available endpoints:

- `/` — temporary project index
- `/api/health` — service readiness
- `/api/version` — current API version
- `/api/domain` — Phase 0 domain definitions

Phase 1 uses Node's built-in SQLite support and stores household data in
`data/bloom.db`. Set `BLOOM_DB_PATH` to use another location.

## Verify

```bash
npm run check
```

Phase 1 is ready to test through the browser: create an account, import one or
more CSVs, map their columns, preview and commit the run, then review or edit
the resulting transactions. Importing the same activity again must report it
as duplicate without creating another transaction.

The current architecture and financial conventions are documented in [`docs/architecture.md`](docs/architecture.md) and [`docs/financial-conventions.md`](docs/financial-conventions.md).
