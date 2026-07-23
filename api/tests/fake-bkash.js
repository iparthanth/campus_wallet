import express from 'express';

/**
 * A stand-in for bKash Tokenized Checkout.
 *
 * Tests run against this rather than the real sandbox on purpose: a third-party sandbox
 * makes the suite network-dependent, slow, and flaky, and it cannot be told to simulate
 * a dropped callback or a duplicate execute on demand. Contract fidelity is maintained by
 * matching the documented request/response shapes.
 */
export function startFakeBkash() {
  const app = express();
  app.use(express.json());

  const state = {
    payments: new Map(),   // paymentID -> { amount, status, trxID, executeCount }
    tokenGrants: 0,
    nextId: 1,
    failNextExecute: false,
  };

  app.post('/tokenized/checkout/token/grant', (req, res) => {
    const { app_key, app_secret } = req.body ?? {};
    if (!app_key || !app_secret) return res.status(401).json({ statusCode: '9999', statusMessage: 'bad credentials' });
    state.tokenGrants += 1;
    res.json({ id_token: `fake-token-${state.tokenGrants}`, expires_in: 3600, token_type: 'Bearer' });
  });

  app.post('/tokenized/checkout/create', (req, res) => {
    if (!req.get('authorization')) return res.status(401).json({ statusCode: '2001' });
    const paymentID = `TR00${state.nextId++}`;
    state.payments.set(paymentID, {
      amount: req.body.amount, status: 'Initiated', trxID: null, executeCount: 0,
    });
    res.json({ paymentID, bkashURL: `https://fake.bka.sh/checkout/${paymentID}`, statusCode: '0000' });
  });

  app.post('/tokenized/checkout/execute', (req, res) => {
    const p = state.payments.get(req.body.paymentID);
    if (!p) return res.status(404).json({ statusCode: '2062', statusMessage: 'Invalid payment ID' });

    p.executeCount += 1;
    if (state.failNextExecute) {
      state.failNextExecute = false;
      return res.json({ statusCode: '2062', statusMessage: 'Insufficient Balance', transactionStatus: 'Failed' });
    }
    p.status = 'Completed';
    p.trxID = p.trxID ?? `TRX${req.body.paymentID}`;
    res.json({ paymentID: req.body.paymentID, trxID: p.trxID, transactionStatus: 'Completed', statusCode: '0000', amount: p.amount });
  });

  app.post('/tokenized/checkout/payment/status', (req, res) => {
    const p = state.payments.get(req.body.paymentID);
    if (!p) return res.status(404).json({ statusCode: '2062' });
    res.json({ paymentID: req.body.paymentID, transactionStatus: p.status, trxID: p.trxID, amount: p.amount });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        /** Simulate the user paying without the callback ever reaching us. */
        markPaidSilently: (paymentID) => {
          const p = state.payments.get(paymentID);
          p.status = 'Completed';
          p.trxID = `TRX${paymentID}`;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
