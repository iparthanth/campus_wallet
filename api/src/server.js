import { createApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';

const server = createApp().listen(config.port, () => {
  console.log(`campus-wallet-api listening on :${config.port} (${config.env})`);
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
