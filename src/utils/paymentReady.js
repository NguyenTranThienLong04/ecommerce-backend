const mongoose = require("mongoose");
const PaymentAttempt = require("../models/PaymentAttempt");
const ensureCheckoutReady = require("./checkoutReady");
const { orderError } = require("./orderState");
const { createDiagnostic } = require("./startupDiagnostic");
const ready = new WeakMap();

async function ensurePaymentReady(diagnostic = createDiagnostic(process.env.MONGO_URI)) {
  try {
    await ensureCheckoutReady(diagnostic);
    const client = mongoose.connection.getClient();
    if (!ready.has(client)) {
      const check = diagnostic.run("payment createIndexes:PaymentAttempt/paymentattempts", () => PaymentAttempt.createIndexes());
      ready.set(client, check);
      check.catch(() => ready.delete(client));
    }
    await ready.get(client);
  } catch (error) {
    throw diagnostic.withCause(orderError(503, "PAYMENT_UNAVAILABLE",
      "Thanh toán cần replica set và index payment sẵn sàng"), error);
  }
}
module.exports = ensurePaymentReady;
