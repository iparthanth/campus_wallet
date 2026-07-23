import express from 'express';
import { authRouter } from './routes/auth.js';
import { walletRouter } from './routes/wallet.js';
import { adminRouter } from './routes/admin.js';
import { topupRouter } from './routes/topup.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '64kb' })); // a wallet request is tiny; cap it
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'campus-wallet-api' }));

  app.use('/auth', authRouter);
  app.use('/', walletRouter);
  app.use('/', topupRouter);
  app.use('/admin', adminRouter);

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  // Central error handler: clients get a code, the server keeps the stack trace.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  return app;
}
