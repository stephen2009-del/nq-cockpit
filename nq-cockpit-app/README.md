# NQ Cockpit — Deployment Guide

This is a full-stack trading discipline app: pre-trade checklist, journal, and
analytics dashboard, backed by a real PostgreSQL database. Everything below can
be done by clicking through websites — no command line required.

## What you're deploying

- A Next.js app (frontend + API routes)
- A PostgreSQL database (via Prisma)

## Step 1 — Put this code on GitHub

1. Go to https://github.com and create a free account if you don't have one.
2. Click the **+** icon (top right) → **New repository**.
3. Name it something like `nq-cockpit`. Keep it **Private** if you don't want
   your trading data structure public. Click **Create repository**.
4. On the new repo page, click **uploading an existing file** (or **Add file
   → Upload files**).
5. Drag this entire project folder's contents into the browser window
   (everything except `node_modules`, which doesn't exist yet anyway).
6. Scroll down and click **Commit changes**.

## Step 2 — Create your Railway project

1. Go to https://railway.com and sign up (you can use your GitHub account to
   sign in — one less password to manage).
2. Click **New Project** → **Deploy from GitHub repo**.
3. Authorize Railway to access your GitHub account if prompted, then select
   the `nq-cockpit` repo you just created.
4. Railway will detect it's a Next.js app and start building automatically.
   Don't worry if the first build fails — it's missing the database
   connection, which we add next.

## Step 3 — Add the database

1. In your Railway project (same dashboard, same project — not a new one),
   click **New** → **Database** → **Add PostgreSQL**.
2. Railway spins up a Postgres instance and gives it its own set of
   credentials automatically.

## Step 4 — Connect the app to the database

1. Click on your web service (the Next.js app, not the database).
2. Go to the **Variables** tab.
3. Click **New Variable** → **Add Reference** → select the Postgres service →
   choose `DATABASE_URL`. This links them without you ever typing a password.
4. Railway will automatically redeploy. This time the build should succeed,
   and on first start it will run the database migration automatically
   (creates your tables and seeds your default 7 checklist rules).

## Step 5 — Get your link

1. Click on your web service → **Settings** tab → **Networking**.
2. Click **Generate Domain**. Railway gives you a free
   `yourapp.up.railway.app` address instantly.
3. Open it — that's your live cockpit.

## Ongoing costs

With one web service + one small Postgres database and light personal usage,
expect roughly **$10–15/month** on Railway's usage-based pricing — comfortably
inside a $10–30/month budget.

## Making changes later

Whenever you (or I) want to update the app: edit the files, upload the changed
files to the same GitHub repo (Add file → Upload files again, or use GitHub's
web editor by pressing `.` on the repo page), and Railway will automatically
redeploy within a minute or two. No CLI needed.

## Local file reference

- `prisma/schema.prisma` — your database tables (Rules, Trades, Settings)
- `app/page.tsx` — the whole UI
- `app/api/*/route.ts` — the backend endpoints the UI talks to
- `app/globals.css` — the cockpit visual theme
