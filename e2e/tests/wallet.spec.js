import { test, expect } from '@playwright/test';
import pg from 'pg';

/**
 * End-to-end flows through the real browser, real API, and real PostgreSQL.
 * Every test creates its own users, so no test depends on another's state or on
 * whatever happens to be in the seeded database.
 */

const PASSWORD = 'password123';
const uniqueEmail = (tag) => `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@puc.ac.bd`;

async function register(page, email, name = 'Test Student') {
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('input-name').fill(name);
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(PASSWORD);
  await page.getByTestId('input-confirm').fill(PASSWORD);  // registration now confirms the password
  await page.getByTestId('btn-submit').click();
  // A new account lands on the Account (verify phone) screen, not the wallet — go to it.
  await page.getByTestId('tab-wallet').click();
  await expect(page.getByTestId('balance')).toBeVisible();
}

/**
 * Credit a wallet by talking to the database directly.
 *
 * Deliberate choice: the alternative — a /test/credit endpoint on the API — would mean
 * shipping a money-creating route inside the production artifact, protected only by an
 * environment check. One misconfigured NODE_ENV and anyone can mint balance. The test
 * harness reaches around the app instead, so no test seam exists in the deployed code.
 */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5433/campus_wallet',
});

test.afterAll(async () => { await pool.end(); });

async function creditWallet(email, paisa) {
  const res = await pool.query(
    `UPDATE wallets SET balance_paisa = balance_paisa + $1
       WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($2))
     RETURNING balance_paisa`,
    [paisa, email]
  );
  if (res.rowCount !== 1) throw new Error(`could not credit wallet for ${email}`);
}

test('a new student can register and sees a zero balance', async ({ page }) => {
  await register(page, uniqueEmail('new'));
  await expect(page.getByTestId('balance')).toHaveText('৳0.00');
  await expect(page.getByTestId('tx-empty')).toBeVisible();
});

test('sending money moves the balance and appears in both histories', async ({ page }) => {
  const senderEmail = uniqueEmail('sender');
  const recipientEmail = uniqueEmail('recipient');

  // Recipient exists first.
  await register(page, recipientEmail, 'Recipient');
  await page.getByTestId('btn-signout').click();

  // Sender registers and is credited ৳500.
  await register(page, senderEmail, 'Sender');
  await creditWallet(senderEmail, 500_00);
  await page.reload();
  await expect(page.getByTestId('balance')).toHaveText('৳500.00');

  // Send ৳120.50 with the two-step confirm.
  await page.getByTestId('tab-send').click();
  await page.getByTestId('input-to').fill(recipientEmail);
  await page.getByTestId('input-amount').fill('120.50');
  await page.getByTestId('btn-review').click();
  await expect(page.getByTestId('confirm-amount')).toHaveText('৳120.50');
  await page.getByTestId('btn-confirm').click();

  // Sender's balance drops and the transaction is listed.
  await expect(page.getByTestId('toast-ok').last()).toContainText('Sent ৳120.50');
  await expect(page.getByTestId('balance')).toHaveText('৳379.50');
  await expect(page.getByTestId('tx-list')).toContainText(recipientEmail);
  await expect(page.getByTestId('tx-amount').first()).toContainText('−৳120.50');

  // Recipient sees the credit.
  await page.getByTestId('btn-signout').click();
  await page.getByTestId('input-email').fill(recipientEmail);
  await page.getByTestId('input-password').fill(PASSWORD);
  await page.getByTestId('btn-submit').click();
  await expect(page.getByTestId('balance')).toHaveText('৳120.50');
  await expect(page.getByTestId('tx-amount').first()).toContainText('+৳120.50');
});

test('overdrawing is refused before any money moves', async ({ page }) => {
  const sender = uniqueEmail('poor');
  const recipient = uniqueEmail('target');
  await register(page, recipient, 'Target');
  await page.getByTestId('btn-signout').click();

  await register(page, sender, 'Poor Student');
  await creditWallet(sender, 100_00);
  await page.reload();

  await page.getByTestId('tab-send').click();
  await page.getByTestId('input-to').fill(recipient);
  await page.getByTestId('input-amount').fill('500');
  await page.getByTestId('btn-review').click();

  // Client-side guard catches it before a request is even sent.
  await expect(page.getByTestId('send-error')).toContainText('only have ৳100.00');
  await page.getByTestId('tab-wallet').click();
  await expect(page.getByTestId('balance')).toHaveText('৳100.00');
});

test('four rapid transfers trip the velocity rule and the transfer is flagged', async ({ page }) => {
  const sender = uniqueEmail('fast');
  const recipient = uniqueEmail('friend');
  await register(page, recipient, 'Friend');
  await page.getByTestId('btn-signout').click();

  await register(page, sender, 'Fast Sender');
  await creditWallet(sender, 1000_00);
  await page.reload();

  // The velocity rule trips on the 4th transfer inside 60 seconds.
  for (let i = 1; i <= 4; i++) {
    await page.getByTestId('tab-send').click();
    await page.getByTestId('input-to').fill(recipient);
    await page.getByTestId('input-amount').fill('10');
    await page.getByTestId('btn-review').click();
    await page.getByTestId('btn-confirm').click();
    await expect(page.getByTestId('toast-ok').last()).toBeVisible();
  }

  // Assert the RULE NAME, not the sentence around it. "flagged" was UI copy and broke
  // the moment the wording changed to "held for review"; VELOCITY is a domain constant
  // that only changes if the rule itself does.
  // Toasts stack: four sends in a row leave several on screen, so read the newest.
  await expect(page.getByTestId('toast-ok').last()).toContainText('VELOCITY');
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('tx-flagged').first()).toBeVisible();
});
