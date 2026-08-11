import { defineConfig } from 'drizzle-kit'

/**
 * Generated SQL lands in `supabase/migrations/` and is the deployed artefact.
 * Never hand-edit a generated file — add hand-written SQL (RLS policies,
 * constraint triggers, views) as its own numbered migration alongside.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/db/schema.ts',
  out: './supabase/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
})
