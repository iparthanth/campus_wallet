import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { api, makeUser, resetDb, closeDb } from './helpers.js';
import { config } from '../src/config.js';

jest.setTimeout(30_000);

beforeEach(resetDb);
afterAll(closeDb);

describe('registration', () => {
  test('creates a user, a wallet, and returns a token', async () => {
    const res = await api().post('/auth/register')
      .send({ name: 'Rima Das', email: 'rima@puc.ac.bd', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('rima@puc.ac.bd');
    expect(res.body.user.password_hash).toBeUndefined(); // never leak the hash
    expect(typeof res.body.token).toBe('string');

    const wallet = await api().get('/wallet').set('Authorization', `Bearer ${res.body.token}`);
    expect(wallet.status).toBe(200);
    expect(wallet.body.balance_paisa).toBe(0);
  });

  test('duplicate email returns 409, not 500', async () => {
    const payload = { name: 'A', email: 'dup@puc.ac.bd', password: 'password123' };
    await api().post('/auth/register').send(payload);
    const res = await api().post('/auth/register').send(payload);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test.each([
    ['short password', { name: 'A', email: 'a@puc.ac.bd', password: 'short' }],
    ['invalid email',  { name: 'A', email: 'not-an-email', password: 'password123' }],
    ['empty name',     { name: '  ', email: 'b@puc.ac.bd', password: 'password123' }],
  ])('rejects %s with 400', async (_l, body) => {
    const res = await api().post('/auth/register').send(body);
    expect(res.status).toBe(400);
  });
});

describe('login', () => {
  test('valid credentials return a token', async () => {
    await api().post('/auth/register').send({ name: 'A', email: 'login@puc.ac.bd', password: 'password123' });
    const res = await api().post('/auth/login').send({ email: 'login@puc.ac.bd', password: 'password123' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  test('wrong password and unknown email give the SAME response (no user enumeration)', async () => {
    await api().post('/auth/register').send({ name: 'A', email: 'real@puc.ac.bd', password: 'password123' });

    const wrongPass = await api().post('/auth/login').send({ email: 'real@puc.ac.bd', password: 'wrongpassword' });
    const noUser    = await api().post('/auth/login').send({ email: 'ghost@puc.ac.bd', password: 'wrongpassword' });

    expect(wrongPass.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPass.body).toEqual(noUser.body);
  });
});

describe('token handling', () => {
  test('expired token is rejected with TOKEN_EXPIRED', async () => {
    const user = await makeUser();
    const expired = jwt.sign({ sub: String(user.id), role: 'user' }, config.jwtSecret, { expiresIn: '-1m' });
    const res = await api().get('/wallet').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  test('token signed with the wrong secret is rejected', async () => {
    const user = await makeUser();
    const forged = jwt.sign({ sub: String(user.id), role: 'admin' }, 'attacker-secret');
    const res = await api().get('/wallet').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  test('missing header and malformed scheme are rejected', async () => {
    expect((await api().get('/wallet')).status).toBe(401);
    expect((await api().get('/wallet').set('Authorization', 'Basic abc')).status).toBe(401);
  });

  test('a normal user cannot reach admin routes', async () => {
    const user = await makeUser();
    const res = await api().get('/admin/flags').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403);
  });

  test('an admin can reach admin routes', async () => {
    const admin = await makeUser({ role: 'admin' });
    const res = await api().get('/admin/flags').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
  });
});
