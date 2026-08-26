import { defineConfig } from "vitest/config";

/**
 * DB-backed suites share one Postgres/Redis (docker-compose 15432/16379) and
 * truncate between tests — parallel FILES would race each other's truncates,
 * so files run sequentially; tests within a file are sequential already.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
