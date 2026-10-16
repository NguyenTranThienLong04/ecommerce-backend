const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");
const User = require("../src/models/User");
const Order = require("../src/models/Order");
const OrderItem = require("../src/models/OrderItem");
const PaymentAttempt = require("../src/models/PaymentAttempt");
const Product = require("../src/models/Product");
const Variant = require("../src/models/ProductVariant");
const Cart = require("../src/models/Cart");
const CartItem = require("../src/models/CartItem");
const transitionOrder = require("../src/services/orderTransition.service");
const autoCancel = require("../src/utils/autoCancelOrders");
const ensureCheckoutReady = require("../src/utils/checkoutReady");

// No dotenv, app startup, external payment calls, production DB or scheduler.
process.env.JWT_SECRET = "order-lifecycle-test-only";
process.env.VNP_HASH_SECRET = "vnpay-test-only";
process.env.VNP_TMN_CODE = "TESTSHOP";
process.env.VNP_URL = "https://payment.test/pay";
process.env.VNP_RETURN_URL = "https://shop.test/return";
process.env.VNP_RESULT_URL = "https://shop.test/payment-result";
let mongo, server, base, owner, other, admin, order, product, variants;
const now = new Date("2026-10-14T05:00:00Z");
const expired = new Date(now.getTime() - 20 * 60000);
const address = { receiverName: "Customer", phone: "0901234567", addressLine: "1 Test Street",
  ward: "Ward", district: "District", city: "City" };

