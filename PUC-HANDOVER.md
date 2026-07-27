# Campus Wallet — Handover to Premier University Chattogram

**For:** the Registrar, the Controller of Accounts, and the IT department
**Prepared:** July 2026
**Status:** software complete and tested; awaiting the institutional steps in §5

---

## 1 · What this is, in one paragraph

Premier University's fee and campus-payment process today runs on email: a student pays by
internet banking or BEFTN, then emails `accounts@puc.ac.bd` with the transaction details,
their name and their student ID — and the published procedure warns that *the deposit will
not be updated unless this information is provided*. This system replaces that email step.
A student is shown a **Bangla QR** at the counter, pays from whatever app they already have
(bKash, Nagad, Rocket, upay, or any bank app), and the payment is matched automatically to
the order. Nobody retypes anything, and nothing is credited on trust.

**The university never holds student money at any point.** That is a deliberate legal
choice, explained in §2, and it is enforced by the software rather than by policy.

---

## 2 · The legal position — please read this section

### 2.1 Why the university must not hold balances

The obvious design for a "campus wallet" is the wrong one. If students top up a balance and
spend it later, the university is issuing **stored value** — e-money.

Under the **Payment and Settlement Systems Act 2024, s.15(1)**, no *person, institution or
company* may issue a prepaid payment instrument without Bangladesh Bank approval. The Bangla
term used is **প্রতিষ্ঠান** (*institution*), which is deliberately wider than "company" and
covers a university.

| | |
|---|---|
| Penalty (s.37(1)) | up to **5 years' imprisonment** and/or a fine up to **BDT 50 lakh** |
| Offence class (s.39) | **cognizable, non-bailable, non-compoundable** |
| Who is liable (s.38) | reaches **directors and chief executives personally** — for PUC, that means the Vice-Chancellor and the Registrar, not the developer |
| Licence route | PSP licence requires **BDT 20 crore** paid-up capital in a Companies Act 1994 company |

A "closed-loop" exemption is often cited in discussion. **It does not exist in the enacted
Act.** It appears only in a *draft* E-Money regulation that has not been enacted. The one
published approval route — the Closed Prepaid Instrument Guidelines 2024 — still requires a
company with BDT 20 crore paid-up capital and forbids reloadable balances.

> **Recommendation:** PUC should not seek a licence and does not need one. The architecture
> below removes the requirement entirely rather than working around it.

### 2.2 The lawful architecture — PUC is the merchant, the bank is the issuer

```
  Student's own app                Acquiring bank                   This system
  (bKash / Nagad / bank)           (licensed PSP)                   (PUC)
        │                                │                                │
        │  scans the outlet's Bangla QR  │                                │
        ├───────────────────────────────►│                                │
        │                                │                                │
        │        money moves here, on licensed rails only                 │
        │                                │                                │
        │                                │  next-day settlement file      │
        │                                ├───────────────────────────────►│
        │                                │                                │
        │                          PUC's bank account          order marked settled,
        │                                                       ledger posted
```

Money moves **student → acquiring bank → PUC's own bank account**. It never passes through
this software. This system records what was sold, prints the QR, and proves afterwards that
what the bank collected matches what the campus sold.

This is the same shape as the **Islami Bank + Mastercard** cashless-campus deployments at
Chittagong University (October 2025) and Rajshahi University (September 2025) — the bank is
the licensed party; the university is a merchant.

### 2.3 Bangla QR is mandatory

Bangladesh Bank made the interoperable **Bangla QR** compulsory from **1 July 2026** for all
banks, MFS providers, PSPs, PSOs and merchants, and ordered anyone running a proprietary QR
to replace it. This system generates standards-compliant **EMVCo Merchant-Presented QR**
payloads. Any campus system still printing its own private QR code is non-compliant today.

### 2.4 How the software enforces this

This is the part that matters for assurance: the constraint is in the code, not in a policy
document that can be forgotten.

