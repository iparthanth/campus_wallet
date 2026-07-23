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

  // Fraud thresholds live in config, not scattered in code, so they are tunable per environment.
  fraud: {
    velocityWindowSeconds: Number(process.env.FRAUD_VELOCITY_WINDOW_SEC ?? 60),
    velocityMaxTransfers: Number(process.env.FRAUD_VELOCITY_MAX ?? 3),
    thresholdMinPaisa: Number(process.env.FRAUD_THRESHOLD_MIN_PAISA ?? 50_000),
    thresholdAvgMultiplier: Number(process.env.FRAUD_THRESHOLD_MULT ?? 5),
  },
};
