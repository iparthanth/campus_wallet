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

  // Fraud thresholds live in config, not scattered in code, so they are tunable per environment.
  fraud: {
    velocityWindowSeconds: Number(process.env.FRAUD_VELOCITY_WINDOW_SEC ?? 60),
    velocityMaxTransfers: Number(process.env.FRAUD_VELOCITY_MAX ?? 3),
    thresholdMinPaisa: Number(process.env.FRAUD_THRESHOLD_MIN_PAISA ?? 50_000),
    thresholdAvgMultiplier: Number(process.env.FRAUD_THRESHOLD_MULT ?? 5),
  },
};