- **Production refuses to start** if configured to hold balances. Setting
  `WALLET_MODE=closed_loop` with `NODE_ENV=production` throws at boot with an error citing
  s.15(1). There is no override flag. A misconfigured environment variable cannot expose
  PUC's officers to criminal liability.
- **Every operation that would move an internally-held balance refuses**, in the domain
  layer, not the interface. Student-to-student transfer, and both top-up routes, answer
  `409 ZERO_FLOAT` and move nothing. This is a separate control from the one above, and the
  distinction matters: the boot guard stops the wrong *mode*, these stop the wrong
  *operations*. An earlier build had the first without the second — the deployment declared
  itself zero-float while a student could still top up and hold a balance. Hiding the button
  would not have been a fix; the route was reachable regardless of what the browser drew.
- **There is no balance to see.** A student's home screen is their payment record — what
  they paid, to which outlet, when, and the reference that proves it — not a stored value.
- **An outlet that has not been onboarded by an acquiring bank cannot trade.** Raising an
  order against it fails with `NOT_ONBOARDED` and writes *nothing* — no partial record, no
  QR. It is impossible to print a QR that would be declined at the counter.
- The balance-holding code path still exists for demonstration on a laptop. That is
  deliberate: it is what makes the production refusal something you can actually test.

---

## 3 · What has been built

### 3.1 The counter flow

1. The outlet operator enters an amount and an optional memo.
2. The system issues an **order reference** — e.g. `PUC-3-K9F2QT7M` — in Crockford base32
   (the letters I, L, O and U are excluded, so a reference read aloud or written by hand
   cannot be mistyped into a different valid one).
3. It generates the outlet's **Bangla QR** with that reference embedded, and displays it.
4. The student pays from their own app. The money goes to PUC's bank account.
5. The next day's settlement file from the acquirer is imported, and each payment is matched
   to its order automatically.

### 3.2 Paying online — the payment gateway

A student can also pay an order **online**, through **SSLCommerz**, Bangladesh's largest
payment gateway. One session offers **bKash, Nagad, Rocket, upay, DBBL, IBBL, Citytouch,
City Bank, BRAC Bank** and card payments — 37 methods in total.

This matters for two reasons: it is how a student pays a fee from a hostel room rather than
at a counter, and it is the path that works when a phone camera will not focus on a QR.

**The money never touches this system.** It goes from the student to PUC's own merchant
account at the gateway. What this system does is record which order was paid, and prove it:

```
  1. order raised     DR receivable          CR revenue        goods left the counter
  2. student pays     DR gateway clearing    CR receivable     the gateway holds the money
                      DR gateway fee
  3. gateway settles  DR bank                CR gateway clearing   money reaches PUC
```

Stage 2 and stage 3 are deliberately separate. SSLCommerz settles on a T+n cycle, so
between them there is real money that the university has earned but does not yet hold. The
**clearing** account makes that float visible instead of pretending the cash is already in
the bank. The gateway's commission is booked as an expense rather than quietly absorbed.

**Verified against the real gateway**, not a simulation:

```
order_ref   : PUC-1-3KY42NMW           amount: ৳85.00
methods     : 37 available — bKash, Nagad, upay, DBBL, IBBL, Citytouch, City Bank, BRAC …
checkout page HTTP: 200
ledger drift: 0
```

Payments are confirmed **server-to-server**. The browser returns from the gateway carrying
parameters a student could edit, so none of them are trusted — only the gateway's own
answer, checked against the amount the order asked for, marks anything paid. Without that,
a student could open an ৳85 session and hand-craft a ৳10,000 confirmation.

A student who pays twice — once online, once by scanning the QR — is detected at
reconciliation and flagged with the amount owed back and the transaction that already
cleared the order, rather than being silently double-counted.

### 3.3 The ledger

Every order and every settlement is recorded in a **double-entry ledger**. This is not
decorative — it is what allows the university's accounts office to answer "where is the
money?" without trusting the application.

Enforced in PostgreSQL itself, not in application code:

