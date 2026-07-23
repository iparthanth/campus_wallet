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
    const payload = jwt.verify(token, config.jwtSecret);
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
