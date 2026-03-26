# Backend Domain Knowledge

Domain-specific knowledge for agents working on server-side logic, APIs, and service architecture. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing backend systems.

## Server Architecture

- **Middleware pipeline**: Use middleware for cross-cutting concerns (logging, auth, rate limiting, error handling). Order matters — auth before business logic, error handler last.
- **Service layers**: Separate routing (HTTP concerns) from business logic (domain rules) from data access (database queries). Each layer should be testable independently.
- **Dependency injection**: Pass dependencies into functions/classes rather than importing singletons. Makes testing and swapping implementations straightforward.
- **Configuration**: Load config from environment variables, not hardcoded values. Validate config at startup — fail fast if required values are missing.

## Business Logic Organization

- **Domain modules**: Group business logic by domain (users, orders, payments), not by technical layer (controllers, services, repositories).
- **Pure functions**: Keep business rules in pure functions where possible. Pure functions are easy to test and reason about.
- **Side effects at the boundary**: Push I/O (database calls, API calls, file reads) to the edges of your logic. Core business rules should not know about databases or HTTP.
- **Validation at entry points**: Validate all input at the API boundary before it reaches business logic. Business logic should assume valid input.

## Error Handling Patterns

- **Typed errors**: Use error types/classes to distinguish between expected errors (validation, not found, conflict) and unexpected errors (database down, null pointer).
- **Fail fast**: Check preconditions early and return errors immediately. Avoid deeply nested conditionals.
- **Error propagation**: Let errors bubble up to a centralized handler rather than catching and logging at every level. Catch only when you can meaningfully handle or enrich the error.
- **User-facing errors**: Never expose stack traces, SQL queries, or internal paths to clients. Map internal errors to safe, informative error responses.
- **Logging**: Log errors with context (request ID, user ID, operation). Structured logging (JSON) is easier to search and alert on.

## Connection Pooling

- **Pool database connections**: Creating connections per request is expensive. Use a connection pool with appropriate min/max settings.
- **Connection limits**: Set pool size based on your database's connection limits divided by the number of application instances.
- **Health checks**: Validate connections before use (test on borrow). Remove stale connections from the pool.
- **Timeouts**: Set connection timeout, query timeout, and idle timeout. A query that runs forever blocks a connection and can cascade into pool exhaustion.

## Async and Concurrency

- **Non-blocking I/O**: Use async/await for I/O-bound operations (database, HTTP, file system). Do not block the event loop.
- **Concurrent requests**: Process independent operations concurrently (`Promise.all`, goroutines, async tasks). Sequential processing of independent operations wastes time.
- **Backpressure**: When consuming streams or queues, apply backpressure to prevent memory exhaustion. Do not buffer unbounded data.
- **Race conditions**: When multiple requests modify shared state, use transactions, locks, or optimistic concurrency control. Test concurrent scenarios explicitly.

## Monitoring Hooks

- **Request logging**: Log every request with method, path, status code, duration, and request ID. This is your primary debugging tool in production.
- **Health endpoints**: Implement `/health` (basic alive check) and `/ready` (dependencies healthy). Used by load balancers and orchestrators.
- **Metrics**: Expose request count, latency percentiles, error rate, and queue depth. Use Prometheus, StatsD, or equivalent.
- **Distributed tracing**: Propagate trace context (W3C Trace Context) across service boundaries. Trace IDs in logs enable cross-service debugging.

## Input Validation at Boundaries

- **Validate everything**: Request body, query parameters, path parameters, headers. Treat all input as untrusted.
- **Schema validation**: Use JSON Schema, Zod, Joi, or equivalent to validate request shapes. Reject malformed requests before they reach business logic.
- **Type coercion**: Be explicit about type coercion. `"123"` as a string vs `123` as a number causes subtle bugs.
- **Size limits**: Set max request body size, max header size, and max URL length. Unbounded input is a denial-of-service vector.
