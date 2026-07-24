import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Verifies the Bearer token and attaches { id, role } to req.user.
 * Every failure path returns 401 with a machine-readable code — never a stack trace,
 * and never a message that tells an attacker which half was wrong.
 */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'Authorization: Bearer <token> required' } });
  }

  try {
    // Pin the algorithm. Without this, jsonwebtoken accepts ANY algorithm the token
    // claims — including "none" (unsigned) and RS/HS confusion where an attacker signs
    // with the public key as an HMAC secret. We only ever issue HS256, so only accept it.
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.user = { id: Number(payload.sub), role: payload.role };
    return next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    return res.status(401).json({ error: { code, message: 'Invalid or expired token' } });
  }
}

/** Must run after requireAuth. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin role required' } });
  }
  return next();
}
