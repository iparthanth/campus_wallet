# Campus Wallet — Specification

Written before the code. Premier University, Chattogram.

> **This is the original v1 specification, kept as written.** It was superseded in July 2026
> by [Amendment 1](#amendment-1--july-2026--zero-float-and-bangla-qr), which changes the core
> premise: the system no longer holds balances, because doing so is a criminal offence in
> Bangladesh without a Bangladesh Bank licence. Read the amendment before treating anything
> below as current. It is preserved rather than rewritten because the reasoning that had to
> be discarded is part of the record.

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
- Rate limiting on `/auth/*`. *(Implemented — see Amendment 1 §5.)*
- Fraud rules are deterministic; a scoring model would need labelled data this project
  does not have.

---

# Amendment 1 · July 2026 · Zero-float and Bangla QR

## Why the v1 premise had to go

V1 assumed the system holds student balances. That is **stored value**, and under the
**Payment and Settlement Systems Act 2024 s.15(1)** no *person, institution or company*
(প্রতিষ্ঠান — deliberately wider than "company") may issue a prepaid payment instrument
without Bangladesh Bank approval. Penalties under s.37(1) reach 5 years' imprisonment or
BDT 50 lakh; s.39 makes the offence cognizable and non-bailable; s.38 reaches officers
personally. The closed-loop exemption commonly cited **is not in the enacted Act** — it
appears only in an unenacted draft. The one published route requires a Companies Act 1994
company with BDT 20 crore paid-up capital.

Separately, **Bangla QR became mandatory on 1 July 2026** for all banks, MFS providers,
PSPs, PSOs and merchants, and proprietary QRs were ordered replaced. The v1
`campuswallet://pay/<token>` scheme is exactly what that directive outlaws.

## 1 · Revised premise

The university is a **merchant**, not an issuer. Money moves student → acquiring bank →
PUC's bank account, over licensed rails. This system issues the order, generates the
outlet's **Bangla QR**, and reconciles the acquirer's settlement file against what was sold.
It never custodies funds.

`WALLET_MODE` defaults to `zero_float`. `closed_loop` remains for demonstration outside
production; **production throws at boot** if configured with it. No override flag exists.

## 2 · Added data model

```
ledger_accounts(id, code UNIQUE, name, account_class['ASSET','LIABILITY','EQUITY',
                'REVENUE','EXPENSE'], owner_user_id FK NULL, merchant_id FK NULL)
ledger_postings(id, idempotency_key UNIQUE NULL, kind, memo, reverses_posting_id FK NULL,
                created_at)
ledger_entries(id, posting_id FK, account_id FK, direction['DEBIT','CREDIT'],
               amount_paisa BIGINT CHECK > 0)

merchants  + acquirer_issued BOOL DEFAULT false, acquirer_name, acquirer_guid,
             acquirer_merchant_id, qr_merchant_name, qr_city, onboarded_at
             CHECK (acquirer_issued = false OR all six are NOT NULL)
charges    + order_ref CHECK (~ '^[A-Z0-9-]{6,25}$'), bangla_qr_payload, ledger_posting_id

settlement_imports(id, acquirer, source_ref, statement_date,
                   content_sha256 CHAR(64) NOT NULL UNIQUE CHECK (~ '^[a-f0-9]{64}$'),
                   imported_by FK NULL, line_count, matched_count, gross_paisa, created_at,
                   CHECK matched_count <= line_count)
settlement_lines(id, import_id FK, acquirer_txn_id, order_ref NULL,
                 gross_paisa CHECK > 0, fee_paisa CHECK >= 0, net_paisa CHECK > 0,
                 status, note, paid_at, charge_id FK NULL, ledger_posting_id FK NULL,
                 created_at,
                 CHECK gross_paisa = net_paisa + fee_paisa,
                 CHECK matched lines are linked to a charge and a posting)
audit_runs(id, business_date, result audit_result['PASS','WARN','FAIL'],
           trial_balance_drift_paisa, cross_check_discrepancies,
           unsettled_paisa, unsettled_count, aged_count, unmatched_receipts,
           detail JSONB, duration_ms, created_at)
  UNIQUE(business_date)  -- re-running overwrites; "did the 24th pass?" stays unambiguous
```

`audit_runs.business_date` is the date **audited**, not the moment the job ran — a job
firing at 00:05 is auditing yesterday, and conflating the two is off by one every night.

**Invariants enforced in PostgreSQL, not application code:**

| Invariant | Mechanism |
|---|---|
| Every posting balances | `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, checked at `COMMIT`. A plain `CHECK` cannot see sibling rows and so could be defeated by insert ordering. |
| Entries are immutable | triggers rejecting `UPDATE` and `DELETE` |
| Corrections are reversals | `reverse()` posts the mirror; the original remains |
| One acquirer txn settles ≤ one order | **partial** unique index on `acquirer_txn_id WHERE status = 'MATCHED'` — a global `UNIQUE` was tried first and was wrong: it made the `ALREADY_IMPORTED` exception row itself unstorable |
| A statement cannot be imported twice | `UNIQUE(content_sha256)` over the exact bytes |

## 3 · Added API contract

| Method | Path | Auth | Returns |
|---|---|---|---|
| POST | `/orders` | Bearer¹ | 201 `{order_ref, qr_payload}` · 422 validation · 409 `NOT_ONBOARDED` |
| GET | `/orders/:token` | Bearer | 200 order (never the QR payload) · 404 |
| GET | `/outlet/summary` | Bearer¹ | 200 takings and outstanding |
| POST | `/admin/settlements/import` | Bearer+admin | 201 `{line_count, matched_count, exception_count}` · 409 duplicate statement |
| GET | `/admin/reconciliation/exceptions` | Bearer+admin | 200 unmatched receipts + unsettled orders |
| GET | `/admin/reconciliation/cross-check` | Bearer+admin | 200 agree · **409 disagree** |
| GET/POST | `/admin/audit/run` | Bearer+admin | 200 PASS/WARN · **409 FAIL** |
| GET | `/admin/audit/history` | Bearer+admin | 200 past verdicts |
| GET | `/admin/ledger/trial-balance` | Bearer+admin | 200 balanced · **409 drift** |
| GET | `/admin/ledger/accounts/:code` | Bearer+admin | 200 statement |

¹ Operator authority is resolved in the domain layer, not by middleware: the outlet is
looked up *by* `operator_id`, so a user who runs no outlet has nothing to raise an order
against. There is no role string to spoof.

**409, not 200, when the books disagree.** A discrepancy is an alarm, not a successful read.
Returning 200 with a `discrepancy` field invites a caller to ignore it.

`GET /orders/:token` deliberately never returns the QR payload. The payload is the payment
instrument; only the counter that raised the order needs it.

## 4 · Nightly audit

| Check | Verdict | Exit |
|---|---|---|
| Trial balance — debits = credits | FAIL | 1 |
| Cross-check — outlet totals vs ledger | FAIL | 1 |
| Aged receivables / unmatched receipts | WARN | **0** |

WARN exits 0 by design: nightly pages for routine ageing get muted within a fortnight, and
the FAIL gets muted along with them. Could-not-run exits 2, distinct from a real failure.

## 5 · Closed v1 limitations

- **Rate limiting on `/auth/*` — done.** Keyed on **(IP, email)**, not IP alone: a university
  network or mobile CGNAT puts thousands of students behind one address, so an IP-only limit
  would let ten fat-fingered passwords lock out the campus.
- **Real top-up — done** via SSLCommerz (sandbox credentials work out of the box), with
  server-to-server validation as the only thing that moves money.

## 6 · Still open

- Refresh tokens and revocation.
- **PDPO 2025**: consent capture, retention limits, export and erasure.
- Live acquirer integration — blocked on PUC institutional steps, not on code
  (see [PUC-HANDOVER.md](PUC-HANDOVER.md) §5).
- Real-time settlement webhooks; matching is currently next-day by file.