async function request(method, route, user = owner, body) {
  const res = await fetch(base + route, { method, redirect: "manual",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt.sign({ userId: user.id, authVersion: user.authVersion ?? 0 }, process.env.JWT_SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text,
    location: res.headers.get("location") };
}
const cancel = (user = owner, id = order.id) => request("PUT", `/orders/${id}/cancel`, user);
const update = (status, user = admin, id = order.id) => request("PUT", `/orders/${id}/status`, user, { status });
const job = () => autoCancel(15, now);
async function configure(changes) {
  await Order.updateOne({ _id: order._id }, { $set: changes });
  order = await Order.findById(order._id);
}
function paymentQuery(changes = {}) {
  const reference = "ref" + order.id;
  const params = { vnp_TxnRef: reference, vnp_Amount: String(order.total * 100), vnp_TmnCode: "TESTSHOP",
    vnp_OrderInfo: `Thanh toan don hang ${order.id} ${reference}`, vnp_BankCode: "NCB",
    vnp_ResponseCode: "00", vnp_TransactionStatus: "00", vnp_TransactionNo: "123456", ...changes };
  const data = Object.keys(params).sort().map(key => encodeURIComponent(key) + "=" + encodeURIComponent(params[key]).replace(/%20/g, "+")).join("&");
  return data + "&vnp_SecureHash=" + createHmac("sha512", process.env.VNP_HASH_SECRET).update(data).digest("hex");
}
const payment = changes => request("GET", "/vnpay/ipn?" + paymentQuery(changes));
async function assertStock(expected = [8, 17]) {
  assert.deepEqual(await Promise.all(variants.map(async variant => (await Variant.findById(variant.id)).stock)), expected);
}
async function assertCancelled(paymentStatus = "UNPAID") {
  const saved = await Order.findById(order.id).lean();
  assert.equal(saved.status, "CANCEL");
  assert.equal(saved.paymentStatus, paymentStatus);
  assert.ok(saved.inventoryRestoredAt instanceof Date);
  assert.equal(saved.statusHistory.filter(entry => entry.to === "CANCEL" && entry.actorType !== "PAYMENT").length, 1);
  await assertStock([10, 20]);
  return saved;
}

// Gates wrap real query execution. Both transactions have already read their
// snapshots when they arrive; the DB still performs all writes/conflict retries.
function pauseClaims(t, arrivals = 1, accepts = () => true, model = "Order") {
  let count = 0, enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = mongoose.Query.prototype.exec;
  t.mock.method(mongoose.Query.prototype, "exec", async function (...args) {
    if (this.model.modelName === model && this.op === "findOneAndUpdate" && accepts(this) && count++ < arrivals) {
      if (count === arrivals) enter();
      await gate;
    }
    return original.apply(this, args);
  });
  t.after(release);
  return { entered: () => Promise.race([entered, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Race did not reach claim barrier")), 5000);
    entered.finally(() => clearTimeout(timer));
  })]), release };
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.24", downloadDir: path.join(__dirname, "../.cache/mongodb") },
    replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  await mongoose.connect(mongo.getUri(), { dbName: "order_lifecycle_regression" });
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  await ensureCheckoutReady();
  const app = express();
  app.use(express.json());
  app.use("/orders", require("../src/routes/order.route"));
  app.use("/cart", require("../src/routes/cart.route"));
  app.use("/vnpay", require("../src/routes/vnpay.route"));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
}, { timeout: 180000 });

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})));
  [owner, other, admin] = await User.create([
    { email: "owner@test.invalid", password: "unused" }, { email: "other@test.invalid", password: "unused" },
    { email: "admin@test.invalid", password: "unused", role: "ADMIN" }
  ]);
  product = await Product.create({ nameProduct: "Shirt", slug: "shirt" });
  variants = await Variant.create([
    { idProduct: product._id, size: "M", price: 100000, stock: 8 },
    { idProduct: product._id, size: "L", price: 100000, stock: 17 }
  ]);
  order = await Order.create({ idUser: owner._id, shippingMethod: "COD", total: 530000, createdAt: expired });
  await PaymentAttempt.create({ orderId: order._id, userId: owner._id, merchant: "TESTSHOP",
    reference: "ref" + order.id, expectedAmount: order.total, expiresAt: new Date(Date.now() + 600000) });
  await OrderItem.create(variants.map((variant, i) => ({ idOrder: order._id, idProductVariant: variant._id,
    quantity: i + 2, price: variant.price })));
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("COD follows each allowed edge; DONE records cash collection and retries do not duplicate history", async () => {
  for (const status of ["CONFIRMED", "SHIPPING", "DONE"]) {
    const result = await update(status);
    assert.equal(result.status, 200);
    assert.equal(result.body.order.paymentStatus, status === "DONE" ? "PAID" : "UNPAID");
    assert.equal((await update(status)).body.replayed, true);
  }
  const saved = await Order.findById(order.id);
  assert.deepEqual(saved.statusHistory.map(h => [h.from, h.to]), [["PENDING", "CONFIRMED"], ["CONFIRMED", "SHIPPING"], ["SHIPPING", "DONE"]]);
  assert.ok(saved.statusHistory.every(h => h.actorType === "ADMIN" && String(h.actorId) === admin.id));
  await assertStock();
});

test("admin cannot skip, rewind, invent statuses or smuggle payment fields; customer cannot use admin route", async () => {
  for (const status of ["SHIPPING", "DONE"]) assert.equal((await update(status)).status, 409);
  assert.equal((await update("BOGUS")).status, 400);
  assert.equal((await update("CONFIRMED", owner)).status, 403);
  assert.equal((await request("PUT", `/orders/${order.id}/status`, admin,
    { status: "CONFIRMED", paymentStatus: "PAID", actor: { type: "PAYMENT" } })).status, 200);
  assert.equal((await update("PENDING")).status, 409);
  assert.equal((await Order.findById(order.id)).paymentStatus, "UNPAID");
  await assertStock();
});

