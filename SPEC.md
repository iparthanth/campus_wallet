# Campus Wallet — Specification

Written before the code. Premier University, Chattogram.

## Problem

Students settle small amounts constantly — canteen, printing, shared rides, club dues — in
cash. A campus wallet moves that to balance transfers, which means the system has to be
correct about money under concurrency, not merely functional.

## Non-goals (deliberate scope limits)

- No real money. Balances are credited by an admin/seed only. Real top-up is a separate
  add-on (bKash sandbox) documented in "Next steps".
- No KYC, no interest, no multi-currency. One currency: BDT, stored as integer paisa.
- No microservices. One API, one database. Scale is not the problem being solved here.

## Data model

```
users(id, name, email UNIQUE, password_hash, role['user','admin'], created_at)
wallets(id, user_id FK UNIQUE, balance_paisa BIGINT CHECK >= 0, created_at)
transactions(id, from_wallet FK, to_wallet FK, amount_paisa BIGINT CHECK > 0,
             status['completed','flagged'], idempotency_key UNIQUE NULL, created_at,
             CHECK from_wallet <> to_wallet)
fraud_flags(id, transaction_id FK, rule_name, detail, created_at)
```

**Money rule:** every amount is integer paisa (BIGINT). ৳100.50 → `10050`. No floats, ever.
`balance_paisa >= 0` is a database CHECK so that even an application bug cannot create
negative money — defence in depth.

## API contract

| Method | Path | Auth | Returns |
|---|---|---|---|
| POST | `/auth/register` | — | 201 `{user, token}` · 409 email taken · 400 validation |
| POST | `/auth/login` | — | 200 `{user, token}` · 401 bad credentials |
| GET | `/health` | — | 200 `{status}` |
| GET | `/wallet` | Bearer | 200 `{balance_paisa, display}` |
| POST | `/transfers` | Bearer | 201 created · 200 idempotent replay · 422 invalid/insufficient · 404 no recipient |
| GET | `/transactions?limit=&cursor=` | Bearer | 200 `{transactions, next_cursor}` |
| GET | `/admin/flags` | Bearer+admin | 200 `{flags}` · 403 non-admin |
| GET | `/admin/analytics` | Bearer+admin | 200 window-function reports |

Errors are always `{ error: { code, message } }` — a stable machine-readable `code`, never a
stack trace.

## The four transfer guarantees

1. **Atomic** — one DB transaction; both balances move or neither does.
2. **No double-spend** — both wallet rows are locked `FOR UPDATE` *before* the balance is
   read, so two concurrent transfers cannot both see the same sufficient balance.
3. **No deadlock** — locks are taken in **ascending wallet-id order**, so A→B and B→A
   request the same locks in the same sequence and queue instead of deadlocking.
4. **Idempotent** — a repeated `idempotency_key` returns the original transaction and never
   debits twice. Retries and double-clicks are safe.

## Fraud rules

Pure functions of gathered facts — no I/O, so they are trivially testable.

| Rule | Trips when | Rationale |
|---|---|---|
| `VELOCITY` | more than 3 transfers from one wallet within 60s | automation / account takeover |
| `THRESHOLD` | amount > ৳500 **and** > 5× that user's 30-day average | large *and* abnormal for this person |

A flagged transfer still **completes** — flagging is for review, not for blocking students'
money. Thresholds live in config, tunable per environment.

## Pagination

Keyset (`(created_at, id) < (cursor)`), not `OFFSET`. OFFSET degrades linearly with depth and
skips or duplicates rows when new transactions arrive mid-scroll.

## Security decisions

- bcrypt cost 12 (4 in CI for speed).
- JWT 15-minute expiry, `sub` + `role` claims.
- Login returns an identical response and performs a hash comparison whether or not the email
  exists, so timing and wording do not reveal registered accounts.
- Unique email enforced by the DB constraint (409), not SELECT-then-INSERT, which has a race.
- Secrets only from environment; `.env` is gitignored and `.env.example` documents the shape.

## Next steps (honest limitations)

- Real top-up via bKash Tokenized Checkout sandbox (Grant → Create → Execute + Query
  reconciliation for missed callbacks).
- Refresh tokens and token revocation — currently a stolen token is valid for its 15 minutes.
- Rate limiting on `/auth/*`.
- Fraud rules are deterministic; a scoring model would need labelled data this project
  does not have.
