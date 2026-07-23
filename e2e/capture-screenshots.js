/**
 * Generates the README screenshots from the real running app.
 * Run with: node capture-screenshots.js   (API on :3000, web on :5173)
 */
import { chromium } from '@playwright/test';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';

const OUT = '../docs/screenshots';
const pool = new pg.Pool({ connectionString: 'postgres://wallet:wallet@localhost:5433/campus_wallet' });
const stamp = Date.now();
const sender = `demo_sender_${stamp}@puc.ac.bd`;
const friend = `demo_friend_${stamp}@puc.ac.bd`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 460, height: 900 }, deviceScaleFactor: 2 });

async function register(email, name) {
  await page.goto('http://localhost:5173/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('input-name').fill(name);
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill('password123');
  await page.getByTestId('btn-submit').click();
  await page.getByTestId('balance').waitFor();
}

// 1 — sign in screen
await page.goto('http://localhost:5173/');
await page.screenshot({ path: `${OUT}/1-signin.png` });

await register(friend, 'Rima Das');
await page.getByTestId('btn-signout').click();
await register(sender, 'Partha Nath');
await pool.query(
  `UPDATE wallets SET balance_paisa = 250000 WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
  [sender]
);
await page.reload();
await page.getByTestId('balance').waitFor();

// Some history so the wallet screen is not empty
for (const amt of ['120.50', '45.00']) {
  await page.getByTestId('tab-send').click();
  await page.getByTestId('input-to').fill(friend);
  await page.getByTestId('input-amount').fill(amt);
  await page.getByTestId('btn-review').click();
  await page.getByTestId('btn-confirm').click();
  await page.getByTestId('notice').waitFor();
}

// 2 — wallet with balance and activity
await page.getByTestId('tab-wallet').click();
await page.screenshot({ path: `${OUT}/2-wallet.png` });

// 3 — the confirm step
await page.getByTestId('tab-send').click();
await page.getByTestId('input-to').fill(friend);
await page.getByTestId('input-amount').fill('300.00');
await page.getByTestId('btn-review').click();
await page.screenshot({ path: `${OUT}/3-send-confirm.png` });

// 4 — history
await page.getByTestId('tab-history').click();
await page.screenshot({ path: `${OUT}/4-history.png` });

await browser.close();
await pool.end();
console.log('screenshots written to docs/screenshots/');
