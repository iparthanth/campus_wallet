-- Phone verification for students.
--
-- Distinct from payment OTP: this proves the person holds the SIM before they can move
-- money, which is what makes a lost-password recovery or a fraud investigation possible.
-- The payment PIN/OTP belongs to bKash or the bank and never touches this system.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

-- One verified phone per account: sharing a number would break the "who is this student"
-- guarantee the whole point of verification rests on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_verified
  ON users (phone) WHERE phone_verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS phone_verifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone       TEXT        NOT NULL,
  -- The code is stored HASHED. A leaked database must not hand an attacker a list of
  -- live OTPs, exactly as it must not hand them passwords.
  code_hash   TEXT        NOT NULL,
  attempts    INT         NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phone_ver_user ON phone_verifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_ver_open ON phone_verifications (user_id)
  WHERE consumed_at IS NULL;
