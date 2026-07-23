import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { transfer, TransferError } from '../domain/transfer.js';
import { formatPaisa } from '../domain/money.js';

export const walletRouter = Router();

// Auth is applied PER ROUTE, not router-wide. This router is mounted at '/', so a
// router-level `use(requireAuth)` would run on every request that reaches it — turning
// an unknown path into 401 instead of 404, and double-running auth for /admin routes.
walletRouter.get('/wallet', requireAuth, async (req, res, next) => {
  try {
    const result = await query('SELECT balance_paisa FROM wallets WHERE user_id = $1', [req.user.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: { code: 'NO_WALLET', message: 'Wallet not found' } });
    }
    const balance_paisa = result.rows[0].balance_paisa;
    return res.json({ balance_paisa, display: formatPaisa(balance_paisa) });
  } catch (err) { return next(err); }
});

const transferSchema = z.object({
  to_email: z.string().trim().toLowerCase().email(),
  // Money arrives as integer paisa. A float here is a client bug and we reject it loudly.
  amount_paisa: z.number().int().positive(),
  idempotency_key: z.string().min(8).max(200).optional(),
});

walletRouter.post('/transfers', requireAuth, async (req, res, next) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: { code: 'VALIDATION', message: 'Invalid transfer', issues: parsed.error.issues } });
  }
  const { to_email, amount_paisa, idempotency_key } = parsed.data;

  try {
    const { transaction, flags, replayed } = await transfer({
      fromUserId: req.user.id,
      toEmail: to_email,
      amountPaisa: amount_paisa,
      idempotencyKey: idempotency_key,
    });
    return res.status(replayed ? 200 : 201).json({ transaction, flags, replayed });
  } catch (err) {
    if (err instanceof TransferError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    return next(err);
  }
});

/**
 * Keyset pagination on (created_at, id) DESC — stable while new rows arrive,
 * and O(log n) via the index instead of OFFSET's linear scan.
 */
walletRouter.get('/transactions', requireAuth, async (req, res, next) => {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const cursor = req.query.cursor; // "<iso8601>|<id>"

  try {
    const walletRes = await query('SELECT id FROM wallets WHERE user_id = $1', [req.user.id]);
    if (walletRes.rowCount === 0) {
      return res.status(404).json({ error: { code: 'NO_WALLET', message: 'Wallet not found' } });
    }
    const walletId = walletRes.rows[0].id;

    const params = [walletId, limit];
    let keyset = '';
    if (typeof cursor === 'string' && cursor.includes('|')) {
      const [ts, id] = cursor.split('|');
      params.push(ts, Number(id));
      keyset = `AND (t.created_at, t.id) < ($3::timestamptz, $4::bigint)`;
    }

    const rows = (await query(
      `SELECT t.id, t.amount_paisa, t.status, t.created_at,
              CASE WHEN t.from_wallet = $1 THEN 'debit' ELSE 'credit' END AS direction,
              cu.email AS counterparty_email
         FROM transactions t
         JOIN wallets  cw ON cw.id = CASE WHEN t.from_wallet = $1 THEN t.to_wallet ELSE t.from_wallet END
         JOIN users    cu ON cu.id = cw.user_id
        WHERE (t.from_wallet = $1 OR t.to_wallet = $1) ${keyset}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $2`,
      params
    )).rows;

    const last = rows[rows.length - 1];
    return res.json({
      transactions: rows,
      next_cursor: rows.length === limit && last ? `${last.created_at.toISOString()}|${last.id}` : null,
    });
  } catch (err) { return next(err); }
});
