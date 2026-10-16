const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server-core");
const checkout = require("../src/services/checkout.service");
const Order = require("../src/models/Order");
const transitionOrder = require("../src/services/orderTransition.service");
const ensurePaymentReady = require("../src/utils/paymentReady");
const PaymentAttempt = require("../src/models/PaymentAttempt");

test("standalone MongoDB rejects checkout and lifecycle transitions before writes", { timeout: 180000 }, async () => {
  let mongo;
  try {
    mongo = await MongoMemoryServer.create({ binary: { version: "7.0.24",
      downloadDir: path.join(__dirname, "../.cache/mongodb") }, instance: { ip: "127.0.0.1" } });
    await mongoose.connect(mongo.getUri(), { dbName: "checkout_standalone_regression" });
    await assert.rejects(checkout(new mongoose.Types.ObjectId(), {}), {
      status: 503, code: "CHECKOUT_UNAVAILABLE"
    });
    assert.equal(await Order.countDocuments(), 0);
    const userId = new mongoose.Types.ObjectId();
    const order = await Order.create({ idUser: userId, shippingMethod: "COD" });
    await assert.rejects(transitionOrder({ orderId: order._id, status: "CANCEL", actor: { type: "USER", id: userId } }), {
      status: 503, code: "ORDER_UNAVAILABLE"
    });
    assert.equal((await Order.findById(order._id)).status, "PENDING");
    assert.equal((await Order.findById(order._id)).inventoryRestoredAt, undefined);
    await assert.rejects(ensurePaymentReady(), { status: 503, code: "PAYMENT_UNAVAILABLE" });
    assert.equal(await PaymentAttempt.countDocuments(), 0);
  } finally {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  }
});
