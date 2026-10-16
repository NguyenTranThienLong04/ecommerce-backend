const mongoose = require("mongoose");
const Order = require("../models/Order");
const { checkoutError } = require("./checkoutQuote");
const ready = new WeakMap();

function ensureCheckoutReady() {
  const connection = mongoose.connection;
  const client = connection.getClient();
  if (connection.readyState !== 1 || !client) {
    throw checkoutError(503, "CHECKOUT_UNAVAILABLE", "Checkout tạm thời chưa sẵn sàng");
  }
  if (!ready.has(client)) {
    const check = (async () => {
      try {
        const topology = await connection.db.admin().command({ hello: 1 });
        if (!topology.setName && topology.msg !== "isdbgrid") throw new Error("Transactions required");
        // Explicitly await the unique constraint even if autoIndex is disabled.
        await Order.createIndexes();
      } catch {
        throw checkoutError(503, "CHECKOUT_UNAVAILABLE", "Checkout cần replica set và index idempotency sẵn sàng");
      }
    })();
    ready.set(client, check);
    check.catch(() => ready.delete(client));
  }
  return ready.get(client);
}

module.exports = ensureCheckoutReady;
