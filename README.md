# The Ledger — Poker PNL (Cloudflare Workers edition)

Same app, same features, same Turso database as before — just running on
Cloudflare Workers instead of Render, so there's no sleep/cold-start at all.

## What changed vs. the Render version
- Backend is now a [Hono](https://hono.dev) app (`src/index.js`, `src/db.js`)
  instead of Express, because Cloudflare Workers don't run a normal Node
  process — Hono is the standard lightweight router for that environment.
- The frontend (`public/`) is byte-for-byte the same HTML/CSS/JS as before.
- The database is still Turso — same database, same data, if you already
  created one for the Render deploy you can reuse it here.

## One-time setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.dev.vars.example` to `.dev.vars` and fill in your Turso URL/token
   (same values as before — `turso db show <name> --url` and
   `turso db tokens create <name>`).
3. Log in to Cloudflare (opens a browser window):
   ```
   npx wrangler login
   ```

## Local development
```
npm run dev
```
Opens on `http://localhost:8787`. This talks to your real Turso database
(Workers can't use a local SQLite file the way Node can), so be aware local
testing writes to the same data your friends see — consider a second Turso
database (`turso db create poker-pnl-dev`) for local experiments if you'd
rather keep that separate.

## Deploy
```
npm run deploy
```
This is the only step needed to go live or to push updates — no separate
hosting dashboard, no git connection required (though you can still keep
your code in GitHub for backup/history if you like).

The first deploy will print your live URL, something like:
```
https://poker-pnl.<your-subdomain>.workers.dev
```

To rename it before anyone sees it, change `"name"` in `wrangler.jsonc` to
something obscure (e.g. `chipstack-9f2k`) *before* your first `npm run deploy`
— like Render, the name becomes part of the permanent URL.

## Setting the production secrets
`.dev.vars` only applies locally. For the deployed Worker, set the same two
values as secrets (encrypted, not visible in the dashboard once set):
```
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
```
Each command will prompt you to paste the value, then deploy (or redeploy)
as usual.

## Why this fixes the cold-start issue
Cloudflare Workers don't "sleep" the way Render's free web services do —
there's no idle instance to spin down and back up. Every request runs in a
V8 isolate that's already warm across Cloudflare's edge network, so response
times stay in the tens-of-milliseconds range whether the last request was
5 seconds or 5 days ago. No card required for this tier, and the free
allowance (100,000 requests/day) is far more than a friend-group ledger will
ever use.
