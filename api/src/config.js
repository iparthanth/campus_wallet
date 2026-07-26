import 'dotenv/config';

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

/**
 * A JWT secret shorter than 32 chars is brute-forceable, so refuse to start with a weak
 * one rather than run insecurely. Failing loud at boot is the safe default — a misconfig
 * that limps along with a guessable secret is the kind that ships to production unnoticed.
 */
function requireStrongSecret(name) {
  const v = required(name);
  if (v.length < 32) {
    throw new Error(`${name} must be at least 32 characters (got ${v.length}). Generate one with: openssl rand -base64 48`);
  }
  return v;
}

/**
 * Resolve WALLET_MODE, refusing the unlawful combination outright.
 *
 * Failing at boot is the point. An unlicensed stored-value wallet running in production
 * is a criminal exposure for the university's officers, and the cost of that mistake is
 * not symmetric with the cost of a failed deploy.
 */
export function readWalletMode(env = process.env) {
  const requested = (env.WALLET_MODE ?? 'zero_float').trim();

  if (requested !== 'zero_float' && requested !== 'closed_loop') {
    throw new Error(
      `WALLET_MODE must be "zero_float" or "closed_loop", got "${requested}". ` +
      'Leave it unset for the lawful default (zero_float).'
    );
  }

  if (requested === 'closed_loop' && (env.NODE_ENV ?? 'development') === 'production') {
    throw new Error(
      'REFUSING TO START: WALLET_MODE=closed_loop with NODE_ENV=production.\n' +
      '\n' +
      'Closed-loop mode holds student balances. Under the Payment and Settlement Systems\n' +
      'Act 2024 s.15(1) that is issuing a prepaid payment instrument, which no institution\n' +
      'may do without Bangladesh Bank approval. The offence is cognizable and non-bailable\n' +
      '(s.39) and liability reaches officers personally (s.38).\n' +
      '\n' +
      'Run the pilot in zero_float mode: unset WALLET_MODE, or set WALLET_MODE=zero_float.\n' +
      'Closed-loop remains available outside production for demonstration only.'
    );
  }

  return requested;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',

  /**
   * How this deployment handles money. DEFAULTS TO zero_float — the only lawful shape.
   *
   * zero_float  — the app never touches money. The student pays the outlet's own Bangla QR
   *               from their own bKash/Nagad/bank app; this system records the order and
   *               reconciles the acquirer's settlement against it.
   *
   * closed_loop — the app holds student balances. A DEMO MODE ONLY.
   *
   * Why closed_loop cannot ship: under the Payment and Settlement Systems Act 2024
   * s.15(1), no "person, institution or company" may issue a prepaid payment instrument
   * without Bangladesh Bank approval. The Bangla term used is প্রতিষ্ঠান (institution),
   * which is deliberately broader than "company" and squarely covers a university. There
   * is NO closed-loop carve-out in the enacted Act — the exemption often cited lives only
   * in a DRAFT E-Money regulation that remains unenacted. The only published approval
   * route (Closed PI Guidelines 2024) requires a Companies Act 1994 company with BDT 20
   * crore paid-up capital and forbids reloadable balances.
   *
   * Penalties under s.37(1) are up to 5 years' imprisonment or BDT 50 lakh, and s.39 makes
   * the offence cognizable and NON-BAILABLE. Under s.38 liability reaches directors and
   * chief executives personally — for a university, the Vice-Chancellor and Registrar.
   *
   * So production refuses to boot in closed_loop. This is a deliberate hard stop: a
   * misconfigured environment variable must not be able to expose PUC's officers to
   * criminal liability, and a warning in a log nobody reads is not a control.
   */
  walletMode: readWalletMode(),
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: requireStrongSecret('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 12),

  // Browser origins allowed to call this API. Empty in development because the Vite
  // dev server proxies /api, so requests are same-origin and never preflight.
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),

  // bKash Tokenized Checkout (sandbox). Credentials are server-side only and are never
  // sent to the browser. Absent config simply disables the top-up feature rather than
  // crashing the app, so the wallet still runs without bKash.
  bkash: {
    enabled: Boolean(process.env.BKASH_APP_KEY && process.env.BKASH_APP_SECRET),
    baseUrl: process.env.BKASH_BASE_URL ?? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta',
    appKey: process.env.BKASH_APP_KEY ?? '',
    appSecret: process.env.BKASH_APP_SECRET ?? '',
    username: process.env.BKASH_USERNAME ?? '',
    password: process.env.BKASH_PASSWORD ?? '',
    callbackUrl: process.env.BKASH_CALLBACK_URL ?? 'http://localhost:5173/topup/callback',
  },

  // SSLCommerz. Defaults to the PUBLIC sandbox store, so the gateway works out of the
  // box with no signup — the same credentials SSLCommerz publishes for testing.
  // Production requires a real store_id and a card, which is a business step.
  ssl: {
    enabled: process.env.SSL_ENABLED !== 'false',
    baseUrl: process.env.SSL_BASE_URL ?? 'https://sandbox.sslcommerz.com',
    storeId: process.env.SSL_STORE_ID ?? 'testbox',
    storePassword: process.env.SSL_STORE_PASSWORD ?? 'qwerty',
    // Where SSLCommerz sends the student back. Must be reachable BY THE GATEWAY,
    // so on a laptop this needs a tunnel; in production it is the API's public URL.
    callbackBase: process.env.PUBLIC_API_URL ?? 'http://localhost:3000',
    appUrl: process.env.PUBLIC_APP_URL ?? 'http://localhost:5173',
  },

  // SMS for phone verification. With no credentials the console provider runs instead,
  // so verification works in development and CI without cost or sending a real message.
  // BD gateways (sms.net.bd, MiMSMS, BulkSMSBD…) all accept this same POST shape.
  sms: {
    enabled: Boolean(process.env.SMS_API_KEY),
    provider: process.env.SMS_PROVIDER ?? 'alpha',   // alpha | bulksmsbd | console
    apiKey: process.env.SMS_API_KEY ?? '',
    // Only set once a branded sender ID is approved (needs a trade licence). Without it
    // a non-masking account still delivers — the sender shows as an operator long code.
    senderId: process.env.SMS_SENDER_ID ?? '',
  },

  // Fraud thresholds live in config, not scattered in code, so they are tunable per environment.
  fraud: {
    velocityWindowSeconds: Number(process.env.FRAUD_VELOCITY_WINDOW_SEC ?? 60),
    velocityMaxTransfers: Number(process.env.FRAUD_VELOCITY_MAX ?? 3),
    thresholdMinPaisa: Number(process.env.FRAUD_THRESHOLD_MIN_PAISA ?? 50_000),
    thresholdAvgMultiplier: Number(process.env.FRAUD_THRESHOLD_MULT ?? 5),
  },
};
