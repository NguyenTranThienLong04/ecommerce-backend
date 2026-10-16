const mongoose = require("mongoose");
const Order = require("../models/Order");
const { checkoutError } = require("./checkoutQuote");
const { createDiagnostic } = require("./startupDiagnostic");
const ready = new WeakMap();

function ensureCheckoutReady(diagnostic = createDiagnostic(process.env.MONGO_URI)) {
  const connection = mongoose.connection;
  const client = connection.getClient();
  if (connection.readyState !== 1 || !client) {
    throw checkoutError(503, "CHECKOUT_UNAVAILABLE", "Checkout tạm thời chưa sẵn sàng");
  }
  if (!ready.has(client)) {
    const check = (async () => {
      try {
        diagnostic.log("hello/topology", "START");
        try {
          const topology = await connection.db.admin().command({ hello: 1 });
          if (!topology.setName && topology.msg !== "isdbgrid") throw new Error("Transactions required");
          diagnostic.log("hello/topology", "PASS");
        } catch (error) {
          diagnostic.log("hello/topology", "FAIL", error);
          throw error;
        }
        // Explicitly await the unique constraint even if autoIndex is disabled.
        await diagnostic.run("checkout createIndexes:Order/orders", () => Order.createIndexes());
      } catch (error) {
        throw diagnostic.withCause(checkoutError(503, "CHECKOUT_UNAVAILABLE",
          "Checkout cần replica set và index idempotency sẵn sàng"), error);
      }
    })();
    ready.set(client, check);
    check.catch(() => ready.delete(client));
  }
  return ready.get(client);
}

module.exports = ensureCheckoutReady;
