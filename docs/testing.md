# Testing Cynosure

Cynosure uses a layered test suite. Keep a test as close to the code as practical, while keeping tests that cross module or process boundaries in the repository-level test areas.

## Test layout

- `apps/*/src/**/*.test.ts`: fast unit and component tests. Colocation keeps a component and its contract easy to change together.
- `apps/server/tests/integration/**/*.integration.test.ts`: tests that use real adapters such as SQLite, LanceDB, and Fastify route injection. Every test must own an isolated temporary data directory and clean it up.
- `tests/e2e/**/*.spec.ts`: Playwright journeys through the running web application and API. These cover only critical user outcomes rather than duplicating lower-level assertions.
- `apps/*/src/test/`: shared test setup and test-only helpers, not test cases.

Use behavior-based names. A test should state what the user or caller observes, not the internal method it happens to exercise.

## Commands

```bash
pnpm test                 # unit, integration, and web component tests
pnpm test:unit            # server unit tests
pnpm test:integration     # server integration tests
pnpm test:web             # Vue component and router tests
pnpm test:typecheck       # type-check test code as well as application code
pnpm test:coverage        # HTML, text, and LCOV reports under coverage/
pnpm test:e2e             # production build plus Chromium journeys
pnpm test:e2e:ui          # interactive Playwright runner during development
```

Install the browser once on a new development machine with:

```bash
pnpm exec playwright install chromium
```

## Isolation and reliability

- Unit tests must not use the network, real credentials, a developer's data directory, or wall-clock delays.
- Integration tests should prefer real local dependencies and temporary storage. Mock only external provider boundaries whose behavior is outside this repository.
- E2E tests start dedicated servers on ports `3199` and `5183` and use `.tmp/e2e-data`; they never reuse a developer server or profile.
- Avoid fixed sleeps. Wait for a visible outcome, response, event, or persisted state.
- Assert public behavior and accessibility roles instead of CSS implementation details.
- A bug fix should include the smallest test that reproduces the failure at the layer where its root cause lives. Add an E2E regression only when the failure depends on the complete journey.

## Coverage policy

Coverage is evidence, not the objective. The initial reports establish a transparent baseline but intentionally do not impose a low global threshold that could become a permanent target. New and materially changed business logic should receive branch and failure-path tests. Raise enforced per-package thresholds once the important boundaries—agent execution, provider failures, persistence, memory retrieval, backup/restore, and desktop lifecycle—have meaningful coverage. Thresholds should only move upward.

Generated coverage, Playwright reports, videos, traces, temporary databases, and test results are ignored by Git.