for (const terminal of ["CANCEL", "DONE"]) {
  test(terminal + " is terminal, including legacy records without restoration metadata", async () => {
    await configure({ status: terminal });
    await Order.collection.updateOne({ _id: order._id }, { $unset: { statusHistory: "", inventoryRestoredAt: "" } });
    for (const status of ["PENDING", "CONFIRMED", "SHIPPING", terminal === "CANCEL" ? "DONE" : "CANCEL"]) {
      assert.equal((await update(status)).status, 409);
    }
    assert.equal((await update(terminal)).body.replayed, true);
    if (terminal === "CANCEL") assert.equal((await cancel()).body.replayed, true);
    const saved = await Order.findById(order.id);
    assert.equal(saved.statusHistory.length, 0);
    assert.equal(saved.inventoryRestoredAt, undefined);
    await assertStock();
  });
}

test("user cancellation restores exact quantities once and returns a deterministic replay", async () => {
  const first = await cancel();
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  const second = await cancel();
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.deepEqual(second.body.order, first.body.order);
  const saved = await assertCancelled();
  assert.equal(saved.statusHistory[0].actorType, "USER");
  assert.equal(String(saved.statusHistory[0].actorId), owner.id);
});

test("ownership, payment method, paid state and shipment state are enforced for user cancellation", async () => {
  assert.equal((await cancel(other)).status, 404);
  for (const changes of [{ status: "CONFIRMED" }, { status: "SHIPPING" }, { status: "DONE" },
    { status: "PENDING", paymentStatus: "PAID" }, { paymentStatus: "UNPAID", shippingMethod: "UNKNOWN" }]) {
    await configure(changes);
    assert.equal((await cancel()).status, 409);
  }
  await configure({ status: "CANCEL" });
  assert.equal((await cancel(other)).status, 404, "replays still require ownership");
  await assertStock();
});

test("admin cancellation shares restoration, permits CONFIRMED unpaid and rejects paid/shipping orders", async () => {
  await configure({ status: "CONFIRMED" });
  assert.equal((await update("CANCEL")).status, 200);
  assert.equal((await update("CANCEL")).body.replayed, true);
  assert.equal((await assertCancelled()).statusHistory[0].actorType, "ADMIN");
  for (const changes of [{ status: "SHIPPING", paymentStatus: "UNPAID" }, { status: "PENDING", paymentStatus: "PAID" }]) {
    const another = await Order.create({ idUser: owner._id, shippingMethod: "COD", ...changes });
    assert.equal((await update("CANCEL", admin, another.id)).status, 409);
  }
});

test("VNPay admin progression requires verified payment and can never set PAID via DONE", async () => {
  await configure({ shippingMethod: "VNPAY" });
  assert.equal((await update("CONFIRMED")).status, 409);
  await configure({ status: "SHIPPING" });
  assert.equal((await update("DONE")).status, 409);
  assert.equal((await Order.findById(order.id)).paymentStatus, "UNPAID");
  assert.equal((await payment()).body.RspCode, "00");
  assert.equal((await Order.findById(order.id)).status, "SHIPPING", "callback never rewinds an older active order");
  assert.equal((await update("DONE")).status, 200);
  assert.equal((await payment()).body.RspCode, "02", "paid IPN replay remains idempotent after DONE");
  assert.equal((await Order.findById(order.id)).status, "DONE");
  await assertStock();
});

for (const phase of ["order claim", "first stock increment", "second stock increment"]) {
  test("failure after real " + phase + " rolls back order, history, marker and every stock increment", async t => {
    const original = mongoose.Query.prototype.exec;
    let increments = 0;
    t.mock.method(mongoose.Query.prototype, "exec", async function (...args) {
      const result = await original.apply(this, args);
      if ((phase === "order claim" && this.model.modelName === "Order" && this.op === "findOneAndUpdate") ||
          (this.model.modelName === "ProductVariant" && this.op === "updateOne" &&
          ++increments === (phase === "first stock increment" ? 1 : 2))) {
        throw new Error("injected secret DB failure");
      }
      return result;
    });
    const result = await cancel();
    assert.equal(result.status, 500);
    assert.doesNotMatch(JSON.stringify(result.body), /secret|injected/);
    const saved = await Order.findById(order.id);
    assert.equal(saved.status, "PENDING");
    assert.equal(saved.inventoryRestoredAt, undefined);
    assert.equal(saved.statusHistory.length, 0);
    await assertStock();
    t.mock.restoreAll();
    assert.equal((await cancel()).status, 200);
    await assertCancelled();
  });
}

