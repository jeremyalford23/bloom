# Bloom

Bloom is a private, single-household financial decision engine. It turns imported financial activity into a traceable view of household requirements and, eventually, a prioritized action plan.

## Run locally

Bloom currently has no third-party runtime dependencies.

```bash
npm start
```

The server listens on `0.0.0.0:8712` by default. Override the port with `PORT`.

Available endpoints:

- `/` — temporary project index
- `/api/health` — service readiness
- `/api/version` — current API version
- `/api/domain` — Phase 0 domain definitions

## Verify

```bash
npm test
```

The current architecture and financial conventions are documented in [`docs/architecture.md`](docs/architecture.md) and [`docs/financial-conventions.md`](docs/financial-conventions.md).

