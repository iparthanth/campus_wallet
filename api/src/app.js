import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter } from './routes/auth.js';
import { walletRouter } from './routes/wallet.js';
import { adminRouter } from './routes/admin.js';
import { topupRouter } from './routes/topup.js';
import { campusRouter } from './routes/campus.js';
import { ordersRouter } from './routes/orders.js';
import { config } from './config.js';
import { query } from './db/pool.js';
import { rateLimit, authKey } from './middleware/rateLimit.js';

export function createApp() {
  const app = express();

  // Behind Render/Vercel/nginx the client IP arrives in X-Forwarded-For. Without this,
  // every request looks like it came from the proxy and rate limiting buckets everyone
  // into one counter — locking out the whole campus after five bad logins.
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '64kb' }));
  app.disable('x-powered-by');

  // Security headers, hand-rolled to avoid a dependency for six lines. This is a JSON
  // API — it renders no HTML — so the CSP just forbids everything; nothing legitimate
  // loads resources from an API response, and a strict one neutralises any reflected
  // content. HSTS only bites once served over HTTPS, so it is harmless in local http.
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.set('Cross-Origin-Resource-Policy', 'same-site');
    next();
  });

  // The browser app is served from a different origin in production.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.corsOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  /**
   * Liveness — the process is up.
   * Deliberately does NOT touch the database: a load balancer uses this to decide
   * whether to restart the process, and restarting the API will not fix a broken
   * database.
   */
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'campus-wallet-api' }));

  /**
   * Readiness — the process can actually serve traffic.
   *
   * The earlier single /health returned "ok" while PostgreSQL was down, which is the
   * worst kind of health check: it reports green during an outage. This one runs a
   * real query and fails honestly.
   */
  app.get('/ready', async (_req, res) => {
    const started = Date.now();
    try {
      await query('SELECT 1');
      res.json({ status: 'ready', database: 'up', latency_ms: Date.now() - started });
    } catch (err) {
      res.status(503).json({
        status: 'not_ready',
        database: 'down',
        error: { code: 'DB_UNAVAILABLE', message: err.message.slice(0, 120) },
      });
    }
  });

  /*
   * Every router answers on BOTH the bare path and under /api.
   *
   * The browser calls /api/... so that one origin can serve the app and the API together
   * (see the static-file block below for why that matters). Tests and curl call the bare
   * paths. Mounting both costs nothing and means the frontend needs no build-time base URL
   * — one less thing to configure and get wrong.
   */
  const both = (p) => (p === '/' ? ['/', '/api'] : [p, `/api${p}`]);

  // Credential endpoints are the brute-force surface, so they get the tight bucket.
  app.use(both('/auth'), rateLimit({ windowMs: 60_000, max: 10, key: 'auth', keyFn: authKey }), authRouter);
  app.use(both('/'), rateLimit({ windowMs: 60_000, max: 120, key: 'api' }), walletRouter);
  app.use(both('/'), topupRouter);
  app.use(both('/'), campusRouter);
  // Zero-float orders, reconciliation and audit. Mounted at '/' because it owns both
  // student-facing paths (/orders) and admin ones (/admin/reconciliation/...), and
  // splitting them across two mounts would put the same router in two places.
  app.use(both('/'), ordersRouter);
  app.use(both('/admin'), adminRouter);

  /*
   * Serve the built React app from this same process.
   *
   * Why one service instead of two: the frontend needs the API's URL and the API needs the
   * frontend's origin for CORS. As two Render services wired with `fromService`, that is a
   * CIRCULAR dependency — neither can be provisioned first, and Render rejects the
   * blueprint outright. Two services + cross-origin + zero manual configuration is not
   * achievable; you can have any two of the three.
   *
   * Serving both from one origin removes the requirement rather than working around it:
   * no CORS preflight, no cross-service wiring, no hostname to get wrong, and one free
   * instance to wake instead of two.
   *
   * Only in production. Development keeps Vite's dev server for hot reload, and the tests
   * never build the frontend — so a missing dist must not break either.
   */
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (config.env === 'production' && existsSync(distDir)) {
    // Hashed asset filenames are content-addressed, so they can be cached hard. index.html
    // must NOT be, or a returning student keeps loading a stale bundle after every deploy.
    app.use(express.static(distDir, {
      maxAge: '1y',
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }));

    /*
     * SPA fallback: any GET that is not an API route and not a real file serves index.html,
     * so a deep link like /reconcile works on a hard refresh.
     *
     * Placed AFTER every API router, so it can only ever catch what they did not. An
     * unmatched API path still needs to answer JSON 404 rather than HTML — a client that
     * asked for JSON and got a page cannot report the error usefully.
     */
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      if (req.accepts('html')) return res.sendFile(join(distDir, 'index.html'));
      return next();
    });
  }

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error(JSON.stringify({
      level: 'error', msg: err.message, path: req.path, method: req.method,
      stack: config.env === 'production' ? undefined : err.stack,
    }));
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  return app;
}