test("missing inventory or corrupt quantities reject the entire cancellation instead of silently skipping stock", async () => {
  await OrderItem.updateOne({ idOrder: order._id }, { quantity: -2 });
  assert.equal((await cancel()).status, 409);
  await OrderItem.updateOne({ idOrder: order._id }, { quantity: 2 });
  await Variant.deleteOne({ _id: variants[1]._id });
  assert.equal((await cancel()).status, 409);
  assert.equal((await Variant.findById(variants[0].id)).stock, 8);
  assert.equal((await Order.findById(order.id)).status, "PENDING");
  assert.equal((await Order.findById(order.id)).statusHistory.length, 0);
});

test("multiple order lines for the same variant restore their combined quantity once", async () => {
  await OrderItem.create({ idOrder: order._id, idProductVariant: variants[0]._id, quantity: 4, price: 100000 });
  assert.equal((await cancel()).status, 200);
  assert.equal((await cancel()).body.replayed, true);
  await assertStock([14, 20]);
});

test("legacy active orders without new fields cancel normally without a backfill or new index", async () => {
  await Order.collection.updateOne({ _id: order._id }, { $unset: { statusHistory: "", inventoryRestoredAt: "" } });
  assert.equal((await cancel()).status, 200);
  await assertCancelled();
  const indexes = await Order.collection.indexes();
  assert.deepEqual(indexes.map(index => index.name).sort(), ["_id_", "checkout_user_key_unique"]);
});

for (const pair of ["user/user", "user/admin", "user/auto", "auto/auto"]) {
  test("concurrent " + pair + " claims: one committed cancellation and exactly one stock restoration", async t => {
    await configure({ shippingMethod: "VNPAY" });
    const gate = pauseClaims(t, 2);
    const operations = { user: () => cancel(), admin: () => update("CANCEL"), auto: job };
    const pending = Promise.all(pair.split("/").map(name => operations[name]()));
    await gate.entered();
    gate.release();
    const results = await pending;
    let winners = 0;
    for (const result of results) {
      if (result.status) {
        assert.equal(result.status, 200);
        if (!result.body.replayed) winners++;
      } else {
        assert.equal(result.failed, 0);
        winners += result.cancelled;
      }
    }
    assert.equal(winners, 1);
    await assertCancelled();
  });
}

test("auto-cancel selects only expired UNPAID PENDING VNPay, including the exact cutoff; repeated runs are safe", async () => {
  await configure({ shippingMethod: "VNPAY" });
  const boundary = new Date(now.getTime() - 15 * 60000);
  const scenarios = [
    { createdAt: boundary }, { createdAt: new Date(boundary.getTime() + 1) },
    { paymentStatus: "PAID" }, { shippingMethod: "COD" }, { status: "CONFIRMED" },
    { status: "SHIPPING" }, { status: "DONE" }, { status: "CANCEL" }
  ];
  const extra = [];
  for (const changes of scenarios) {
    const row = await Order.create({ idUser: owner._id, shippingMethod: "VNPAY", createdAt: expired, ...changes });
    await OrderItem.create({ idOrder: row._id, idProductVariant: variants[0]._id, quantity: 1, price: 100000 });
    extra.push(row);
  }
  assert.deepEqual(await job(), { cancelled: 2, skipped: 0, failed: 0 });
  assert.deepEqual(await job(), { cancelled: 0, skipped: 0, failed: 0 });
  for (let i = 0; i < extra.length; i++) assert.equal((await Order.findById(extra[i].id)).status, i === 0 ? "CANCEL" : extra[i].status);
  await assertStock([11, 20]);
});

