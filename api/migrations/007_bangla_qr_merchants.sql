-- Bangla QR merchant onboarding.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Bangladesh Bank made the interoperable Bangla QR compulsory from 1 July 2026 and
-- required proprietary QR codes to be replaced. This project shipped
-- `campuswallet://pay/<token>`, which only its own app can read — precisely the shape the
-- directive outlaws, and useless to a student holding bKash or a bank app.
--
-- THE HARD BOUNDARY THIS MODELS
-- -----------------------------
-- A payable Bangla QR embeds a merchant identifier ISSUED BY AN ACQUIRING BANK OR MFS.
-- No application can invent one. Until PUC completes merchant onboarding — which requires
-- the university's own authority: EIIN, Registrar recommendation, board resolution, bank
-- account — every outlet here is un-onboarded, and the code must refuse to present a QR
-- that would be declined at the counter.
--
-- These columns make that state explicit and queryable, so "which outlets are actually
-- live?" is answered by the database rather than by someone's memory.

-- Which acquirer onboarded this outlet: 'UCB', 'bKash', 'Islami Bank', 'SSLCommerz'.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS acquirer_name TEXT;

-- The scheme's globally unique identifier, sub-tag 00 of the merchant account template.
-- Reverse-domain, assigned by the acquirer — e.g. 'BD.COM.UCB'.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS acquirer_guid TEXT;

-- The merchant identifier the acquirer issued. This is the field that makes a QR payable.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS acquirer_merchant_id TEXT;

-- Which EMVCo template tag (26–51) the acquirer told us to use. Defaults to 29, but the
-- acquirer decides, and getting it wrong makes the QR unreadable by their own app.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS acquirer_template_tag CHAR(2) DEFAULT '29'
  CHECK (acquirer_template_tag IS NULL OR acquirer_template_tag ~ '^(2[6-9]|3[0-9]|4[0-9]|5[01])$');

-- Tag 59 is capped at 25 characters, so the legal outlet name usually will not fit and a
-- separate display name is required. Truncating silently would produce a QR whose
-- merchant name does not match the bank record.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS qr_merchant_name TEXT
  CHECK (qr_merchant_name IS NULL OR length(qr_merchant_name) BETWEEN 1 AND 25);

-- Tag 60, capped at 15.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS qr_city TEXT DEFAULT 'Chattogram'
  CHECK (qr_city IS NULL OR length(qr_city) BETWEEN 1 AND 15);

-- The gate. False until a human confirms the acquirer has issued credentials.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS acquirer_issued BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

/*
 * An outlet cannot be marked live without the fields that make its QR payable.
 *
 * Written as a table constraint rather than trusting the application, because the failure
 * mode is a queue of students at a counter whose payments are all declined — and the
 * person who flips the flag is an administrator in a hurry, not a developer.
 */
DO $$ BEGIN
  ALTER TABLE merchants ADD CONSTRAINT acquirer_fields_complete CHECK (
    acquirer_issued = false OR (
      acquirer_name        IS NOT NULL AND
      acquirer_guid        IS NOT NULL AND
      acquirer_merchant_id IS NOT NULL AND
      qr_merchant_name     IS NOT NULL AND
      qr_city              IS NOT NULL AND
      onboarded_at         IS NOT NULL
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One acquirer merchant id is one outlet. Two outlets sharing an id would make their
-- settlements indistinguishable, which breaks reconciliation at the only point it matters.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_acquirer_mid
  ON merchants (acquirer_name, acquirer_merchant_id)
  WHERE acquirer_merchant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_merchants_live ON merchants (acquirer_issued) WHERE acquirer_issued = true;

-- ------------------------------------------------------------------ orders carry a reference

/*
 * The order reference is what ties a payment back to an order.
 *
 * It travels in EMVCo tag 62, sub-tag 05 (Reference Label) and comes back in the
 * acquirer's settlement file. Without it a payment can be received but never matched, and
 * the reconciliation this system exists to automate degrades to the manual email process
 * PUC runs today.
 *
 * Kept SHORT (<=25 chars) because tag 62/05 is capped, and human-legible because a staff
 * member will read it off a settlement report.
 */
ALTER TABLE charges ADD COLUMN IF NOT EXISTS order_ref TEXT;
ALTER TABLE charges ADD COLUMN IF NOT EXISTS bangla_qr_payload TEXT;

-- Links the order to the ORDER_RAISED posting in the double-entry ledger.
ALTER TABLE charges ADD COLUMN IF NOT EXISTS ledger_posting_id BIGINT
  REFERENCES ledger_postings(id) ON DELETE RESTRICT;

DO $$ BEGIN
  ALTER TABLE charges ADD CONSTRAINT order_ref_shape
    CHECK (order_ref IS NULL OR order_ref ~ '^[A-Z0-9-]{6,25}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_charges_order_ref
  ON charges (order_ref) WHERE order_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_charges_posting ON charges (ledger_posting_id)
  WHERE ledger_posting_id IS NOT NULL;
