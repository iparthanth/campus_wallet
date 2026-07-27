import express from 'express';

/**
 * A stand-in for the SSLCommerz gateway.
 *
 * Same reasoning as fake-bkash: the real sandbox is network-dependent and cannot be
 * told to return a mismatched amount or a FAILED validation on command. This mirrors the
 * two documented endpoints — session create and server-to-server validation — closely
 * enough that the real client code (services/sslcommerz.js) runs unchanged against it.
 */
export function startFakeSsl() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  const state = {
    sessions: new Map(),   // tranId -> { amountTaka }
    // Test knobs:
    failValidation: false, // next validate returns FAILED
    amountOverrideTaka: null, // next validate reports this amount instead of the real one
    validatedOnce: new Set(), // tranIds already validated once (to simulate VALIDATED replay)
    // What the gateway will actually pay out. Real SSLCommerz returns store_amount =
    // amount - its commission, and the difference is the only way to learn the fee.
    // Null means "no fee", which keeps the existing top-up tests unchanged.
    storeAmountTaka: null,
  };

  // POST session create — returns the gateway URL the student would be sent to.
  app.post('/gwprocess/v4/api.php', (req, res) => {
    const { store_id, store_passwd, tran_id, total_amount } = req.body ?? {};
    if (store_id !== 'testbox' || store_passwd !== 'qwerty') {
      return res.json({ status: 'FAILED', failedreason: 'Invalid store credentials' });
    }
    state.sessions.set(tran_id, { amountTaka: Number(total_amount) });
    res.json({
      status: 'SUCCESS',
      sessionkey: `SESS-${tran_id}`,
      GatewayPageURL: `http://127.0.0.1:0/checkout/${tran_id}`,
      // val_id the caller will present back for validation.
      desc: [{ name: 'bKash' }, { name: 'Nagad' }, { name: 'VISA' }],
    });
  });

  // GET server-to-server validation — the only thing that authorises a credit.
  app.get('/validator/api/validationserverAPI.php', (req, res) => {
    const { val_id, store_id, store_passwd } = req.query;
    if (store_id !== 'testbox' || store_passwd !== 'qwerty') {
      return res.json({ status: 'INVALID_TRANSACTION' });
    }
    // Our fake val_id is "VAL-<tranId>", so validation can find the session.
    const tranId = String(val_id).replace(/^VAL-/, '');
    const session = state.sessions.get(tranId);
    if (!session) return res.json({ status: 'INVALID_TRANSACTION' });

    if (state.failValidation) {
      state.failValidation = false;
      return res.json({ status: 'FAILED', tran_id: tranId });
    }

    const replay = state.validatedOnce.has(tranId);
    state.validatedOnce.add(tranId);
    const amount = state.amountOverrideTaka ?? session.amountTaka;
    state.amountOverrideTaka = null;
    const storeAmount = state.storeAmountTaka ?? amount;
    state.storeAmountTaka = null;

    res.json({
      status: replay ? 'VALIDATED' : 'VALID',
      tran_id: tranId,
      amount: amount.toFixed(2),
      store_amount: storeAmount.toFixed(2),
      currency: 'BDT',
      card_type: 'bKash-bKash',
      bank_tran_id: `BNK-${tranId}`,
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        /** The val_id SSLCommerz would hand back for a given session. */
        valIdFor: (tranId) => `VAL-${tranId}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