for (const loser of ["user cancel", "auto cancel", "admin cancel"]) {
  test("payment wins after " + loser + " read its stale snapshot: cancellation cannot restore stock", async t => {
    await configure({ shippingMethod: "VNPAY" });
    const gate = pauseClaims(t, 1, query => query.getUpdate().$set.status === "CANCEL");
    const pending = loser === "auto cancel" ? job() : loser === "admin cancel" ? update("CANCEL") : cancel();
    await gate.entered();
    assert.equal((await payment()).body.RspCode, "00");
    gate.release();
    const result = await pending;
    if (loser === "auto cancel") assert.deepEqual(result, { cancelled: 0, skipped: 1, failed: 0 });
    else assert.equal(result.status, 409);
    const saved = await Order.findById(order.id);
    assert.equal(saved.status, "CONFIRMED");
    assert.equal(saved.paymentStatus, "PAID");
    assert.equal(saved.inventoryRestoredAt, undefined);
    assert.equal(saved.statusHistory.length, 1);
    await assertStock();
  });
}

test("cancellation wins after signed payment read its stale snapshot: callback and replay cannot reopen it", async t => {
  await configure({ shippingMethod: "VNPAY" });
  const gate = pauseClaims(t, 1, query => query.getUpdate().$set.paymentStatus === "PAID");
  const pending = payment();
  await gate.entered();
  assert.equal((await cancel()).status, 200);
  gate.release();
  assert.equal((await pending).body.RspCode, "00");
  assert.equal((await payment()).body.RspCode, "02");
  const saved = await assertCancelled("PAID");
  assert.equal(saved.paymentReviewRequired, true);
  assert.equal((await PaymentAttempt.findOne({ orderId: order._id })).reviewReason, "PAYMENT_AFTER_CANCELLATION");
});

test("simultaneous signed payment callbacks commit one payment history entry", async t => {
  await configure({ shippingMethod: "VNPAY" });
  const gate = pauseClaims(t, 2, () => true, "PaymentAttempt");
  const pending = Promise.all([payment(), payment()]);
  await gate.entered();
  gate.release();
  assert.deepEqual((await pending).map(result => result.body.RspCode).sort(), ["00", "02"]);
  assert.equal((await Order.findById(order.id)).statusHistory.length, 1);
  await assertStock();
});

test("admin shipping and admin cancellation contend on the same current state", async t => {
  await configure({ status: "CONFIRMED" });
  const gate = pauseClaims(t, 2);
  const pending = Promise.all([update("SHIPPING"), update("CANCEL")]);
  await gate.entered();
  gate.release();
  assert.deepEqual((await pending).map(result => result.status).sort(), [200, 409]);
  const saved = await Order.findById(order.id);
  assert.equal(saved.statusHistory.length, 1);
  if (saved.status === "CANCEL") await assertCancelled();
  else { assert.equal(saved.status, "SHIPPING"); await assertStock(); }
});

test("invalid signature, amount, terminal ID, method or unsuccessful payment cannot mark an order PAID", async () => {
  await configure({ shippingMethod: "VNPAY" });
  assert.equal((await request("GET", "/vnpay/ipn?" + paymentQuery().replace(/.$/, "x"))).body.RspCode, "97");
  assert.equal((await payment({ vnp_Amount: "1" })).body.RspCode, "04");
  assert.equal((await payment({ vnp_TmnCode: "WRONG" })).body.RspCode, "99");
  assert.equal((await payment({ vnp_Amount: "invalid" })).body.RspCode, "99");
  for (const changes of [{ vnp_ResponseCode: "24" }, { vnp_TransactionStatus: "02" }]) {
    assert.equal((await payment(changes)).body.RspCode, "99");
  }
  await configure({ shippingMethod: "COD" });
  assert.equal((await payment()).body.RspCode, "99");
  assert.equal((await Order.findById(order.id)).paymentStatus, "UNPAID");
  assert.equal((await Order.findById(order.id)).statusHistory.length, 0);
  await assertStock();
});

