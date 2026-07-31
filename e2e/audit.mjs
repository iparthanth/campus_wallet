import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Walk every page as every role, on desktop and phone, and report what is wrong.
 *
 * Not a test — tests assert what we already thought to check. This looks for the things
 * nobody wrote an assertion for: console errors, failed requests, horizontal overflow,
 * touch targets too small for a thumb, contrast below the WCAG floor, and text that
 * promises a feature the deployment does not have.
 */
const BASE = process.env.AUDIT_BASE ?? 'https://campus-wallet-prh5.onrender.com';
const OUT = 'D:/Claude_Sandbox/.work/scratch/audit';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const findings = [];
const note = (where, severity, what) => findings.push({ where, severity, what });

async function checkPage(page, where) {
  // 1. Layout that breaks on a phone.
  if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) {
    note(where, 'HIGH', 'page scrolls horizontally');
  }

  // 2. Targets too small to hit reliably one-handed.
  const small = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button, a[href], input, select')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < 32) {
        bad.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} ${Math.round(r.height)}px`);
      }
    }
    return [...new Set(bad)].slice(0, 5);
  });
  small.forEach((s) => note(where, 'MED', `touch target under 32px: ${s}`));

  // 3. Text contrast below the WCAG AA floor for body text.
  const faint = await page.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
        const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bg = getComputedStyle(document.body).backgroundColor;
    const out = [];
    for (const el of document.querySelectorAll('p, span, div, td, label, .row-meta, .card-note, .field-hint')) {
      if (!el.textContent.trim() || el.children.length) continue;
      const st = getComputedStyle(el);
      if (parseFloat(st.fontSize) > 18) continue;
      try {
        const a = lum(st.color), b = lum(st.backgroundColor === 'rgba(0, 0, 0, 0)' ? bg : st.backgroundColor);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (ratio < 4.5) out.push(`"${el.textContent.trim().slice(0, 32)}" ${ratio.toFixed(2)}:1`);
      } catch { /* unparseable colour */ }
    }
    return [...new Set(out)].slice(0, 5);
  });
  faint.forEach((f) => note(where, 'MED', `contrast below 4.5:1 — ${f}`));

  // 4. Copy that promises something this deployment cannot do.
  const text = await page.locator('body').innerText();
  for (const [re, msg] of [
    [/top ?up|add balance/i, 'mentions topping up a balance, which zero-float does not have'],
    [/available balance/i, 'shows an "available balance" the university must not hold'],
    [/send money/i, 'offers sending money between students'],
  ]) {
    if (re.test(text)) note(where, 'HIGH', msg);
  }
}

async function tour(role, email, tabs, viewport, label) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => note(`${label}`, 'HIGH', `JS error: ${e.message.slice(0, 90)}`));
  page.on('response', (r) => {
    // 403 on /outlet/summary is expected: App probes it to decide if you run a counter.
    if (r.status() >= 400 && !r.url().includes('/outlet/summary')) {
      note(`${label}`, 'HIGH', `${r.status()} ${r.url().replace(BASE, '')}`);
    }
  });

  // The free instance sleeps after ~15 minutes and drops the first connection while it
  // wakes. Retry rather than reporting a hosting nap as a product defect.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(BASE, { waitUntil: 'networkidle', timeout: 180_000 });
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await page.waitForTimeout(15_000);
    }
  }
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill('password123');
  await page.getByTestId('btn-submit').click();
  await page.waitForTimeout(4000);

  if (!(await page.locator('nav button').count())) {
    note(label, 'HIGH', 'could not sign in');
    await page.close();
    return;
  }

  for (const t of tabs) {
    const btn = page.getByTestId(`tab-${t}`);
    if (!(await btn.count())) { note(label, 'INFO', `no tab: ${t}`); continue; }
    await btn.click();
    await page.waitForTimeout(2200);
    await page.screenshot({ path: `${OUT}/${label}-${t}.png`, fullPage: true });
    await checkPage(page, `${label}/${t}`);
  }
  await page.close();
}

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

await tour('student', 'partha@puc.ac.bd', ['wallet', 'pay', 'account'], DESKTOP, 'student');
await tour('operator', 'canteen@puc.ac.bd', ['counter', 'wallet'], DESKTOP, 'operator');
await tour('admin', 'admin@puc.ac.bd', ['recon', 'flags', 'wallet'], DESKTOP, 'admin');
await tour('student', 'partha@puc.ac.bd', ['wallet', 'pay', 'account'], PHONE, 'phone');
await tour('operator', 'canteen@puc.ac.bd', ['counter'], PHONE, 'phone-counter');

const order = { HIGH: 0, MED: 1, INFO: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
const seen = new Set();
console.log(findings.length ? 'FINDINGS' : 'No findings.');
for (const f of findings) {
  const k = `${f.severity}${f.where}${f.what}`;
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(`  [${f.severity}] ${f.where}: ${f.what}`);
}
console.log(`\nscreenshots: ${OUT}`);
await browser.close();
