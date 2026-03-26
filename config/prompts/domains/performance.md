# Performance Domain Knowledge

Domain-specific knowledge for agents working on performance optimization, profiling, and scalability. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing performance-sensitive systems.

## Profiling Methodology

- **Flame graphs**: Visualize CPU time spent in each function. Identify hot paths where optimization has the most impact. Wide bars indicate expensive functions.
- **Heap snapshots**: Capture memory allocation at a point in time. Compare snapshots to find memory leaks (objects that grow between snapshots but should not).
- **CPU profiling**: Measure where CPU time is spent during a representative workload. Profile realistic scenarios, not synthetic microbenchmarks.
- **I/O profiling**: Measure network calls, database queries, and file I/O. In most web applications, I/O dominates CPU in total request time.
- **Production profiling**: Profile in production (or production-like environments) when possible. Development profiles miss contention, garbage collection pressure, and realistic data sizes.

## Benchmarking

- **Warm-up period**: Run several iterations before measuring to warm JIT compilers, caches, and connection pools. Cold-start measurements are misleading for steady-state performance.
- **Statistical significance**: Run enough iterations to get stable results. Report median and percentiles (p50, p95, p99), not just averages. Averages hide tail latency.
- **Controlled environment**: Minimize variability — same hardware, same data, same load. Disable unrelated background processes during benchmarks.
- **Comparative benchmarks**: Always benchmark against a baseline. "200ms" means nothing without context. "200ms vs 800ms before the change" is meaningful.
- **Regression detection**: Integrate benchmarks into CI. Alert when performance degrades beyond a threshold between commits.

## Caching Strategies

- **Redis / Memcached**: Use for frequently-read, infrequently-written data (session data, computed results, rate limit counters). Set appropriate TTL to prevent stale data.
- **CDN caching**: Cache static assets (images, CSS, JS) at the edge. Use content hashes in filenames for cache busting. Set long `Cache-Control` headers.
- **In-memory caching**: Use for hot data within a single process (config, lookup tables). Be aware of memory limits and cache invalidation.
- **Cache invalidation**: The hardest problem. Prefer TTL-based expiry for simplicity. Use event-driven invalidation only when staleness is unacceptable.
- **Cache stampede**: When a cache entry expires and many requests hit the backend simultaneously. Mitigate with stale-while-revalidate, locking, or probabilistic early expiry.

## Load Testing

- **Realistic scenarios**: Model actual user behavior — mix of read/write operations, realistic data sizes, varied endpoints. Single-endpoint tests miss interaction effects.
- **Ramp-up**: Gradually increase load to find the inflection point where latency spikes or errors begin. Step functions (100 users, then 200, then 500) help identify thresholds.
- **Sustained load**: Run tests for extended periods (30+ minutes) to find memory leaks, connection pool exhaustion, and garbage collection pauses that only appear over time.
- **Break point**: Push past expected load to find the breaking point. Understand the failure mode — does the system degrade gracefully or crash?

## Resource Monitoring

- **CPU**: Monitor utilization and saturation. High CPU is fine if latency is acceptable. CPU saturation (run queue depth) indicates the system needs more compute.
- **Memory**: Monitor heap usage, RSS, and garbage collection frequency/duration. Growing memory without stabilization indicates a leak.
- **Disk I/O**: Monitor read/write throughput and IOPS. Disk latency spikes often indicate contention or hardware degradation.
- **Network**: Monitor bandwidth, connection count, and error rates. Connection exhaustion is a common cause of intermittent failures.
- **Application metrics**: Request latency (p50/p95/p99), error rate, throughput (requests/sec), queue depth, active connections.

## Optimization Techniques

- **Measure first**: Never optimize without profiling data. Intuition about bottlenecks is frequently wrong.
- **Algorithmic improvements**: O(n^2) to O(n log n) is worth more than any micro-optimization. Fix the algorithm before tuning the constants.
- **Batch operations**: Replace N individual calls with one batch call. Applies to database queries, API requests, and file operations.
- **Connection reuse**: Reuse HTTP connections (keep-alive), database connections (pooling), and gRPC channels. Connection setup is expensive.
- **Async processing**: Move non-critical work to background queues (email sending, report generation, webhook delivery). Return fast, process later.
- **Lazy evaluation**: Do not compute or load data that may not be needed. Load on first access, not at initialization.
