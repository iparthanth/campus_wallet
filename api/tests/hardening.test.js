import { api, makeUser, resetDb, closeDb } from './helpers.js';
import { __resetRateLimits } from '../src/middleware/rateLimit.js';

beforeEach(async () => {
  await resetDb();
  __resetRateLimits();
});
afterAll(closeDb);

describe('health vs readiness', () => {
  test('/health reports liveness without touching the database', async () => {
    const res = await api().get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('/ready actually queries the database and reports latency', async () => {
    const res = await api().get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', database: 'up' });
    expect(typeof res.body.latency_ms).toBe('number');
  });
});

describe('rate limiting', () => {
  test('brute-forcing login is cut off with 429 and a Retry-After', async () => {
    const attempts = [];
    for (let i = 0; i < 14; i++) {
      attempts.push(await api().post('/auth/login').send({ email: 'nobody@puc.ac.bd', password: 'wrong-password' }));
    }

    const limited = attempts.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0].headers['retry-after']).toBeDefined();
    expect(limited[0].body.error.code).toBe('RATE_LIMITED');
  });

  test('every response advertises the remaining budget', async () => {
    const res = await api().post('/auth/login').send({ email: 'a@puc.ac.bd', password: 'whatever1' });
    expect(res.headers['ratelimit-limit']).toBe('10');
    expect(Number(res.headers['ratelimit-remaining'])).toBeLessThan(10);
  });

  test('normal wallet use is nowhere near the limit', async () => {
    const user = await makeUser({ balancePaisa: 100_00 });
    for (let i = 0; i < 12; i++) {
      const res = await api().get('/wallet').set('Authorization', `Bearer ${user.token}`);
      expect(res.status).toBe(200);
    }
  });
});

describe('CORS', () => {
  test('an unlisted origin gets no allow-origin header', async () => {
    const res = await api().get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('preflight is answered without reaching a route', async () => {
    const res = await api().options('/wallet').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(204);
  });
});