test("create/recreate URLs reject non-payable states and preserve lifecycle and inventory", async () => {
  await Order.collection.updateOne({ _id: order._id }, { $set: { createdAt: new Date() } });
  for (const route of ["create", "recreate"]) {
    await configure({ shippingMethod: "VNPAY", status: "PENDING", paymentStatus: "UNPAID" });
    const before = await Order.findById(order.id).lean();
    assert.equal((await request("POST", `/vnpay/${route}`, owner, { orderId: order.id, idempotencyKey: randomUUID() })).status, 200);
    const after = await Order.findById(order.id).lean();
    assert.equal(after.status, before.status);
    assert.equal(after.paymentStatus, before.paymentStatus);
    assert.deepEqual(after.statusHistory, before.statusHistory);
    assert.equal(after.paymentRevision, (before.paymentRevision || 0) + 1);
    for (const changes of [{ status: "CANCEL" }, { status: "DONE" }, { status: "CONFIRMED" },
      { status: "SHIPPING" }, { status: "PENDING", paymentStatus: "PAID" }, { paymentStatus: "UNPAID", shippingMethod: "COD" }]) {
      await configure(changes);
      assert.equal((await request("POST", `/vnpay/${route}`, owner, { orderId: order.id, idempotencyKey: randomUUID() })).status, 409);
    }
    assert.equal((await request("POST", `/vnpay/${route}`, owner, { orderId: { $ne: null } })).status, 400);
  }
  await assertStock();
});

test("server supplies role-specific UI actions from the shared rules", async () => {
  assert.deepEqual((await request("GET", "/orders", admin)).body[0].allowedTransitions, ["CONFIRMED", "CANCEL"]);
  assert.equal((await request("GET", "/orders/my")).body[0].canCancel, true);
  await configure({ shippingMethod: "VNPAY", paymentStatus: "PAID" });
  assert.deepEqual((await request("GET", "/orders", admin)).body[0].allowedTransitions, ["CONFIRMED"]);
  assert.equal((await request("GET", "/orders/my")).body[0].canCancel, false);
});

test("restoration marker blocks inconsistent active records and invalid internal actors are rejected", async () => {
  await configure({ inventoryRestoredAt: now });
  assert.equal((await cancel()).status, 409);
  assert.equal((await update("CONFIRMED")).status, 409);
  await assert.rejects(transitionOrder({ orderId: order.id, status: "CANCEL", actor: { type: "UNKNOWN" } }), { status: 403 });
  await assert.rejects(transitionOrder({ orderId: order.id, status: "CANCEL", actor: { type: "USER" } }), { status: 403 });
  await assert.rejects(autoCancel(-1, now), TypeError);
  await assertStock();
});

test("checkout and cancellation update shared inventory without losing either increment or decrement", async t => {
  const cart = await Cart.create({ idUser: other._id });
  await CartItem.create({ idCart: cart._id, idProductVariant: variants[0]._id, quantity: 1 });
  const quote = (await request("GET", "/cart", other)).body.checkout;
  const original = mongoose.Query.prototype.exec;
  let arrivals = 0, enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  t.mock.method(mongoose.Query.prototype, "exec", async function (...args) {
    if (this.model.modelName === "ProductVariant" && this.op === "updateOne" && arrivals++ < 2) {
      if (arrivals === 2) enter();
      await gate;
    }
    return original.apply(this, args);
  });
  const pending = Promise.all([cancel(), request("POST", "/orders", other, { ...address, shippingMethod: "COD",
    idempotencyKey: randomUUID(), cartId: cart.id, cartSnapshot: quote.snapshot })]);
  await entered;
  release();
  const results = await pending;
  assert.deepEqual(results.map(result => result.status), [200, 201]);
  await assertStock([9, 20]);
  const purchasedId = results[1].body.order._id;
  assert.equal((await cancel(other, purchasedId)).status, 200);
  assert.equal((await cancel(other, purchasedId)).body.replayed, true);
  await assertStock([10, 20]);
});
