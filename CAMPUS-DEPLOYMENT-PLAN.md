# Taking Campus Wallet to a Real Campus

Researched July 2026. Every figure below is sourced; where a fact is inference it says so.
Read §1 before anything else — it changes the product, not just the paperwork.

---

## 1 · The two findings that change the design

### 1.1 Holding student balances is a criminal offence without a licence

The wallet as currently built lets a student **top up now and spend later**. In Bangladesh
that is *stored value* — e-money — and it is a licensed activity.

| What | Requirement |
|---|---|
| PSP licence (e-wallet / e-money issuance) | **BDT 20 crore** paid-up capital |
| Draft Dedicated E-Money Issuer (Nov 2025) | **BDT 50 crore** paid-up capital |
| PSO licence (gateway/aggregator) | BDT 0.5–5 crore, and the principal participant must be a scheduled bank |

Operating without one, under the **Payment and Settlement Systems Act 2024**:
**up to 5 years' imprisonment and/or a fine up to BDT 50 lakh** — and the offence is
**cognizable, non-bailable and non-compoundable**.

There is a "Closed Prepaid Instrument" carve-out for spend-only-at-the-issuer's-own-outlets,
but reported terms still assume a corporate issuer with Tk 20 crore paid-up. It is not a
student-scale escape hatch.

> **Consequence:** never custody student money. The product must become a
> **zero-float** ordering + ledger + reconciliation layer, where payment happens directly
> between the student and the outlet over licensed rails. That is not a compromise — it is
> what makes a pilot legal, and it is a genuinely better story in an interview.

### 1.2 Bangla QR is mandatory since 1 July 2026 — a custom QR is a dead end

Bangladesh Bank made the interoperable **Bangla QR** compulsory from **1 July 2026** for all
banks, MFS providers, PSPs, PSOs and merchants, and required everyone who ran a proprietary
QR to **replace it**. Bangla QR reached ~9.63 lakh merchants with 46 banks, 7 MFS providers
and 4 PSPs participating.

The `campuswallet://pay/<token>` QR in this repo is exactly the proprietary QR the directive
outlaws. **For production it must be replaced by the outlet's own Bangla QR**, payable from
bKash, Nagad, Rocket or any bank app. The app's QR survives only as an *internal order
reference*, never as the payment instrument.

### 1.3 The competition is banks, not students

| Who | Where | What |
|---|---|---|
| **Islami Bank + Mastercard** | **Chittagong University (Oct 2025)** | Fully cashless campus: Bangla QR + POS at cafeterias, bookstores, admin offices, campus train station; free co-branded student debit card |
| Islami Bank + Mastercard | Rajshahi University (Sept 2025) | Bangladesh's first "fully cashless campus" |
| Upay (UCB Fintech) | UCSI University BD campus | QR merchant payments, tuition, scholarship disbursement, planned RFID |
| **1Card** (Daffodil Software) | DIU and others | **~39,500 student cards** at DIU; NFC tap + QR, canteen, bus, gym, printing, tuition |
| RU Smart ID Card Cell | Rajshahi University | University-owned; MIFARE DESFire EV1, AES-128. Started 2013, became a department in 2025 — **12 years** |

This is a real market with funded incumbents. Competing head-on as a solo student is not the
play. The next section is.

---

## 2 · The opening — and it is at your own university

**Premier University Chattogram's fee payment is still manual.** Its published procedure asks
students to pay by internet banking or BEFTN, then **email `accounts@puc.ac.bd`** with the
transaction details, student name and ID — with a warning that *"the deposit will not be
updated unless this information is provided."* No gateway integration appears anywhere in
the published process.

That is a specific, verifiable, unglamorous pain point:

- Students cannot see whether their payment was recorded
- Accounts staff reconcile by hand from an inbox
- Every mistyped student ID becomes a support conversation

**This — not the canteen — is the wedge.** It needs no float, no licence, and no card
hardware: an online fee-payment page where the *university* is the merchant of record, plus
automatic reconciliation that replaces the email step.

