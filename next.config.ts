import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  /**
   * PGlite ships a WASM/FS bundle it loads with `fs.readFile(new URL(...))`.
   * Bundling it rewrites that path and the load fails at runtime, so it has to
   * stay a real Node module. Same for postgres.js, which does its own dynamic
   * requires.
   */
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
}

export default nextConfig