| Invariant | How it is enforced |
|---|---|
| Every posting balances (debits = credits) | a deferred constraint trigger checked at `COMMIT`, so it cannot be evaded by ordering |
| Entries are never edited or deleted | triggers that reject `UPDATE` and `DELETE` outright |
| A correction is a **reversal**, never a rewrite | the original stays visible; the audit trail is complete |
| One acquirer transaction settles at most one order | a partial unique index — attempted duplicates are still *recorded* as exceptions rather than silently dropped |
| The same statement cannot be imported twice | a SHA-256 of the exact file contents, unique |

That last one is the guard against the most likely operator error: uploading the same bank
statement twice and doubling the books. It is refused.

### 3.4 Reconciliation

The **Reconcile** screen is built around the question an accounts officer actually asks each
morning: *does what the bank sent us match what we sold, and if not, exactly where?*

The exceptions lead the screen; the totals are secondary. Two lists:

- **Money received that no order explains** — usually a static QR where the payer typed the
  amount, or a mistyped reference.
- **Sold, but no payment received** — goods left the counter. Anything older than about a day
  means something upstream is broken.

Both are actionable lists of specific transactions, not a summary figure.

### 3.5 The nightly audit

An automated job runs three checks and records the verdict permanently:

| Check | Verdict if it fails |
|---|---|
| Trial balance — total debits equal total credits | **FAIL** (exit code 1) |
| Cross-check — per-outlet order totals agree with the ledger | **FAIL** (exit code 1) |
| Aged receivables / unmatched receipts | **WARN** (exit code 0) |

A WARN deliberately exits 0. If routine ageing paged somebody every night, the alert would
be muted within a fortnight and the FAIL would be missed with it.

A FAIL is surfaced to the dashboard as **HTTP 409**, not 200 — a disagreement between the
books and reality is an alarm, not a successful read.

### 3.6 Verification

The system has **300 automated tests across 19 suites, all passing**, covering the ledger
invariants, the QR encoder, the order flow, reconciliation, the audit job and the HTTP
surface. They run against a real PostgreSQL database, not a simulated one, so the database
constraints described above are proven rather than assumed. The CRC-16 check-digit
implementation is verified against the authoritative CRC-16/CCITT-FALSE catalogue value.

Concurrency is tested deterministically, not by racing threads and hoping: the case where two
phones scan the same QR simultaneously is proven to settle exactly once.

---

## 4 · What PUC gets out of it

| Today | With this system |
|---|---|
| Student emails `accounts@puc.ac.bd` with transaction details | nothing to email; the reference is in the payment |
| Fees paid only by internet banking or BEFTN | also payable online by bKash, Nagad, upay, card — 37 methods |
| Accounts staff retype transaction IDs into a spreadsheet | automatic matching; staff see only what did *not* match |
| "Has my payment been credited?" answered by hand | answered by the student's own screen |
| A missed payment is found when someone complains | found by the nightly audit, with the exact transaction |
| Proprietary campus QR (non-compliant since 1 July 2026) | Bangla QR, compliant, payable from any app |

---

## 5 · What PUC must do — these steps cannot be done in software

Everything below requires the university acting as an institution. The software is complete
and waiting for each of these; none of them is a development task.

### 5.1 Acquirer merchant onboarding — the blocking item

PUC must open a **merchant account with an acquiring bank** (UCB, Islami Bank, City Bank,
BRAC Bank and others all acquire Bangla QR). The bank issues, per outlet:

- an **acquirer GUID** (e.g. `BD.COM.UCB`)
- a **merchant ID** at the acquirer
- an approved **merchant name** (≤ 25 characters) and **city** for the QR

Nothing can be collected until this exists. The system stores these fields against each
outlet and refuses to trade without them.

**PUC will be asked for:**

| Document | Held by |
|---|---|
| **EIIN** (institution identification number) | Registrar |
| **Board / Syndicate resolution** authorising the account and naming signatories | Registrar / Board of Trustees |
| Registrar's recommendation letter | Registrar |
| University **bank account** for settlement | Controller of Accounts |
| **TIN**, and trade licence if the outlets are separately constituted | Accounts |
| Signatory **NID** copies and photographs | named officers |

