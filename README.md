# Campus Wallet

A campus wallet for Premier University, Chattogram. Students top up through **SSLCommerz**
(bKash, Nagad, Rocket, upay, cards), pay the **canteen, photocopy corner and library desk**
by QR, and send balance to each other. Built to production standards: **money is correct
under concurrency, and there is a test that proves it.**

[![CI](https://github.com/iparthanth/campus_wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/iparthanth/campus_wallet/actions)

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

Seeded logins — password `password123` for all:

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
┌──────────────────────────────────────────┐
│ Express API                              │
│  routes/  auth · wallet · topup · campus · admin │
│  middleware requireAuth · requireAdmin   │
│  domain/  transfer · charge · topup · fraud · money │  ← pure, testable, no framework
│  db/        pool · migrate · seed        │
└───────────────┬──────────────────────────┘
                │ node-postgres, explicit SQL (no ORM)
                ▼
          PostgreSQL 16
   wallets · transactions · charges · merchants · topups · fraud_flags
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
| **Lock semantics** (`lock.semantics`) | **deterministic** — two controlled connections, interleaving forced | seconds |
| **Concurrency** (`transfer.concurrency`) | parallel requests; invariant checks (money conserved, never negative) | seconds |
| **Top-up** (`topup.test.js`) | bKash flow against a controllable fake gateway | seconds |
| **E2E** (`e2e/tests/wallet.spec.js`) | real Chrome → React → Express → Postgres | seconds |

**84 tests, all green** — 80 API/unit against a real PostgreSQL 16, plus 4 Playwright E2E flows.

```bash
cd api && npm test              # 80 tests
cd e2e && npx playwright test   # 4 E2E flows (needs api + web running)
```

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

## Paying on campus

A wallet with nowhere to spend is a transfer app. These are the outlets money actually
goes to, and how:

1. Counter staff raise a charge — *"that's ৳85"* — which mints a **QR** (`campuswallet://pay/<token>`).
2. The student scans, sees the outlet name and amount, and confirms.
3. Money moves student wallet → outlet wallet in one locked transaction.

The QR carries a random 72-bit token, **not the row id**: an incrementing id would let
anyone pay — or probe — the next student's bill by guessing a number. Bills expire after
10 minutes so one left open at a busy counter does not stay payable all afternoon.

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

- **No real money.** The bKash integration is sandbox-only; production needs merchant
  onboarding. Balances are otherwise seeded or admin-credited.
- **No refresh tokens** — a stolen token stays valid for its 15 minutes.
- **No rate limiting** on `/auth/*` yet; brute-force protection is a gap.
- **Fraud rules are deterministic**, not learned. A scoring model would need labelled fraud
  data this project does not have — and inventing that data would make the numbers a lie.
- **Single node.** Scaling would mean read replicas and moving fraud evaluation to a queue.

## Stack

Node 24 · Express · PostgreSQL 16 · node-postgres (no ORM) · zod · bcryptjs · JWT ·
Jest + supertest · Docker Compose · GitHub Actions

See [SPEC.md](SPEC.md) for the full contract written before the code.
