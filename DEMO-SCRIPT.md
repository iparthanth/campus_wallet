# Campus Wallet — how to demo it

A script to run in front of PUC, or anyone else. Roughly **12 minutes**. Every step says
what to click, what will happen, and what to say while it happens.

**Live:** https://campus-wallet-prh5.onrender.com
**Every account uses the password** `password123`

---

## Before you start — 2 minutes of preparation

1. **Wake the server.** Open the link and sign in once. The free hosting tier sleeps after
   ~15 minutes idle and takes up to a minute to wake. Doing this cold in front of an
   audience looks like a broken product.

2. **Open two browser windows side by side.**
   - **Left — the counter:** sign in as `canteen@puc.ac.bd`
   - **Right — the student:** sign in as `partha@puc.ac.bd`

   This is the whole trick. The demo is a conversation between a shop and a customer, and
   showing both at once is what makes it land.

3. Have a **third tab** ready, signed in as `admin@puc.ac.bd`, for the finance section.

---

## The one sentence to open with

> "Right now, a PUC student pays fees by internet banking and then emails
> accounts@puc.ac.bd with the transaction number. This replaces that email."

Then show them, in this order.

---

## Part 1 — The counter takes a payment (4 min)

### On the LEFT window — `canteen@puc.ac.bd`

| Step | Do this | Say this |
|---|---|---|
| 1 | Click **Counter** | "This is the canteen's screen. One page, because staff are serving a lunch queue." |
| 2 | Amount: `85`. What for: `Rice, dal, egg` | — |
| 3 | Click **Show QR code** | "That's a **Bangla QR** — the national standard Bangladesh Bank made compulsory on 1 July 2026." |

**What appears:** the amount, a framed QR, the payment marks (bKash, Nagad, Rocket, upay),
and a reference like **`PUC-1-K9F2QT7M`**.

**Point at the reference and say:**

> "Read that aloud. There's no I, L, O or U in it — deliberately, so it can't be misheard
> as a different valid code across a noisy counter."

### On the RIGHT window — `partha@puc.ac.bd`

| Step | Do this | Say this |
|---|---|---|
| 4 | Click **Pay a bill** | — |
| 5 | Type the reference from the left window | "In real life the student scans the QR. Typing it is the fallback when a camera won't focus." |
| 6 | Click **Continue** | — |

**What appears:** the outlet name, **৳85.00**, the memo, a **Pay ৳85.00 online** button with
the payment marks, and the reference again.

| Step | Do this | Say this |
|---|---|---|
| 7 | Click **Pay ৳85.00 online** | "Now we leave our app entirely." |
| 8 | On the gateway page, click the **MOBILE BANKING** tab | "**This page is SSLCommerz's, not ours.** bKash, Nagad, Rocket, upay — 37 methods." |

> **Say this clearly, it is the most important sentence in the demo:**
>
> "We never see your bKash PIN. No merchant is allowed to. That screen belongs to the bank,
> on the bank's own domain — exactly like Daraz or Pathao. If we asked for your PIN, that
> would be a phishing page."

**If asked "is this real money?"** — Be straight: *"This is SSLCommerz's sandbox, so it's
test money. The integration is real and runs against their servers; going live needs PUC's
merchant account, which is a university decision, not a coding one."*

---

## Part 2 — What the student gets (2 min)

Back on the RIGHT window, click **Payments**.

**Point at the three tiles:**

- **Paid through this system** — the total
- **Awaiting confirmation** — paid, not yet matched to the bank's file
- **Balance held by the university — ৳0.00 · by design**

> "That third tile is the product. **The university holds none of your money.** You pay the
> outlet directly from your own bKash or bank app, and we record what you paid."

**Then point at a payment row:** outlet, memo, reference, status, amount.

> "A balance told you how much you had. This tells you what you paid, to whom, and the
> reference that proves it — which is the one thing that matters if a payment ever goes
> missing."

**If a payment shows "Awaiting confirmation", read the amber banner aloud.** It's the most
carefully written text in the app:

> "We cannot see your payment before the bank tells us about it. If your bKash app shows it
> went through, your money is safe. **Do not pay this order again.**"

