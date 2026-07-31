import { test, expect } from '@playwright/test';
import pg from 'pg';

/**
 * The PRODUCTION flow, end to end in a real browser.
 *
 * This file exists because its absence let a real break reach CI unnoticed. The student's
 * balance was removed — correctly, since holding one is unlawful — and every E2E test
 * failed on `getByTestId('balance')`. The suite only knew how to drive the closed-loop
 * demo, so nothing had ever exercised the configuration that actually ships.
 *
 * Zero-float is what production runs: no balance, no transfers, no top-up. A student is
 * shown an order at a counter and pays it from their own bank or MFS app. What this suite
 * proves is that the screens a real student touches work in a real browser.
 */

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
test.afterAll(() => pool.end());

const unique = (p) => `${p}${Date.now()}${Math.floor(Math.random() * 1000)}@puc.ac.bd`;

async function register(page, email) {
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('input-name').fill('Test Student');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill('password123');
  await page.getByTestId('input-confirm').fill('password123');
  await page.getByTestId('btn-submit').click();
  // A new account lands on Account (verify phone); the payments screen is a tab away.
  await page.getByTestId('tab-wallet').click();
}

test('a student sees a payment record, not a balance', async ({ page }) => {
  await register(page, unique('zf'));

  await expect(page.getByTestId('paid-total')).toBeVisible();
  // The whole compliance posture, asserted where a student would notice it.
  await expect(page.getByTestId('balance')).toHaveCount(0);
  await expect(page.getByTestId('zero-float-note')).toContainText('never holds your money');
});

test('the screens that move money are absent, not merely hidden', async ({ page }) => {
  await register(page, unique('zf'));

  // Sending balance and topping up do not exist in this mode.
  await expect(page.getByTestId('tab-send')).toHaveCount(0);
  await expect(page.getByTestId('tab-topup')).toHaveCount(0);

  // And the API refuses even when asked directly — a hidden button is not a control.
  const refusal = await page.evaluate(async () => {
    const t = localStorage.getItem('cw_token');
    const r = await fetch('/api/topup/ssl/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ amount_paisa: 50_000 }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  expect(refusal.status).toBe(409);
  expect(refusal.body.error.code).toBe('ZERO_FLOAT');
});

test('an unknown order code is refused rather than silently accepted', async ({ page }) => {
  await register(page, unique('zf'));
  await page.getByTestId('tab-pay').click();
  await page.getByTestId('input-charge-code').fill('not-a-real-order-code');
  await page.getByTestId('btn-lookup-charge').click();
  await expect(page.getByTestId('pay-error')).toBeVisible();
});

test('a student can look up a real order and is offered the gateway', async ({ page }) => {
  const email = unique('zf');
  await register(page, email);

  /*
   * Raise a genuine order as the counter would. Done over the API rather than by driving
   * the Counter screen so that a failure here points at the STUDENT flow — the thing this
   * test is about — instead of at operator UI that has its own coverage.
   */
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'canteen@puc.ac.bd', password: 'password123' },
  });
  const { token } = await login.json();
  const raised = await page.request.post('/api/orders', {
    headers: { Authorization: `Bearer ${token}` },
    data: { amount_paisa: 8500, memo: 'Rice, dal, egg' },
  });
  expect(raised.status()).toBe(201);
  const order = await raised.json();

  await page.getByTestId('tab-pay').click();
  await page.getByTestId('input-charge-code').fill(order.token);
  await page.getByTestId('btn-lookup-charge').click();

  await expect(page.getByTestId('order-detail')).toBeVisible();
  await expect(page.getByTestId('pay-amount')).toHaveText('৳85.00');
  // The reference is the student's protection in a dispute, so it must be on screen.
  await expect(page.getByTestId('ref-chip')).toContainText(order.order_ref);
  // And the way to actually pay.
  await expect(page.getByTestId('btn-pay-online')).toBeVisible();
});

test('the counter issues a Bangla QR with a copyable reference', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('input-email').fill('canteen@puc.ac.bd');
  await page.getByTestId('input-password').fill('password123');
  await page.getByTestId('btn-submit').click();

  await page.getByTestId('tab-counter').click();
  await page.getByTestId('input-charge-amount').fill('85');
  await page.getByTestId('input-charge-memo').fill('Rice, dal, egg');
  await page.getByTestId('btn-raise-charge').click();

  await expect(page.getByTestId('order-qr')).toBeVisible();
  // Crockford base32, so a reference read aloud across a noisy counter cannot be heard
  // as a different valid one.
  await expect(page.getByTestId('ref-chip')).toContainText(/PUC-\d+-[0-9A-HJ-NP-TV-Z]{8}/);
});