> **Suggested first step:** approach the university's existing banker first. An acquiring
> relationship with a bank that already holds PUC's accounts is materially faster, because
> the KYC is already done.

### 5.2 Decide the outlet perimeter

Which counters go live first, and whether each is a separate merchant at the acquirer or all
share one. Recommendation: **one merchant ID per outlet**. It costs nothing extra and it
makes per-outlet reconciliation exact rather than apportioned — which is the difference
between the accounts office trusting the numbers and not.

### 5.3 Name an owner in the Accounts office

One named person who opens the Reconcile screen each morning and clears exceptions. This is
about 10 minutes a day. Without a named owner the exception list grows until it is ignored,
and the system's main benefit is lost.

### 5.4 Online fee collection (optional, second phase)

For fee payment online rather than at a counter, PUC needs an **SSLCommerz Educational
Institution merchant account** (SSLCommerz has a specific category for institutions, at
preferential rates). This requires the same institutional documents as §5.1. The gateway
integration is already built and tested against the sandbox; it needs live credentials.

### 5.5 Data protection

The **Personal Data Protection Ordinance 2025** applies to student data. Before go-live PUC
should confirm the retention period for transaction records and publish a privacy notice.
The system holds the minimum: name, email, phone, and transaction records. It does not hold
card numbers, bank credentials, or any payment instrument data — those never reach it.

### 5.6 Infrastructure

A server (or managed hosting), a domain, and a TLS certificate. Modest — the system is a
single API and a PostgreSQL database. Deployment is documented in `DEPLOY.md`.

---

## 6 · Honest limitations

Stated plainly, because a proposal that claims no limitations should not be trusted.

- **Settlement matching is next-day, not real-time.** Acquirers deliver settlement files on a
  daily cycle. A student's payment confirms on their own banking app immediately, but the
  university's record marks it settled the following day. Real-time confirmation would
  require a webhook integration that each acquirer offers on different terms — worth
  negotiating during onboarding, but not assumed here.
- **Static-QR payments cannot always be matched automatically.** If an outlet displays a
  fixed printed QR and the payer types the amount themselves, there is no order reference in
  the payment. Those land in the exceptions list for a human. Using a **dynamic QR per
  order** — which is what this system generates — avoids the problem entirely.
- **No real money has moved yet, and this is the most important line in this document.**
  The gateway integration is real and runs against SSLCommerz's own servers, but on their
  **sandbox** store — test money. Going live needs a merchant account (§5.1, §5.4), which
  needs PUC's documents. What has been proven is that the integration is correct; what has
  not been proven is any commercial arrangement. The first week of a live pilot should be
  treated as a pilot and reconciled by hand in parallel.
- **The Bangla QR has not been scanned by a real bank app.** The payload is built to the
  EMVCo standard and its checksum verifies against the published reference value, but only
  an acquirer-issued merchant identifier makes a QR actually payable, and PUC does not have
  one yet. Until then the counter refuses to print one at all, by design.
- **One outlet, one operator account.** Shift handover between two staff on one counter is
  not modelled. If PUC needs per-shift attribution, that is a small addition.

---

## 7 · Suggested pilot

| Stage | What happens | Blocked on |
|---|---|---|
| 1 | Acquirer onboarding for **one** outlet — the main canteen | §5.1 |
| 2 | Two weeks live, reconciled by hand in parallel each morning | §5.3 |
| 3 | Review: exception rate, staff time saved, student feedback | — |
| 4 | Extend to remaining outlets | stage 3 |
| 5 | Online fee collection | §5.4 |

Starting with one outlet is deliberate. It keeps the failure surface small, and two weeks of
parallel manual reconciliation is what turns "it should match" into evidence that it does.

---

## 8 · Contact

Built by **Omar Jamal**, CSE, Premier University Chattogram.

The source code, the full test suite, the database migrations and the deployment
instructions are all included. Nothing is hidden behind a service the university would
depend on: PUC can host it, audit it, and change it.
