import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { api, makeUser, resetDb, closeDb } from './helpers.js';
import { config } from '../src/config.js';

beforeEach(resetDb);
afterAll(closeDb);

describe('JWT hardening', () => {
  test('an unsigned "alg:none" token is rejected', async () => {
    const user = await makeUser();
    // A token with alg:none and no signature. Without algorithm pinning, some verifiers
    // accept this and trust its claims outright.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: String(user.id), role: 'admin' })).toString('base64url');
    const forged = `${header}.${body}.`;

    const res = await api().get('/wallet').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  test('a token signed with a different algorithm/secret is rejected', async () => {
    const user = await makeUser();
    const forged = jwt.sign({ sub: String(user.id), role: 'admin' }, 'attacker-secret', { algorithm: 'HS256' });
    const res = await api().get('/wallet').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  test('a genuine HS256 token still works', async () => {
    const user = await makeUser();
    const res = await api().get('/wallet').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
  });

  test('a user cannot escalate to admin by editing the role claim', async () => {
    const user = await makeUser();
    // They can only forge with a secret they do not have; signing with the real secret
    // is not something an attacker can do, but prove role is enforced server-side too.
    const res = await api().get('/admin/flags').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403); // authenticated, but role=user
  });
});

describe('password policy', () => {
  test('a password over bcrypt\'s 72-byte limit is rejected, not silently truncated', async () => {
    const res = await api().post('/auth/register').send({
      name: 'Long', email: 'long@puc.ac.bd', password: 'a'.repeat(80),
    });
    expect(res.status).toBe(400); // rejected by validation, so two 80-char passwords can't collide
  });

  test('a password under 8 characters is rejected', async () => {
    const res = await api().post('/auth/register').send({
      name: 'Short', email: 'short@puc.ac.bd', password: 'abc123',
    });
    expect(res.status).toBe(400);
  });

  test('registration cannot self-assign a role', async () => {
    // Mass-assignment attempt: send role=admin. zod strips it; the DB default is 'user'.
    const res = await api().post('/auth/register').send({
      name: 'Sneaky', email: 'sneaky@puc.ac.bd', password: 'password123', role: 'admin',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('user');
  });
});

describe('security headers', () => {
  test('responses carry the hardening headers', async () => {
    const res = await api().get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined(); // framework fingerprint removed
  });
});

describe('config refuses to boot insecurely', () => {
  test('a JWT secret shorter than 32 chars is refused at startup', async () => {
    // The check lives in config.js; exercise it directly with a throwaway env.
    const prev = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'too-short';
    await jest.isolateModulesAsync(async () => {
      await expect(import('../src/config.js')).rejects.toThrow(/at least 32 characters/);
    });
    process.env.JWT_SECRET = prev;
  });
});
