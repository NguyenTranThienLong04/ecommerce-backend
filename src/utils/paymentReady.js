const mongoose = require("mongoose");
const PaymentAttempt = require("../models/PaymentAttempt");
const ensureCheckoutReady = require("./checkoutReady");
const { orderError } = require("./orderState");
const ready = new WeakMap();

async function ensurePaymentReady() {
  try {
    await ensureCheckoutReady();
    const client = mongoose.connection.getClient();
    if (!ready.has(client)) {
      const check = PaymentAttempt.createIndexes();
      ready.set(client, check);
      check.catch(() => ready.delete(client));
    }
    await ready.get(client);
  } catch {
    throw orderError(503, "PAYMENT_UNAVAILABLE", "Thanh toán cần replica set và index payment sẵn sàng");
  }
}
module.exports = ensurePaymentReady;
