/**
 * Stands in for the `server-only` package under Vitest.
 *
 * `server-only` throws unless it is resolved with the `react-server` export
 * condition, which only Next.js sets. Aliasing it here lets server modules be
 * unit-tested directly while keeping the real guard in the app build.
 */
export {}
