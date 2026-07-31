import { createApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';

/**
 * Say why we died.
 *
 * Node exits on an uncaught exception, and without these handlers it exits SILENTLY — no
 * stack, no message, nothing in the host's log. A deployed instance was dropping every
 * request that ran bcrypt: the connection closed mid-flight, the platform restarted the
 * process, and the next health check passed, so the log showed a healthy service that was
 * in fact crash-looping. Black-box probing could narrow it to "the process is dying" and
 * no further, because the process never got to say anything.
 *
 * For a system that handles money, "it restarted and nobody knows why" is not an
 * acceptable failure mode. Exit is still correct — after an uncaught exception the process
 * state is unknown and continuing risks acting on corrupt state — but it exits LOUDLY.
 */
for (const [event, label] of [['uncaughtException', 'uncaught exception'], ['unhandledRejection', 'unhandled rejection']]) {
  process.on(event, (err) => {
    console.error(JSON.stringify({
      level: 'fatal',
      msg: `${label} — the process is exiting`,
      error: err instanceof Error ? err.message : String(err),
      name: err?.name ?? null,
      stack: err?.stack ?? null,
      // Memory at the moment of death: an OOM on a small instance looks exactly like a
      // mystery crash unless the numbers are recorded.
      memory_mb: Object.fromEntries(
        Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1048576)])
      ),
    }));
    process.exit(1);
  });
}

const server = createApp().listen(config.port, () => {
  console.log(JSON.stringify({
    level: 'info',
    msg: 'campus-wallet-api listening',
    port: config.port,
    env: config.env,
    // The effective configuration, so a misconfigured deployment is visible in the first
    // log line rather than inferred from behaviour hours later. No secrets: lengths only.
    wallet_mode: config.walletMode,
    bcrypt_rounds: config.bcryptRounds,
    jwt_secret_len: config.jwtSecret.length,
    sms: config.sms.enabled ? config.sms.provider : 'console (no key)',
    ssl_store: config.ssl.storeId,
  }));
});

// Graceful shutdown: stop accepting connections, finish in-flight requests, close the pool.
// Without this, a deploy can kill a request mid-transaction.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
