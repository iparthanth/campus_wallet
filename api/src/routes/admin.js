import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

/** Flagged transactions with the rule that tripped and both parties. */
adminRouter.get('/flags', async (_req, res, next) => {
  try {
    const rows = (await query(
      `SELECT f.id, f.rule_name, f.detail, f.created_at,
              t.id AS transaction_id, t.amount_paisa, t.status,
              su.email AS sender_email, ru.email AS recipient_email
         FROM fraud_flags f
         JOIN transactions t ON t.id = f.transaction_id
         JOIN wallets sw ON sw.id = t.from_wallet
         JOIN users   su ON su.id = sw.user_id
         JOIN wallets rw ON rw.id = t.to_wallet
         JOIN users   ru ON ru.id = rw.user_id
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT 200`
    )).rows;
    return res.json({ flags: rows });
  } catch (err) { return next(err); }
});

/**
 * The analytical-SQL showcase. Three window-function queries an interviewer can read.
 */
adminRouter.get('/analytics', async (_req, res, next) => {
  try {
    // 1. Running balance per wallet over time (SUM OVER with a frame).
    const runningBalance = (await query(
      `SELECT wallet_id, created_at, delta_paisa,
              SUM(delta_paisa) OVER (PARTITION BY wallet_id ORDER BY created_at, id
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_paisa
         FROM (
           SELECT from_wallet AS wallet_id, id, created_at, -amount_paisa AS delta_paisa FROM transactions
           UNION ALL
           SELECT to_wallet   AS wallet_id, id, created_at,  amount_paisa AS delta_paisa FROM transactions
         ) movements
        ORDER BY wallet_id, created_at
        LIMIT 500`
    )).rows;

    // 2. Daily volume with a 7-day moving average.
    const dailyVolume = (await query(
      `SELECT day, total_paisa,
              ROUND(AVG(total_paisa) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)) AS moving_avg_7d
         FROM (
           SELECT date_trunc('day', created_at) AS day, SUM(amount_paisa) AS total_paisa
             FROM transactions GROUP BY 1
         ) d
        ORDER BY day DESC
        LIMIT 30`
    )).rows;

    // 3. Top 5 senders per ISO week (RANK, then filter).
    const topSenders = (await query(
      `SELECT week, email, sent_paisa, rnk FROM (
         SELECT date_trunc('week', t.created_at) AS week, u.email, SUM(t.amount_paisa) AS sent_paisa,
                RANK() OVER (PARTITION BY date_trunc('week', t.created_at) ORDER BY SUM(t.amount_paisa) DESC) AS rnk
           FROM transactions t
           JOIN wallets w ON w.id = t.from_wallet
           JOIN users   u ON u.id = w.user_id
          GROUP BY 1, 2
       ) ranked
       WHERE rnk <= 5
       ORDER BY week DESC, rnk`
    )).rows;

    return res.json({ running_balance: runningBalance, daily_volume: dailyVolume, top_senders: topSenders });
  } catch (err) { return next(err); }
});
