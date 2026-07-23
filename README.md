# Campus Wallet

A fintech-style wallet for Premier University, Chattogram — students hold a balance and
transfer to each other. Built to production standards: **money is correct under concurrency,
and there is a test that proves it.**

[![CI](https://github.com/iparthanth/campus_wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/iparthanth/campus_wallet/actions)

---

## The problem this solves properly

Any developer can write "subtract from A, add to B". The hard part is what happens when the
same student taps **Send** twice at the same moment, on a flaky campus network, from two
devices. Naively, both requests read a ৳1000 balance, both approve a ৳600 transfer, and the
wallet ends at **-৳200** — money created from nothing.

This project makes that impossible, and proves it:

```js
// tests/transfer.concurrency.test.js
const [a, b] = await Promise.all([sendSixHundred(), sendSixHundred()]);
expect([a.status, b.status].sort()).toEqual([201, 422]); // exactly one wins
expect(await balanceOf(sender.id)).toBe(START - AMOUNT); // money moved once
```

Delete the `FOR UPDATE` in `src/domain/transfer.js` and this test goes red.

## Run it

```bash
docker compose up          # database + API, migrations run automatically
curl localhost:3000/health
```

Without Docker (local Postgres):

```bash
cd api
cp .env.example .env       # then set DATABASE_URL and JWT_SECRET
npm ci && npm run migrate && npm run seed && npm start
```

Seeded logins — password `password123`:
`partha@puc.ac.bd` (৳500) · `rima@puc.ac.bd` (৳250) · `imran@puc.ac.bd` (৳100) · `admin@puc.ac.bd` (admin)

## Architecture

```
   React SPA
       │  JWT (Bearer)
       ▼
┌──────────────────────────────────────────┐
│ Express API                              │
│  routes/    auth · wallet · admin        │
│  middleware requireAuth · requireAdmin   │
│  domain/    transfer · fraud · money     │  ← pure, testable, no framework
│  db/        pool · migrate · seed        │
└───────────────┬──────────────────────────┘
                │ node-postgres, explicit SQL (no ORM)
                ▼
          PostgreSQL 16
   wallets · transactions · fraud_flags
   CHECK balance_paisa >= 0   ← last line of defence
```

**Layering rule:** `domain/` never imports Express and never talks to HTTP. That is why the
fraud rules and money helpers are unit-testable in milliseconds with no database.

## The four transfer guarantees

| Guarantee | How | Proven by |
|---|---|---|
| **Atomic** | one DB transaction via `withTransaction` | rollback tests |
| **No double-spend** | both wallets locked `FOR UPDATE` before the balance is read | `two simultaneous transfers … exactly one succeeds` |
| **No deadlock** | locks acquired in **ascending wallet-id order** | `opposite-direction transfers do not deadlock` |
| **Idempotent** | unique `idempotency_key`; replay returns the original | `replaying … never debits twice` |

## Money handling

Every amount is an **integer number of paisa** (`BIGINT`). ৳100.50 is stored as `10050`.
No floats touch money anywhere — `toPaisa()` throws rather than silently rounding
sub-paisa precision. `balance_paisa >= 0` is enforced by a database CHECK constraint, so even
an application bug cannot mint negative money.

## Test strategy

A deliberate pyramid — fast tests at the bottom, few slow ones on top.

| Layer | What | Speed |
|---|---|---|
| **Unit** (`fraud.unit.test.js`) | fraud rules, money helpers — pure functions, no DB | ms |
| **API** (`auth`, `transfer.bva`) | real HTTP + real Postgres via supertest | seconds |
| **Concurrency** (`transfer.concurrency`) | parallel requests against real row locks | seconds |

### Boundary Value Analysis

Bugs live on boundaries, so the tests do too. The transfer amount is tested at:

| Case | Value | Expected |
|---|---|---|
| zero | `0` | 422 |
| negative | `-100` | 422 |
| fractional paisa | `100.5` | 422 |
| minimum valid | `1` | 201 |
| exactly the balance | `balance` | 201 |
| one paisa over | `balance + 1` | 422 |
| above sanity cap | `100_000_001` | 422 |

Plus self-transfer, unknown recipient, and unauthenticated access.

```bash
cd api && npm test          # all suites
cd api && npm run test:cov  # with coverage (domain/ gated at 85%)
```

## Security decisions

- **bcrypt** cost 12 (4 in CI for speed only).
- **JWT** 15-minute expiry; expired, forged, and malformed tokens each tested.
- **No user enumeration** — wrong password and unknown email return byte-identical responses,
  and a hash comparison runs either way so timing does not leak.
- **Unique email** enforced by the DB constraint → 409, not `SELECT`-then-`INSERT` (a race).
- **Secrets** only from env; `.env` gitignored, `.env.example` documents the shape.
- **Container** runs as non-root `node` user.

## SQL worth reading

`GET /admin/analytics` is the analytical-SQL showcase — three window-function queries:
running balance per wallet (`SUM() OVER`), daily volume with a 7-day moving average, and
top-5 senders per ISO week (`RANK() OVER`). History uses **keyset pagination** on
`(created_at, id)`, not `OFFSET`, which degrades linearly and skips rows when data arrives
mid-scroll.

## Limitations & next steps

Honest about what this is not:

- **No real money.** Balances are seeded/admin-credited. Real top-up via **bKash Tokenized
  Checkout sandbox** (Grant Token → Create → Execute, plus a Query fallback to reconcile
  missed callbacks) is the designed next step.
- **No refresh tokens** — a stolen token stays valid for its 15 minutes.
- **No rate limiting** on `/auth/*` yet; brute-force protection is a gap.
- **Fraud rules are deterministic**, not learned. A scoring model would need labelled fraud
  data this project does not have — and inventing that data would make the numbers a lie.
- **Single node.** Scaling would mean read replicas and moving fraud evaluation to a queue.

## Stack

Node 24 · Express · PostgreSQL 16 · node-postgres (no ORM) · zod · bcryptjs · JWT ·
Jest + supertest · Docker Compose · GitHub Actions

See [SPEC.md](SPEC.md) for the full contract written before the code.