---

## 3 · Who holds the merchant account (the part that makes it legal)

**The university does. Not you.**

SSLCommerz has an **Educational Institution** onboarding category that replaces the trade
licence with institutional documents:

- Recommendation from the **VC or Registrar**
- **EIIN** (Educational Institution Identification Number)
- Board resolution / trustee authorisation
- Authorised signatory's NID, bank cheque leaf, sealed Merchant Enrolment Form

Precedent: **SSLCommerz signed with the University of Dhaka** for online student fee
collection. bKash separately serves **800+ educational institutions** with fee collection and
scholarship disbursement.

Funds settle into the **university's own bank account**. You supply software. You never touch
money, so §1.1 never applies to you.

### Gateway economics (published rates)

| Gateway | Setup | Cards | MFS (bKash/Nagad/Rocket) |
|---|---|---|---|
| **aamarPay — aamarEducation** | one-time, no monthly | **1.85%** | **1.75%** ← cheapest for campus |
| SSLCommerz | BDT 25,500 | 2.5% | 2.5% (Amex 3.5%) |
| PortPos Business | **BDT 0** | 2.59% | 2.20% + BDT 1/txn |
| ShurjoPay | ~BDT 15,500 | negotiated | negotiated |

Settlement is typically T+1 to T+3. Going live takes **~10–15 working days** after documents
are accepted; **DBID** (dbid.gov.bd) is the slowest prerequisite and gates the bank account
too — only ~1,240 issued against 8,852 applications, so start it first.

---

## 4 · The zero-float architecture

```
   Student app                     Outlet (canteen)
        │                                │
        │  1. sees order + amount        │  raises order in the app
        │                                │
        │  2. pays via bKash/Nagad/bank ─┼──►  outlet's own BANGLA QR
        │     (licensed rails, direct)   │      → outlet's bank account
        │                                │
        └──3. app records the reference ─┘
                     │
              ledger + reconciliation + reporting
              (NEVER holds money)
```

What the software still does — and it is plenty:

- Ordering and the counter queue
- **Reconciliation**: matching gateway/bank references to orders, which is precisely the
  manual email work PUC does today
- Student-facing history, receipts, and spend reports
- Outlet takings, settlement reports, dispute evidence
- Fee collection with automatic ledger posting

What it must stop doing in production: **holding a balance**.

---

## 5 · Compliance you cannot skip

**Personal Data Protection Ordinance (PDPO) 2025** — approved 9 October 2025, gazetted
6 November 2025. Handling student names, IDs, phone numbers and transaction histories makes
you a **data fiduciary**. Consent must be voluntary, specific, informed, unambiguous and
withdrawable. Budget for: a written consent flow, a privacy notice, data-retention limits,
export/delete, and breach procedure.

**BTRC SMS rules** — bulk SMS templates must be in **Bengali** (effective 7 March 2022);
OTPs, digits and URLs may stay English. A2P SMS must go through a **BTRC-enlisted
aggregator**. A **non-masking** account needs only an **NID** (an individual can buy credits
today, from ~BDT 100); a **branded sender ID** requires a trade licence and 3–15 working days
of approval.

---

## 6 · The plan, in order

### Phase 0 — now, costs nothing
- Keep SSLCommerz in **sandbox**. Label the demo honestly as closed-loop.
- Ship **zero-float mode** in the code (§4) so the architecture is defensible on day one.
- Buy ~BDT 100 of non-masking SMS credit under your NID → real OTP to any BD SIM.
- Write the one-page pitch around **fee reconciliation**, not the canteen.

### Phase 1 — the pilot that needs no licence and no money
Target **one** outlet or **the fee desk** at Premier University.
- Ask the **Registrar** for a letter of interest. Bring: working demo, the DU/SSLCommerz
  precedent, the CU cashless-campus example from your own city, and a one-page data-protection note.
