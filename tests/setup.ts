// Test preload — set default env vars for test isolation
process.env.NODE_ENV ??= "test";
process.env.HIVE_TEST ??= "1";
process.env.LOG_LEVEL ??= "silent";
