# Testing Domain Knowledge

Domain-specific knowledge for agents working on test strategy, test implementation, and quality assurance. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing test code.

## Test Strategy

- **Test pyramid**: Many unit tests (fast, isolated), fewer integration tests (component boundaries), fewest e2e tests (full system). This gives fast feedback and good coverage.
- **Test trophy**: Variant favoring integration tests as the primary layer (more confidence per test, closer to real usage). Choose based on your system's complexity and feedback speed needs.
- **Risk-based prioritization**: Write tests for the riskiest code first — business-critical paths, complex logic, areas with history of bugs. Not all code needs the same test coverage.
- **Shift left**: Find bugs earlier. Static analysis catches type errors at build time. Unit tests catch logic errors before integration. Integration tests catch boundary errors before deployment.

## Unit Test Patterns

- **Arrange-Act-Assert**: Structure every test: set up inputs and state (Arrange), execute the code under test (Act), verify the result (Assert). One Act per test.
- **Test behavior, not implementation**: Test what the function does (returns correct output, throws on invalid input), not how it does it (which internal methods it calls). Implementation-coupled tests break on refactoring.
- **Descriptive names**: Test names should describe the scenario and expected outcome. `it('returns 404 when user does not exist')` not `it('test getUserById')`.
- **Edge cases**: Test boundary values (0, -1, empty, null, max), error paths (invalid input, timeout, permission denied), and state transitions.

## Integration Test Boundaries

- **Test real interactions**: Integration tests verify that components work together — API routes with middleware, services with databases, modules with external APIs.
- **Use real dependencies when practical**: Real databases (testcontainers, in-memory SQLite), real HTTP servers (supertest), real queues. Mocks at integration level defeat the purpose.
- **Isolate from external services**: Use test doubles for third-party APIs, payment providers, and email services. External services are unreliable in tests.
- **Database setup/teardown**: Use transactions that rollback after each test, or truncate tables between tests. Shared state between integration tests causes flaky failures.

## E2E Test Design

- **Critical paths only**: E2E tests are slow and fragile. Reserve them for the most important user journeys (signup, purchase, core workflow).
- **Stable selectors**: Use data-testid attributes or ARIA roles for element selection. Never select by CSS class, tag name, or DOM structure — these change with styling.
- **Retry and wait strategies**: Use explicit waits for elements and network requests. Avoid fixed sleeps. Flaky E2E tests erode confidence.
- **Visual regression**: Capture screenshots at key states. Compare against baselines to catch unintended visual changes.

## Test Doubles

- **Mocks**: Verify that specific methods were called with specific arguments. Use for testing interactions (e.g., verify the logger was called on error).
- **Stubs**: Return predetermined values. Use to control the behavior of dependencies (e.g., stub the database to return a specific user).
- **Fakes**: Lightweight working implementations (in-memory database, fake HTTP server). Use when you need realistic behavior without the full dependency.
- **Spies**: Wrap real implementations and record calls. Use when you need real behavior but also want to verify interactions.
- **Minimal mocking**: Mock only what you must. Over-mocking tests the mocks, not the code. Prefer fakes for complex dependencies.

## Test Data Management

- **Deterministic**: Use fixed, predictable test data. Random data makes failures hard to reproduce. If randomness is needed, use seeded random generators.
- **Isolated**: Each test creates its own data and cleans up after itself. Tests should not depend on data created by other tests.
- **Factory functions**: Use builder/factory patterns to create test data with sensible defaults. Override only the fields relevant to each test.
- **Realistic but minimal**: Test data should be realistic enough to exercise real behavior, but minimal enough to keep tests readable.

## Coverage Analysis

- **Line vs branch coverage**: Branch coverage (every if/else path executed) is more valuable than line coverage. A function can have 100% line coverage but miss an important else branch.
- **Coverage as a guide, not a goal**: Use coverage to find untested areas, not as a success metric. 100% coverage does not mean 100% correctness.
- **Uncoverable code**: Some code (error handlers for extremely unlikely scenarios, platform-specific branches) may not be practically testable. Accept this and document why.
- **Coverage ratchet**: Prevent coverage from decreasing. New code should be tested. Require coverage on changed lines in CI.

## Flaky Test Diagnosis

- **Common causes**: Shared mutable state, time-dependent logic, network calls, race conditions, test order dependencies, uncontrolled async operations.
- **Isolation test**: Run the flaky test alone — does it pass? Run it in a different order — does it fail? This identifies shared-state issues.
- **Timestamp sensitivity**: Tests that depend on the current time flake around midnight, timezone boundaries, and daylight saving transitions. Use injectable clocks.
- **Fix, do not skip**: Skipped tests are forgotten tests. If a test is flaky, fix the root cause. If you cannot fix it immediately, quarantine it with a tracking issue.