- The outlet keeps its **own Bangla QR**; your app does ordering + reconciliation only.
- Success metric: hours of accounts-staff time saved per week, and reconciliation error rate.

### Phase 2 — institutional
- University applies for the SSLCommerz/aamarPay **Educational Institution** account
  (EIIN + Registrar recommendation + board resolution). Start **DBID** in parallel.
- You integrate. Money settles to the university. You hold a software contract, not funds.

### Phase 3 — fund it, then incorporate
- **iDEA Pre-Seed Grant** — up to **BDT 10 lakh, zero equity**. Needs only NID, idea
  description, video, deck, prototype. You have the prototype.
- **CUET ITBI** (Chattogram) — campus incubator, explicitly open to students from other
  Chattogram universities; most applicants bring project/thesis work. You are in the city.
- **Startup Bangladesh Ltd** — up to Tk 1 crore seed, max 49% equity, after a working pilot.
- If incorporating: use a **private limited** (no statutory minimum capital in practice).
  **Avoid a One Person Company** — OPC requires BDT 25 lakh paid-up.

### Phase 4 — scale
- ~170 universities in Bangladesh: low-volume, high-touch enterprise selling, not a consumer app.
- Public universities (CUET, CU) procure under the **Public Procurement Act** through
  **e-GP** — an individual cannot easily bid. Private universities decide internally, which
  is why Premier University is the right first door.
- Or sell **through** an incumbent: GeniusEdu, Pipilika Soft, Extreme Solutions (Chattogram),
  Mysoft Heaven already sell campus ERP with fee modules and lack good reconciliation UX.

---

## 7 · How a student would actually use it, day to day

1. **Onboard** — sign in with the university email; verify the phone by OTP (real SMS).
2. **Pay fees** — see the amount due, pay through the university's gateway, get an instant
   digital receipt. **No email to accounts@puc.ac.bd.**
3. **Buy lunch** — counter raises the order; student pays the outlet's Bangla QR from
   whichever app they already have; the order closes automatically on reconciliation.
4. **See history** — every payment, receipt and pending item in one place.
5. **Never hold a balance** — nothing to top up, nothing to lose, nothing that needs a licence.

---

## 8 · Honest risks

- **Banks may simply do it.** Islami Bank + Mastercard already converted CU in your city.
  Your defensible ground is **software quality and reconciliation**, not payment rails.
- **1Card is entrenched** at DIU with ~39,500 cards and a full module suite.
- **Procurement is slow** and public universities are effectively closed to individuals.
- **PDPO 2025 is new** and enforcement practice is unsettled; treat student data conservatively.
- **The float temptation** — every "just let them keep a small balance" request is a request
  to commit a non-bailable offence. The answer is always no.

---

## Sources

Bangladesh Bank / PSS Act 2024 licensing and penalties; draft PSO Regulation 2025 and draft
E-Money Issuer rules (Nov 2025); Bangla QR mandate effective 1 July 2026 and NPSB
interoperability (1 Nov 2025); SSLCommerz onboarding-requirements and pricing pages;
SSLCommerz–University of Dhaka agreement (TBS News); aamarPay, PortPos and ShurjoPay pricing
pages; Islami Bank–Mastercard cashless campus launches at Rajshahi University (Sept 2025) and
University of Chittagong (Oct 2025); Upay–UCSI partnership; 1Card (Daffodil Software) product
and deployment figures; RU Smart ID Card Cell; bKash education fee-collection service;
Premier University Chattogram published payment procedure; PDPO 2025 (gazetted 6 Nov 2025);
BTRC A2P SMS memorandum (7 March 2022) and enlisted-aggregator list; Alpha SMS, BulkSMSBD,
OneCodeSoft, REVE and MiMSMS published pricing and APIs; iDEA Pre-Seed Grant; Startup
Bangladesh Ltd; CUET ITBI; RJSC/OPC capital requirements; Public Procurement Act 2006 / PPR
2025 and e-GP.
