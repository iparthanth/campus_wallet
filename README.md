# Campus Wallet

Campus payments for Premier University, Chattogram. A student is shown a **Bangla QR** at
the counter, pays from whatever app they already have (bKash, Nagad, Rocket, upay, any bank),
and the payment is matched back to the order automatically — replacing PUC's current process
of emailing `accounts@puc.ac.bd` a transaction ID by hand.

Built to production standards: **money is correct under concurrency, the books are
double-entry and provably balanced, and there are tests that prove both.**

[![CI](https://github.com/iparthanth/campus_wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/iparthanth/campus_wallet/actions)

> **The university never holds student money.** That is a legal requirement, not a design
> preference — see [The zero-float rule](#the-zero-float-rule-read-this-first) below. What
> PUC must do institutionally before this can collect a single taka is set out in
> [PUC-HANDOVER.md](PUC-HANDOVER.md).

---

## The zero-float rule (read this first)

The obvious design — students top up a balance and spend it later — is illegal in
Bangladesh without a licence. Under the **Payment and Settlement Systems Act 2024 s.15(1)**,
no *person, institution or company* may issue a prepaid payment instrument without
Bangladesh Bank approval. The Bangla term is **প্রতিষ্ঠান** (*institution*), deliberately
wider than "company", and it covers a university. Penalties under s.37(1) run to 5 years'
imprisonment or BDT 50 lakh; s.39 makes the offence **cognizable and non-bailable**; s.38
reaches officers personally. The "closed-loop exemption" people cite is **not in the enacted
Act** — it exists only in an unenacted draft.

So money never touches this software:

```
 Student's app          Acquiring bank            This system
 (bKash/Nagad/bank)     (licensed PSP)            (PUC = merchant)
       │                       │                        │
       │ scans outlet Bangla QR│                        │
       ├──────────────────────►│                        │
       │   money moves only on licensed rails           │
       │                       │  settlement file       │
       │                       ├───────────────────────►│
       │                PUC's bank account       order settled, ledger posted
```

This is enforced, not documented:

- **`zero_float` is the default.** `WALLET_MODE=closed_loop` with `NODE_ENV=production`
  **throws at boot**, citing the statute. There is no override flag ([`config.js`](api/src/config.js)).
- **An outlet not onboarded by an acquiring bank cannot trade** — raising an order fails
  with `NOT_ONBOARDED` and writes *nothing*, so it is impossible to print a QR that would be
  declined at the counter.
- Balance-holding remains available outside production for demonstration. That is what makes
  the production refusal testable rather than aspirational.

**Bangla QR has been mandatory since 1 July 2026** for all banks, MFS providers, PSPs, PSOs
and merchants, with proprietary QRs ordered replaced. This system emits standards-compliant
**EMVCo Merchant-Presented QR** payloads ([`banglaQr.js`](api/src/domain/banglaQr.js)).

---

## The problem this solves properly

Any developer can write "subtract from A, add to B". The hard part is what happens when the
same student taps **Send** twice at the same moment, on a flaky campus network, from two
devices. Naively, both requests read a ৳1000 balance, both approve a ৳600 transfer, and the
wallet ends at **-৳200** — money created from nothing.

This project makes that impossible, and — more importantly — **proves the proof works**.

```js
// tests/lock.semantics.test.js
// Another transaction is mid-flight spending ৳600 of ৳1000. We attempt ৳600 too.
await blocker.query('UPDATE wallets SET balance_paisa = balance_paisa - 60000 WHERE id = $1', [walletId]);
const inflight = api().post('/transfers').send({ amount_paisa: 600_00 }).then(r => r);
await sleep(800);
await blocker.query('COMMIT');

expect((await inflight).status).toBe(422); // clean rejection on the true balance
```

Delete the `FOR UPDATE` in `src/domain/transfer.js` and this test goes red with **500** —
the stale read approves the transfer, and only the database `CHECK` constraint stops the
balance going negative. Verified by actually deleting it.

> **Why not the two-parallel-requests test?** I wrote that first, deleted `FOR UPDATE`, and
> it still passed — the two requests rarely overlap inside the database, and the `UPDATE`
> takes a row lock anyway, so "does it block?" cannot tell the two versions apart. A test
> that only sometimes creates a race cannot prove anything. The deterministic version above
> replaced it. The parallel tests remain as invariant checks, not as the proof.

## Run it

```bash
docker compose up          # database + API, migrations run automatically
curl localhost:3000/health
```

Without Docker (portable Postgres on Windows — no admin needed):

```bash
# start the local cluster (once per boot)
D:\devtools\pgsql\bin\pg_ctl.exe -D D:\devtools\pgdata_wallet -o "-p 5433" start

cd api
cp .env.example .env       # DATABASE_URL=postgres://wallet:wallet@localhost:5433/campus_wallet
npm ci && npm run migrate && npm run seed && npm start

# stop it when done
D:\devtools\pgsql\bin\pg_ctl.exe -D D:\devtools\pgdata_wallet stop
```

Seeded **development** logins — password `password123` for all. `npm run seed` is a local
convenience and is never run against production; the login screen ships no prefilled
credentials.

| Account | Role |
|---|---|
| `partha@puc.ac.bd` · `rima@puc.ac.bd` · `imran@puc.ac.bd` | students, with two weeks of history |
| `canteen@puc.ac.bd` · `copy@puc.ac.bd` · `library@puc.ac.bd` | outlet counters — raise QR charges |
| `admin@puc.ac.bd` | analytics dashboard and fraud flags |

The seed replays its transfers against the balances and asserts the ledger reconciles, so the
demo data obeys the same money-conservation invariant the application does.

## Screens

| Wallet | Admin dashboard |
|---|---|
| ![wallet](docs/screenshots/2-wallet.png) | ![dashboard](docs/screenshots/4-dashboard.png) |

| Dark mode | Mobile |
|---|---|
| ![dark](docs/screenshots/9-dashboard-dark.png) | ![mobile](docs/screenshots/10-mobile.png) |

Light and dark are both **selected** palettes, not an inverted flip — the dark chart
colours were re-stepped and re-validated against the dark surface. On phones the sidebar
becomes a fixed bottom tab bar in the thumb zone, with safe-area padding.

| Counter — bill + QR | Student confirming |
|---|---|
| ![counter](docs/screenshots/5-counter-qr.png) | ![pay](docs/screenshots/6-pay-confirm.png) |

| Sign in | Confirm send |
|---|---|
| ![sign in](docs/screenshots/1-signin.png) | ![confirm](docs/screenshots/3-send-confirm.png) |

The dashboard charts are hand-built SVG — no charting library. The palette was run through
a contrast/colour-blindness validator rather than eyeballed, and because the area fill sits
below 3:1 against the surface, every chart ships the required relief: direct labels on the
bars and a **Table** toggle that renders the same data as text.

Sending is a deliberate two-step flow — enter, then confirm against the resulting balance —
because a mis-typed amount is unrecoverable once money moves. Each send carries a generated
idempotency key, so a double-click or a flaky-network retry cannot debit twice.

## Architecture

```
   React SPA
       │  JWT (Bearer)
       ▼
┌────────────────────────────────────────────────────────────────┐
│ Express API                                                    │
│  routes/     auth · wallet · topup · campus · orders · admin   │
│  middleware  requireAuth · requireAdmin · rateLimit            │
│  domain/     order · banglaQr · ledger · reconciliation · audit│  ← pure, no framework
│              transfer · charge · topup · fraud · money         │
│  jobs/       nightlyAudit                                      │
│  db/         pool · migrate · seed                             │
└───────────────┬────────────────────────────────────────────────┘
                │ node-postgres, explicit SQL (no ORM)
                ▼
          PostgreSQL 16
   ledger_accounts · ledger_postings · ledger_entries      ← the books
   merchants · charges · settlement_imports · settlement_lines
   wallets · transactions · topups · fraud_flags · audit_runs

   Invariants live HERE, not in application code:
     deferred constraint trigger  every posting balances at COMMIT
     triggers                     entries are never UPDATEd or DELETEd
     partial unique index         one acquirer txn settles at most one order
     UNIQUE(content_sha256)       the same statement cannot be imported twice
     CHECK balance_paisa >= 0     last line of defence (closed-loop demo path)
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
| **Lock semantics** (`lock.semantics`) | **deterministic** — two controlled connections, interleaving forced | seconds |
| **Concurrency** (`transfer.concurrency`) | parallel requests; invariant checks (money conserved, never negative) | seconds |
| **Top-up** (`topup.test.js`) | bKash flow against a controllable fake gateway | seconds |
| **Ledger** (`ledger.test.js`) | balance invariants against **real PostgreSQL triggers**, not mocks | seconds |
| **Reconciliation** (`reconciliation.test.js`) | settlement import, matching, exception paths | seconds |
| **E2E** (`e2e/tests/wallet.spec.js`) | real Chrome → React → Express → Postgres | seconds |

**300 tests across 19 suites, all green**, against a real PostgreSQL 16 — plus Playwright
E2E flows through real Chrome.

```bash
cd api && npm test              # 300 tests, 19 suites
cd e2e && npx playwright test   # E2E flows (needs api + web running)
```

Two testing decisions worth stating:

**The QR CRC is verified against the catalogue value, not a recalled vector.** CRC-16/CCITT-FALSE
is proven with the authoritative check `"123456789" → 0x29B1`. An EMVCo specimen payload
recalled from memory disagreed with its own published CRC — rather than bake an
unverifiable vector into the suite, it was left out. A test that asserts a value you cannot
source is worse than no test: it certifies a guess.

**`resetDb` truncates `audit_runs` by name.** `TRUNCATE ... CASCADE` only reaches tables
that *reference* a truncated one, so a table with no foreign key is silently skipped — which
leaked audit rows between files until it was tracked down. Any future FK-less table must be
added there by hand.

E2E seeds balances by writing to the database directly rather than through a `/test/credit`
endpoint. Shipping a money-creating route inside the production artifact, guarded only by an
environment variable, is one misconfiguration away from letting anyone mint balance — so the
test harness reaches around the app instead of putting a seam inside it.

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

- **Rate limiting** on `/auth/*`, keyed on **(IP, email)** rather than IP alone — a
  university network or mobile CGNAT puts thousands of students behind one address, so
  an IP-only limit would let ten fat-fingered passwords lock out the whole campus.
- **`/health` vs `/ready`** — liveness never touches the database (restarting the API
  cannot fix a broken database); readiness runs a real query and returns 503 honestly.
  The original single `/health` reported "ok" during an actual Postgres outage.
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

## The books — double-entry ledger

Every order and every settlement is recorded as a balanced double-entry posting. This is
what lets PUC's accounts office answer *"where is the money?"* without trusting the
application, and it is why the invariants are in PostgreSQL rather than in JavaScript:

| Invariant | Enforced by |
|---|---|
| Every posting balances (debits = credits) | a **deferred** constraint trigger, checked at `COMMIT` — a plain `CHECK` cannot see sibling rows, so it could be evaded by insert ordering |
| Entries are never edited or deleted | triggers that reject `UPDATE` and `DELETE` outright |
| A correction is a **reversal**, never a rewrite | `reverse()` posts the mirror image; the original stays visible |
| One acquirer transaction settles at most one order | a **partial** unique index `WHERE status = 'MATCHED'` — duplicates are still *recorded* as exceptions rather than silently dropped |
| The same statement cannot be imported twice | `UNIQUE(content_sha256)` over the exact file bytes |

That last one guards the likeliest operator error: uploading yesterday's statement again and
doubling the books.

The narrower partial index is worth a note — a globally `UNIQUE` `acquirer_txn_id` was the
first attempt, and it was wrong: it made the `ALREADY_IMPORTED` exception row itself
unstorable. The real invariant is *"settles at most one order"*, not *"appears at most
once"*.

## Reconciliation and the nightly audit

The **Reconcile** screen answers the question an accounts officer actually asks each
morning: *does what the bank sent us match what we sold, and if not, exactly where?* So the
exceptions lead and the totals are secondary — a dashboard headlining "৳48,300 collected ✓"
while burying three unmatched payments in a tab is the same spreadsheet problem in nicer
colours. Two lists: **money received that no order explains**, and **sold but never paid**.

A nightly job records a permanent verdict:

| Check | Verdict |
|---|---|
| Trial balance — total debits equal total credits | **FAIL** (exit 1) |
| Cross-check — per-outlet order totals agree with the ledger | **FAIL** (exit 1) |
| Aged receivables / unmatched receipts | **WARN** (exit **0**) |

A WARN exits 0 deliberately. If routine ageing paged somebody nightly, the alert would be
muted inside a fortnight — and the FAIL would be muted with it.

A failing cross-check answers **HTTP 409**, not 200: the books disagreeing with reality is
an alarm, not a successful read.

## Paying on campus

1. Counter staff raise an order — *"that's ৳85"* — which mints an **order reference** like
   `PUC-3-K9F2QT7M` and the outlet's **Bangla QR** carrying it.
2. The student pays from their own app. The money goes to PUC's bank account, never here.
3. The acquirer's settlement file is imported next day and matched to the order.

The reference uses **Crockford base32** — I, L, O and U are excluded — so a reference read
aloud at a noisy counter or written by hand cannot be mistyped into a *different valid*
reference. Order tokens are random, not row ids: an incrementing id would let anyone probe
the next student's bill by guessing a number.

> The legacy `campuswallet://pay/<token>` flow below is the **closed-loop demo path**. It is
> the proprietary QR that Bangladesh Bank ordered replaced on 1 July 2026, and production
> refuses to run in that mode. It is retained because it is what makes the refusal testable.

The hazard here is two phones scanning the same code. The charge row is locked and its
status re-checked inside the transaction, so the second payer loses cleanly:

```js
// tests/campus.test.js
const [r1, r2] = await Promise.all([payAs(alice), payAs(bob)]);
expect([r1, r2].filter(r => r.status === 200).length).toBe(1);
expect(await balanceOf(canteen.id)).toBe(100_00);   // paid once, not twice
```

Outlets hold real wallets, so canteen sales are covered by the same money-conservation
invariant as peer transfers — nothing is created at the counter.

## Topping up — SSLCommerz (real, working)

**SSLCommerz** is Bangladesh's largest gateway and fronts bKash, Nagad, Rocket, upay, TAP
and the major banks in one session. Its sandbox runs on published test credentials, so
this integration works end to end **with no merchant agreement** — clone the repo and a
real gateway session opens against SSLCommerz's own servers.

The security boundary is `validatePayment()`. The browser comes back from the gateway with
parameters a user can edit, so none of them are trusted: only the server-to-server
validation response moves money, and the settled amount is compared against what the
top-up expected. Without that check a student could open a ৳10 session and hand-craft a
৳10,000 success URL.

Two paths credit a wallet — the browser redirect and the server-to-server IPN — because on
Bangladeshi mobile data the redirect frequently never arrives. Crediting is idempotent, so
both racing is harmless.

## bKash direct (sandbox, currently disabled)

Money enters the wallet through **bKash Tokenized Checkout**: Grant Token → Create Payment →
user pays → Execute Payment. Credentials are server-side only; leave them blank and the
feature disables itself (`/topup/available` returns false) rather than breaking the app.

The part that matters is the failure path. In Bangladesh a payment routinely completes while
the callback never arrives — backgrounded app, dropped connection, closed tab. Without
recovery, that student has paid and received nothing. So:

- `payment_id` is `UNIQUE` and the top-up row is locked `FOR UPDATE` before crediting, so a
  duplicated callback, a retry, and the reconciler can all race and **only one credits**.
- `POST /topup/reconcile` asks bKash what actually happened and credits if the payment really
  completed — the button labelled *"Payment went through but nothing happened."*
- An unknown `paymentID` returns **404**, not 500: a typo is not an outage, and collapsing
  both hides real incidents in the logs.

Tested against a **fake bKash server** (`tests/fake-bkash.js`) rather than the live sandbox —
a third-party dependency makes a suite slow and flaky, and cannot be told to simulate a
dropped callback on demand. The fake matches the documented request/response shapes.

## Limitations & next steps

Honest about what this is not:

- **Not yet run against a live acquirer.** It is tested end-to-end against the documented
  EMVCo standard and against sandbox gateway credentials, but no real merchant account
  exists yet — that is PUC's step, not a coding one ([PUC-HANDOVER.md](PUC-HANDOVER.md) §5.1).
  The first live week should be reconciled by hand in parallel.
- **Settlement matching is next-day**, because acquirers deliver settlement files on a daily
  cycle. Real-time confirmation needs a per-acquirer webhook, negotiated at onboarding.
- **Static-QR payments cannot always be matched.** If an outlet shows a fixed printed QR and
  the payer types the amount, there is no reference in the payment; those land in the
  exceptions list for a human. Dynamic per-order QR — what this generates — avoids it.
- **No refresh tokens** — a stolen token stays valid for its 15 minutes.
- **PDPO 2025 compliance is partial.** Consent capture, retention limits, export and erasure
  are not yet implemented; the data held is minimal (name, email, phone, transactions) and
  no payment instrument data ever reaches the system.
- **One outlet, one operator account** — shift handover on a single counter is not modelled.
- **Fraud rules are deterministic**, not learned. A scoring model would need labelled fraud
  data this project does not have — and inventing that data would make the numbers a lie.
- **Single node.** Scaling would mean read replicas and moving fraud evaluation to a queue.

## Stack

Node 24 · Express · PostgreSQL 16 · node-postgres (no ORM) · zod · bcryptjs · JWT ·
Jest + supertest · Docker Compose · GitHub Actions

See [SPEC.md](SPEC.md) for the full contract written before the code.
