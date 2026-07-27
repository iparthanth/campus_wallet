import { api, resetDb, closeDb } from './helpers.js';

/**
 * Serving the browser app and the API from ONE origin.
 *
 * Every check here exists because its absence let a bug reach production and render the
 * deployed site completely blank:
 *
 *   1. The CSP was `default-src 'none'` — correct for a JSON-only API, fatal once the same
 *      origin serves HTML. The browser downloaded the bundle (HTTP 200) and refused to
 *      EXECUTE it. Nothing appeared in the server log, and curl showed 200 throughout,
 *      because curl does not enforce CSP. Only a real browser console named it.
 *
 *   2. `app.use(['/', '/api'], router)` never routed /api at all. Express tries the array
 *      in order and '/' is a prefix of everything, so /api/mode matched '/', stripped
 *      nothing, and reached a router that only knows '/mode'. It happened to work for
 *      '/auth' — because '/auth' does not match '/api/auth' — and that single passing case
 *      was the one I checked by hand.
 *
 * The lesson both share: a header or a mount path is behaviour, and untested behaviour
 * fails in the place you cannot see it.
 */

beforeEach(resetDb);
afterAll(closeDb);

describe('the /api prefix reaches the same routes as the bare path', () => {
  /*
   * The browser calls /api/... so one origin can serve both. If this regresses, every
   * screen in the app fails at once while the server looks perfectly healthy.
   */
  test('an unauthenticated API route answers identically on both paths', async () => {
    const bare = await api().get('/mode');
    const prefixed = await api().get('/api/mode');

    expect(bare.status).toBe(200);
    expect(prefixed.status).toBe(200);
    expect(prefixed.body).toEqual(bare.body);
    expect(prefixed.body.wallet_mode).toBe('zero_float');
  });

  test('routers mounted at root are reachable under /api', async () => {
    // The exact class of route the bug broke: mounted at '/', shadowed by '/'.
    for (const path of ['/merchants', '/topup/available']) {
      const res = await api().get(`/api${path}`);
      expect([200, 401]).toContain(res.status);  // reached the route, not the 404 handler
      expect(res.body?.error?.code).not.toBe('NOT_FOUND');
    }
  });

  test('routers mounted at a sub-path are reachable under /api', async () => {
    // This one always worked, which is precisely why the bug survived. Keep it honest.
    const res = await api().post('/api/auth/login').send({ email: 'nobody@puc.ac.bd', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).not.toBe('NOT_FOUND');
  });

  test('an unknown path under /api is still a JSON 404, not an HTML page', async () => {
    const res = await api().get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('Content-Security-Policy', () => {
  /*
   * The header that blanked the site. `default-src 'none'` on an HTML response forbids the
   * page from loading its own script and stylesheet.
   */
  test('API responses keep the deny-everything policy', async () => {
    const res = await api().get('/api/mode');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  test('operational endpoints are treated as API', async () => {
    for (const path of ['/health', '/ready']) {
      const res = await api().get(path);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    }
  });

  test('app responses permit the page to load its own script and stylesheet', async () => {
    const res = await api().get('/');
    const csp = res.headers['content-security-policy'];

    expect(csp).not.toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
  });

  test('QR codes render to data: URIs, so img-src must allow them', async () => {
    const csp = (await api().get('/')).headers['content-security-policy'];
    expect(csp).toMatch(/img-src[^;]*data:/);
  });

  test('the payment gateway is an allowed form target', async () => {
    // The student is handed to SSLCommerz by full-page navigation. Omit this and the
    // payment button silently does nothing.
    const csp = (await api().get('/')).headers['content-security-policy'];
    expect(csp).toContain('form-action');
    expect(csp).toContain('sslcommerz.com');
  });

  test('clickjacking and injected <base> stay blocked on both', async () => {
    for (const path of ['/', '/api/mode']) {
      const csp = (await api().get(path)).headers['content-security-policy'];
      expect(csp).toContain("frame-ancestors 'none'");
    }
    const appCsp = (await api().get('/')).headers['content-security-policy'];
    expect(appCsp).toContain("base-uri 'self'");
    expect(appCsp).toContain("object-src 'none'");
  });
});

describe('the other security headers survive on every response', () => {
  test('are present on API and app alike', async () => {
    for (const path of ['/', '/api/mode']) {
      const res = await api().get(path);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['strict-transport-security']).toContain('max-age=');
    }
  });
});
