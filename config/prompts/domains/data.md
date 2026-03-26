# Data Domain Knowledge

Domain-specific knowledge for agents working on data storage, schema design, migrations, and query optimization. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing data systems.

## Schema Design

- **Normalization trade-offs**: Normalize to reduce duplication and ensure consistency (3NF for transactional data). Denormalize for read performance when query patterns justify it.
- **Primary keys**: Use UUIDs or ULIDs for distributed systems. Auto-increment integers for simpler setups. Never expose internal IDs without considering enumeration attacks.
- **Nullable fields**: Be intentional about nullability. Nullable fields complicate queries and application logic. Default to NOT NULL with sensible defaults.
- **Naming conventions**: Use consistent naming (snake_case for SQL columns is conventional). Name foreign keys as `<referenced_table>_id`. Use singular table names or plural — but be consistent.

## Migrations

- **Idempotent**: Migrations should be safe to run multiple times. Use `IF NOT EXISTS`, `IF EXISTS` guards.
- **Reversible**: Every migration should have a rollback plan. Write both up and down migrations.
- **Zero-downtime**: For production databases, avoid migrations that lock tables for extended periods. Use techniques like: add column (nullable) -> backfill -> add constraint -> remove old column.
- **Ordering**: Migrations must be applied in order. Use sequential timestamps or version numbers.
- **Data migrations**: Separate schema migrations from data migrations. Data migrations can be slow and should be resumable.

## Indexing Strategy

- **Index for query patterns**: Create indexes based on actual query patterns, not speculation. Use EXPLAIN to verify index usage.
- **Composite indexes**: Column order matters. Put high-selectivity columns first. The index on `(status, created_at)` serves queries filtering by status, but not queries filtering only by created_at.
- **Covering indexes**: Include all columns needed by a query in the index to avoid table lookups.
- **Index maintenance**: Indexes slow down writes. Remove unused indexes. Monitor index bloat in long-running databases.

## Query Optimization

- **N+1 problem**: Loading a list then querying each item individually. Fix with joins, subqueries, or batch loading (e.g., `WHERE id IN (...)`).
- **EXPLAIN analysis**: Use `EXPLAIN ANALYZE` to understand query plans. Look for sequential scans on large tables, nested loops, and missing index usage.
- **Pagination**: Use keyset pagination (`WHERE id > last_id ORDER BY id LIMIT N`) instead of `OFFSET` for large datasets. OFFSET scans and discards rows.
- **Query complexity**: Avoid deeply nested subqueries. Refactor into CTEs or joins for readability and sometimes performance.

## Transactions and Isolation

- **ACID guarantees**: Understand when you need full ACID and when eventual consistency is acceptable.
- **Isolation levels**: READ COMMITTED is the safe default. Use SERIALIZABLE for financial transactions. Understand phantom reads, dirty reads, and non-repeatable reads.
- **Transaction scope**: Keep transactions short. Long transactions hold locks and block other operations.
- **Optimistic locking**: Use version columns or timestamps to detect concurrent modifications without holding locks.

## ORMs vs Raw SQL

- **ORMs**: Good for CRUD operations, schema management, and reducing boilerplate. Risk: generating inefficient queries or hiding database behavior.
- **Raw SQL**: Use for complex queries, performance-critical paths, and database-specific features. Risk: SQL injection if not parameterized.
- **Query builders**: Middle ground. Provide composability without full ORM overhead. Good for dynamic query construction.
- **Always parameterize**: Whether using ORM, query builder, or raw SQL, never concatenate user input into queries.

## Data Integrity

- **Foreign keys**: Use foreign key constraints to enforce referential integrity. Cascade deletes carefully — understand what will be removed.
- **Check constraints**: Use database-level check constraints for business rules (e.g., `price >= 0`, `status IN ('active', 'inactive')`).
- **Unique constraints**: Enforce uniqueness at the database level, not just the application level. Application-level checks have race conditions.
- **Validate at boundaries**: Validate data at the API boundary before it reaches the database. Database constraints are the safety net, not the primary validation.
