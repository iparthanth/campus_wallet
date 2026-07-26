# Deploying Campus Wallet

> **Two different deployments live in this file.** Most of it describes a free-tier **demo**
> deployment for showing the project. A real PUC pilot is [§A](#a--production-deployment-puc)
> and has non-negotiable requirements the demo path does not.

---

## A · Production deployment (PUC)

### A.1 Wallet mode — the one setting that must be right

Leave `WALLET_MODE` **unset**. It defaults to `zero_float`, which is the only lawful mode:
the university never holds student balances (Payment and Settlement Systems Act 2024
s.15(1) — see [PUC-HANDOVER.md](PUC-HANDOVER.md) §2).

Setting `WALLET_MODE=closed_loop` with `NODE_ENV=production` makes the API **refuse to
start**, with an error citing the statute. There is no override. If a deploy fails with
`REFUSING TO START`, the fix is to remove the variable, never to work around it.

### A.2 Required environment

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | PostgreSQL connection string (keep `?sslmode=require`) |
| `JWT_SECRET` | ≥ 32 chars, generated — `openssl rand -base64 48`. The API refuses to boot on anything shorter. |
| `CORS_ORIGINS` | the frontend's exact origin |
| `PUBLIC_API_URL` · `PUBLIC_APP_URL` | real public URLs — the gateway must be able to reach the callback |
| `WALLET_MODE` | **leave unset** |
| `SSL_STORE_ID` · `SSL_STORE_PASSWORD` | live SSLCommerz credentials, once PUC holds a merchant account. Left unset, the public sandbox is used — never collect real money on it. |
| `SMS_API_KEY` · `SMS_SENDER_ID` | leave unset to use the console provider (development only) |

### A.3 Do not run the seed

`npm run seed` **truncates every table** and creates demo accounts with a published
password. It is a development convenience. Running it against a live PUC database destroys
real transaction records. Migrations (`npm run migrate`) are what production needs, and the
start command already runs them.

### A.4 Schedule the nightly audit

The audit is what turns "the books should balance" into evidence that they did, dated and
recorded. It is not optional for a system handling university money.

```bash
cd api && npm run audit          # audits yesterday
cd api && npm run audit 2026-07-25   # or a specific business date
```

Exit codes are meant for a scheduler:

| Exit | Meaning | Action |
|---|---|---|
| `0` | PASS, or WARN | none — WARN is deliberately 0 so routine ageing does not train people to ignore the alert |
| `1` | **FAIL** — the books do not reconcile | page someone; investigate before trading resumes |
| `2` | could not run (database down, etc.) | fix the job; this is **not** a passing audit |

Treat 2 as distinct from 0. A job that never ran is not a job that passed.

Run it once daily after the acquirer's settlement file is expected. On a host with cron:

```cron
30 2 * * *  cd /srv/campus-wallet/api && /usr/bin/npm run audit >> /var/log/cw-audit.log 2>&1
```

On Render, use a **Cron Job** service with the same command.

### A.5 Before the first taka

Acquirer onboarding, EIIN, board resolution, bank account — none of these are deployment
steps and none can be done in code. They are set out in [PUC-HANDOVER.md](PUC-HANDOVER.md)
§5. Until an outlet has acquirer-issued credentials it cannot trade, and the software
enforces that rather than letting it fail at the counter.

---

## The fast path — one repo connection (recommended)

`render.yaml` is a **complete Render Blueprint**: it provisions the PostgreSQL database,
the API, and the static frontend together, and wires them to each other automatically.

1. Sign up at [render.com](https://render.com) (free, no card) and connect your GitHub.
2. **New → Blueprint** → pick `iparthanth/campus_wallet`. Render reads `render.yaml` and
   shows the three services it will create. Click **Apply**.
3. Wait ~5 minutes. Render creates the database, runs migrations + seed, and publishes the
   frontend. The URLs appear on the dashboard.

That's it — no connection strings to copy, no secrets to paste. The database URL, the JWT
secret, and the frontend/API URLs are all wired by the blueprint (`fromDatabase`,
`fromService`, `generateValue`).

> **This is what makes it changeable later.** The services are connected to your GitHub
> repo, so **every `git push` to `main` redeploys automatically** — the API, the frontend,
> and any new migrations. You change the code, push, and the live site updates itself. No
> manual redeploy, no re-uploading anything.

After it's up: edit the `web` service's `/api/*` rewrite destination to your real API URL
(Render names it `campus-wallet-api-XXXX.onrender.com`), or set it once in the dashboard.

> Free tier notes: the API sleeps after ~15 min idle and takes ~30s to wake (open it once
> before a demo); the free Postgres expires after 90 days (recreate it then). Both are the
> tier, not the app.

---

## The manual path — separate providers (Vercel + Render + Neon)

Use this if you want the frontend on Vercel specifically. Same result, more steps.

Architecture:

```
Vercel (React)  ──/api/*──>  Render (Express)  ──TLS──>  Neon (PostgreSQL)
```

The browser only ever talks to your Vercel domain. Vercel rewrites `/api/*` to Render,
so there is no cross-origin request from the user's point of view and no API key in the
front end. Each provider connects to the GitHub repo, so each also auto-deploys on push.

---

## 1 · Database — Neon (free)

1. Sign up at [neon.tech](https://neon.tech) → **New Project** → region **Singapore**
   (lowest latency to Bangladesh).
2. Copy the **pooled** connection string. It looks like:
   `postgres://user:pass@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
3. Keep `?sslmode=require` — the pool enables TLS when it sees it.

> Neon's free tier suspends after inactivity and wakes on the next query, so the first
> request after an idle period is slow. That is the tier, not a bug in the app.

## 2 · API — Render (free)

1. [render.com](https://render.com) → **New → Blueprint** → connect the GitHub repo.
   Render reads `render.yaml` and configures the service itself.
2. Set the two secrets it asks for:
   - `DATABASE_URL` → the Neon string from step 1
   - `CORS_ORIGINS` → your Vercel URL (fill in after step 3, then redeploy)
   `JWT_SECRET` is generated by Render — do not paste your own.
3. Deploy. The start command runs migrations first, so the schema is created on boot.
4. Verify: `curl https://<your-api>.onrender.com/ready` → `{"status":"ready","database":"up"}`

> Free instances sleep after ~15 minutes idle and take ~30 seconds to wake. Before a
> demo or an interview, open the URL once to warm it.

## 3 · Front end — Vercel (free)

1. [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
2. Set **Root Directory** to `web`. Vercel detects Vite automatically.
3. Edit `web/vercel.json` and replace the `destination` host with your real Render URL,
   then commit and push.
4. Deploy, then copy the Vercel URL back into Render's `CORS_ORIGINS` and redeploy the API.

## 4 · Seed the demo accounts

**Demo deployments only** — see [§A.3](#a3--do-not-run-the-seed). From your machine,
pointed at the demo database:

```bash
cd api
$env:DATABASE_URL="<your Neon connection string>"
npm run seed
```

That creates the four demo accounts and 14 days of reconciling history.

> The seed **truncates** first. Run it once, before anyone uses the deployment — never
> against a database that holds anything you want to keep.

## 5 · Put the URL where people will see it

- Top of `README.md`
- The Featured section of your LinkedIn profile
- Your CV, next to the project name

A repository asks an interviewer to imagine it working. A URL does not.

---

## Costs

Neon, Render and Vercel all have free tiers that cover this comfortably. There is no
card required for any of the three at these levels. bKash stays in **sandbox** — going
live needs merchant onboarding, which is a business process, not a deployment step.

## What production still lacks (say this before they ask)

- **One API instance**, so the in-process rate limiter is exact; a second instance needs
  Redis-backed counters.
- **No refresh tokens** — a stolen access token is valid for its 15 minutes.
- **No error tracking** (Sentry or equivalent) and no metrics beyond `/ready`.
- **Free-tier cold starts**, as noted above.
- **No automated database backup** on the free tiers. A system holding a university's
  financial records needs point-in-time recovery before it holds anything real — the ledger
  is append-only and immutable, which protects against *corruption*, not against losing the
  disk.
- **The audit must actually be scheduled** ([§A.4](#a4--schedule-the-nightly-audit)). An
  unscheduled audit job is a file, not a control.

Knowing precisely where your system stops is more convincing than claiming it does not stop.