---

## Part 3 — What the finance office gets (4 min)

**This is the section that decides adoption.** A student screen can be pretty; the accounts
office decides whether PUC buys it.

Switch to the **admin** tab — `admin@puc.ac.bd` — and click **Reconcile**.

| Step | Say this |
|---|---|
| 1 | "This is what an accounts officer opens each morning." |
| 2 | Point at the audit verdict: "**Books balance. Total debits equal total credits. Drift ৳0.00.** That's checked by a job that runs every night and records a permanent, dated verdict." |
| 3 | Point at the exception lists: "Money received that no order explains. Sold but never paid for. **The exceptions lead — the totals are secondary.**" |

> "A dashboard that says '৳48,300 collected ✓' and hides three unmatched payments in a tab
> is the same spreadsheet problem in nicer colours. This one leads with what needs a person."

**To show the settlement import**, paste this into the CSV box (use a reference from a real
order you raised):

```
UCB-88213,PUC-1-K9F2QT7M,85.00,1.70
```

> "That's the bank's statement. It matches each line to an order automatically. Re-uploading
> the same file is refused — a double upload can't double the books."

**Then click Dashboard** for the charts: volume, top senders, anything the fraud rules held
for review.

---

## Part 4 — The questions you will be asked

**"Is this legal? Do we need a licence?"**
> "No — and that's the core design decision. Under the Payment and Settlement Systems Act
> 2024, holding student balances means issuing a prepaid payment instrument, which needs a
> Bangladesh Bank licence and BDT 20 crore of capital. So the system holds nothing. The
> university is a merchant; the bank is the licensed party. The software **refuses to start**
> if anyone configures it to hold balances."

**"What do we have to do?"**
> "Open a merchant account with an acquiring bank. They'll want the EIIN, a board
> resolution, the Registrar's recommendation, and a bank account. That's §5 of the handover
> document. Nothing in the software can shortcut it — an outlet without acquirer credentials
> physically cannot print a QR."

**"What happens if a student pays twice?"**
> "It's detected at reconciliation and reported with the amount owed back and the
> transaction that already cleared the order. It's never silently double-counted."

**"How do we know the money is right?"**
> "Double-entry ledger, with the rules enforced inside PostgreSQL rather than in
> application code. Entries can never be edited or deleted — a correction is a reversal, so
> an auditor sees both the mistake and the fix."

**"Is it tested?"**
> "369 automated tests against a real database, run on every change."

---

## What NOT to claim

Say these plainly if asked. Credibility is the thing you're selling.

- **No real money has moved yet.** The gateway is real, on a sandbox store.
- **The Bangla QR hasn't been scanned by a real bank app.** It's built to the EMVCo standard
  and its checksum verifies, but only an acquirer-issued merchant ID makes one payable.
- **Confirmation is next-day**, because that's when settlement files arrive.
- **It's on free hosting**, so the first click after a quiet spell takes ~50 seconds.

---

## Every login

| Login | Role | Tabs they see |
|---|---|---|
| `partha@puc.ac.bd` | Student | Payments · Pay a bill · Account |
| `rima@puc.ac.bd` | Student | same |
| `imran@puc.ac.bd` | Student | same |
| `canteen@puc.ac.bd` | Operator — Central Canteen | **+ Counter** |
| `copy@puc.ac.bd` | Operator — Photocopy Corner | + Counter |
| `library@puc.ac.bd` | Operator — Library Fine Desk | + Counter |
| `admin@puc.ac.bd` | Admin | **+ Dashboard · Reconcile** |

Password for all: `password123`

---

## If something goes wrong mid-demo

| Symptom | What it is | What to say |
|---|---|---|
| First page load hangs ~50s | Free instance waking | "Free hosting — it sleeps when idle." |
| "This code is not valid" | Order expired (10 min) or a typo | Raise a fresh one on the counter. |
| Counter says "not live yet" | Outlet has no acquirer credentials | That's the gate working — §5.1. |
| Gateway page opens on **Cards** | SSLCommerz's default tab | Click **Mobile Banking** for bKash. |
