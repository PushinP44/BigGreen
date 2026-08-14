# Deploying Big Green

Supabase hosts the database, auth and storage. It does **not** host a Next.js
app — there is no Node/SSR runtime there — so the app itself runs on Vercel.

## 1. Vercel

```bash
pnpm dlx vercel link
pnpm dlx vercel --prod
```

Use `pnpm dlx`, not `npx` — this repo pins `devEngines.packageManager` to pnpm, and npm's own
`npx` refuses to run anything here at all (`EBADDEVENGINES`) rather than silently using the
wrong package manager.

Or connect the GitHub repo at vercel.com, which sidesteps this entirely — Vercel detects pnpm
from the lockfile and never invokes your local npm. No build configuration is needed; Next.js is
detected.

### Environment variables

Set these in Vercel → Settings → Environment Variables, for **Production** and
**Preview**. Values are in your local `.env.local`.

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Safe in the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Safe in the browser — RLS is what protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only.** Bypasses RLS. Never prefix `NEXT_PUBLIC_` |
| `DATABASE_URL` | Supabase → Settings → Database. Percent-encode the password |
| `EMAIL_INGEST_SECRET` | Shared with the Apps Script |
| `EMAIL_INGEST_USER_ID` | Which account emailed transactions are filed against |
| `APP_TIMEZONE` | `Asia/Hong_Kong` |
| `APP_BASE_CURRENCY` | `HKD` |

Use the **transaction pooler on port 6543** for `DATABASE_URL` on Vercel rather
than the session pooler on 5432. Serverless functions open and drop connections
constantly, and session mode holds a real backend connection per client — the
pooler's limit is reached far faster than you would expect.

## 2. Supabase auth redirect URLs

Supabase → Authentication → URL Configuration:

- **Site URL**: `https://your-app.vercel.app`
- **Redirect URLs**: add `https://your-app.vercel.app/auth/callback`

Without this the sign-in link bounces to `localhost` and fails in a way that
looks like the link is broken.

## 3. First sign-in and claiming your data

Everything created before authentication existed belongs to a fixed development
uuid. Signing in creates a *new* account, which correctly sees none of it.

```bash
pnpm db:claim you@example.com
```

Run once, after signing in for the first time. It moves accounts, transactions,
settings and card terms across, and refuses rather than merges if the target
account already has data of its own.

## 4. Gmail Apps Script

Once deployed, set `INGEST_URL` in the Apps Script's Script Properties to
`https://your-app.vercel.app/api/ingest/email`, with `INGEST_SECRET` matching
`EMAIL_INGEST_SECRET`. Then run `pollOnce` by hand once to grant permissions,
and `installTrigger` to make it unattended.

## Before this is public

The app works for one person today. Several things assume that person is you:

- **Per-user ingest secrets.** One global secret currently writes to one
  configured account. Any holder of it could write to anyone — fine while the
  only holder is you, unacceptable once it is not.
- **Base currency and timezone are constants.** `HKD` and `Asia/Hong_Kong` are
  compiled in, and the currency set is exactly HKD/USD/THB.
- **Parsers are tuned to Hong Kong banks**, and the email onboarding asks every
  user to create their own Apps Script project. Almost nobody will. A Chrome
  extension reading Gmail in the browser is the natural answer, and is the
  strongest argument for the extension plan.
- **Rate limiting** on the ingest endpoint is not implemented.
- **Data protection.** Holding other people's financial records is a different
  obligation to holding your own, and the "it is just my tool" reasoning behind
  several earlier decisions stops applying.
