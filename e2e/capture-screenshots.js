/**
 * Generates the README screenshots from the real running app, so they can never
 * drift from what the product actually renders.
 * Run: node capture-screenshots.js   (API on :3000, web on :5173)
 */
import { chromium } from '@playwright/test';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';

const OUT = '../docs/screenshots';
const pool = new pg.Pool({ connectionString: 'postgres://wallet:wallet@localhost:5433/campus_wallet' });

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });

async function signIn(email) {
  await page.goto('http://localhost:5173/');
  await page.getByTestId('tab-login').click();
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill('password123');
  await page.getByTestId('btn-submit').click();
  await page.getByTestId('balance').waitFor();
}

// 1 — sign in
await page.goto('http://localhost:5173/');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/1-signin.png` });

// 2 — wallet
await signIn('partha@puc.ac.bd');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/2-wallet.png` });

// 3 — confirm send
await page.getByTestId('tab-send').click();
await page.getByTestId('input-to').fill('rima@puc.ac.bd');
await page.getByTestId('input-amount').fill('120.50');
await page.getByTestId('btn-review').click();
await page.getByTestId('confirm-amount').waitFor();
await page.screenshot({ path: `${OUT}/3-send-confirm.png` });

// 4 — admin dashboard with charts
await page.getByTestId('btn-signout').click();
await signIn('admin@puc.ac.bd');
await page.getByTestId('tab-flags').click();
await page.getByTestId('kpi-row').waitFor();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/4-dashboard.png` });

await browser.close();
await pool.end();
console.log('screenshots written to docs/screenshots/');
