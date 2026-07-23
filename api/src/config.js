import 'dotenv/config';

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
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
