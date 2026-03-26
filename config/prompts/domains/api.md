# API Domain Knowledge

Domain-specific knowledge for agents working on API design, implementation, and integration. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing APIs.

## REST Conventions

- **HTTP methods**: GET (read), POST (create), PUT (full replace), PATCH (partial update), DELETE (remove). Use them semantically.
- **Resource naming**: Use plural nouns (`/users`, `/orders`). Nest for relationships (`/users/123/orders`). Avoid verbs in paths.
- **Status codes**: 200 (OK), 201 (Created), 204 (No Content), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 409 (Conflict), 422 (Unprocessable Entity), 429 (Too Many Requests), 500 (Internal Server Error).
- **Idempotency**: GET, PUT, DELETE should be idempotent. POST is not idempotent by default — use idempotency keys for critical operations (payments, order creation).

## Versioning

- **URL versioning** (`/v1/users`): Simple, explicit, easy to route. Preferred for public APIs.
- **Header versioning** (`Accept: application/vnd.api+json; version=1`): Cleaner URLs, harder to test casually.
- **Deprecation policy**: Announce deprecation in response headers (`Deprecation: true`, `Sunset: <date>`). Maintain old versions for a documented period.

## Error Response Format

Use a consistent error envelope:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": [
      { "field": "email", "issue": "Invalid email format" }
    ]
  }
}
```
- Machine-readable `code` for programmatic handling.
- Human-readable `message` for debugging.
- `details` array for field-level validation errors.

## Pagination

- **Cursor-based**: Preferred for large or frequently-changing datasets. Use opaque cursor tokens. `?cursor=abc123&limit=20`.
- **Offset-based**: Simpler but problematic with inserts/deletes between pages. `?offset=40&limit=20`.
- **Response shape**: Include `next_cursor` or `has_more` flag. Include `total_count` only when cheap to compute.

## Rate Limiting

- **Communicate limits**: Return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.
- **429 responses**: Include `Retry-After` header with seconds until the client can retry.
- **Tiered limits**: Different limits for authenticated vs unauthenticated, free vs paid.
- **Granularity**: Per-user, per-API-key, per-endpoint, or per-IP depending on use case.

## Schema-First Design

- **OpenAPI/Swagger**: Define API contracts before implementation. Generate client SDKs and documentation from the spec.
- **Contract testing**: Validate that implementations match the spec. Use tools like Prism or Dredd.
- **Schema validation**: Validate request bodies against JSON Schema at the API boundary. Reject malformed requests early.
- **Documentation generation**: Keep API docs auto-generated from the spec. Manual docs drift from reality.

## Backward Compatibility

- **Additive changes are safe**: Adding new optional fields, new endpoints, or new enum values is generally backward-compatible.
- **Removal breaks clients**: Removing fields, endpoints, or changing response shapes breaks existing consumers.
- **Type changes break clients**: Changing a field from string to number, or from single value to array, is a breaking change.
- **Migration strategy**: When breaking changes are necessary, version the API and provide a migration guide with a deprecation timeline.
