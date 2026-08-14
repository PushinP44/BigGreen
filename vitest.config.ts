import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      // See tests/support/empty.ts — lets server modules be tested directly.
      'server-only': fileURLToPath(new URL('./tests/support/empty.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Migration + RLS tests each spin up their own PGlite instance. Running
    // those files in parallel inside one process is fine (PGlite is in-memory
    // and isolated per instance), but give them room.
    testTimeout: 30_000,
    // `createTestDb()` runs in `beforeEach`, which `testTimeout` does not cover
    // — only `hookTimeout` does. Left at the 10s default, enough concurrent
    // PGlite instances spinning up at once (one per db test file) can exceed it
    // under real machine load, failing `beforeEach` itself rather than a test.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // The domain layer is the part that must never break (PLAN §10).
      // Everything else is deliberately not held to this bar.
      include: ['lib/domain/**/*.ts'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
})
