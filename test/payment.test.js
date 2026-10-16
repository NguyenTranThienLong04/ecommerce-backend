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
const Variant = require("../src/models/ProductVariant");
const PaymentAttempt = require("../src/models/PaymentAttempt");
const paymentService = require("../src/services/payment.service");
const ensurePaymentReady = require("../src/utils/paymentReady");

// No dotenv, external gateway calls, production startup or real database.
Object.assign(process.env, { JWT_SECRET: "payment-test-only", VNP_HASH_SECRET: "payment-test-secret", VNP_TMN_CODE: "TESTSHOP",
  VNP_URL: "https://payment.test/pay", VNP_RETURN_URL: "https://api.test/vnpay/return", VNP_RESULT_URL: "https://shop.test/payment-result" });
let mongo, server, base, owner, other, admin, order, variant;
async function request(method, route, user = owner, body) {
  const res = await fetch(base + route, { method, redirect: "manual",
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: "Bearer " + jwt.sign({ userId: user.id, authVersion: user.authVersion ?? 0 }, process.env.JWT_SECRET) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text,
    location: res.headers.get("location"), cache: res.headers.get("cache-control") };
}
const create = (route = "create", body = {}, user = owner) => request("POST", "/vnpay/" + route, user,
  { orderId: order.id, idempotencyKey: randomUUID(), ...body });
async function attempt() {
  const result = await create();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return PaymentAttempt.findOne({ reference: result.body.reference }).lean();
}
const cancel = () => request("PUT", `/orders/${order.id}/cancel`);
const status = row => request("GET", "/vnpay/status/" + row.reference);
function signed(params) {
  const encode = value => encodeURIComponent(String(value)).replace(/%20/g, "+");
  const data = Object.keys(params).sort().map(key => encode(key) + "=" + encode(params[key])).join("&");
  return data + "&vnp_SecureHash=" + createHmac("sha512", process.env.VNP_HASH_SECRET).update(data).digest("hex");
}
function payload(row, changes = {}) {
  return { vnp_TmnCode: "TESTSHOP", vnp_TxnRef: row.reference, vnp_Amount: String(row.expectedAmount * 100),
    vnp_OrderInfo: `Thanh toan don hang ${row.orderId} ${row.reference}`, vnp_BankCode: "NCB", vnp_TransactionNo: "123456789",
    vnp_PayDate: "20261014121500", vnp_ResponseCode: "00", vnp_TransactionStatus: "00", ...changes };
}
const ipn = (row, changes) => request("GET", "/vnpay/ipn?" + signed(payload(row, changes)), null);
const browserReturn = (row, changes) => request("GET", "/vnpay/return?" + signed(payload(row, changes)), null);
const failure = { vnp_ResponseCode: "24", vnp_TransactionStatus: "02", vnp_TransactionNo: "0" };
async function unchanged() {
  const saved = await Order.findById(order.id);
  assert.equal(saved.paymentStatus, "UNPAID"); assert.equal(saved.status, "PENDING");
  assert.equal(saved.statusHistory.length, 0); assert.equal((await Variant.findById(variant.id)).stock, 3);
}
function pause(t, accepts, arrivals = 1) {
  let count = 0, enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = mongoose.Query.prototype.exec;
  t.mock.method(mongoose.Query.prototype, "exec", async function (...args) {
    if (accepts(this) && count++ < arrivals) { if (count === arrivals) enter(); await gate; }
    return original.apply(this, args);
  });
  t.after(release);
  return { release, entered: () => Promise.race([entered, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Payment barrier not reached")), 5000);
    entered.finally(() => clearTimeout(timer));
  })]) };
}
const claim = model => query => query.model.modelName === model && query.op === "findOneAndUpdate";
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.24", downloadDir: path.join(__dirname, "../.cache/mongodb") },
    replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  await mongoose.connect(mongo.getUri(), { dbName: "payment_regression" });
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  await ensurePaymentReady();
  const app = express(); app.use(express.json());
  app.use("/vnpay", require("../src/routes/vnpay.route")); app.use("/orders", require("../src/routes/order.route"));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
}, { timeout: 180000 });
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})));
  [owner, other, admin] = await User.create([{ email: "owner@test.invalid", password: "unused" },
    { email: "other@test.invalid", password: "unused" }, { email: "admin@test.invalid", password: "unused", role: "ADMIN" }]);
  order = await Order.create({ idUser: owner._id, shippingMethod: "VNPAY", total: 230000 });
  variant = await Variant.create({ idProduct: new mongoose.Types.ObjectId(), price: 100000, stock: 3 });
  await OrderItem.create({ idOrder: order._id, idProductVariant: variant._id, quantity: 2, price: 100000 });
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect(); if (mongo) await mongo.stop();
});

test("creation uses server amount and ownership; retry has a new uniquely indexed reference", async () => {
  const first = await create("create", { amount: 1, userId: other.id, reference: "attacker" });
  const second = await create("recreate");
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.notEqual(first.body.reference, second.body.reference); assert.notEqual(first.body.reference, order.id);
  const url = new URL(first.body.paymentUrl);
  assert.equal(url.searchParams.get("vnp_Amount"), "23000000");
  assert.equal(url.searchParams.get("vnp_TxnRef"), first.body.reference);
  const row = await PaymentAttempt.findOne({ reference: first.body.reference }).lean();
  assert.equal(row.expectedAmount, 230000); assert.equal(String(row.userId), owner.id);
  assert.ok(row.expiresAt <= new Date(order.createdAt.getTime() + 15 * 60000));
  const params = Object.fromEntries(url.searchParams), hash = params.vnp_SecureHash;
  delete params.vnp_SecureHash;
  assert.equal(new URLSearchParams(signed(params)).get("vnp_SecureHash"), hash);
  const indexes = await PaymentAttempt.collection.indexes();
  for (const name of ["payment_reference_unique", "payment_provider_transaction_unique"])
    assert.equal(indexes.find(index => index.name === name).unique, true);
  await assert.rejects(PaymentAttempt.collection.insertOne({ ...row, _id: new mongoose.Types.ObjectId() }), { code: 11000 });
  await unchanged();
});
test("payment dates use GMT+7 across a UTC day boundary", async () => {
  const now = new Date("2026-10-14T20:59:59Z");
  await Order.collection.updateOne({ _id: order._id }, { $set: { createdAt: now } });
  const result = await paymentService.createAttempt(owner._id, order._id, randomUUID(), "127.0.0.1", now);
  const params = new URL(result.paymentUrl).searchParams;
  assert.equal(params.get("vnp_CreateDate"), "20261015035959"); assert.equal(params.get("vnp_ExpireDate"), "20261015041459");
});
test("creation rejects foreign, paid, cancelled, non-VNPay and expired orders", async () => {
  for (const route of ["create", "recreate"]) assert.equal((await create(route, {}, other)).status, 404);
  for (const changes of [{ paymentStatus: "PAID" }, { paymentStatus: "UNPAID", status: "CANCEL" },
    { status: "DONE" }, { status: "PENDING", shippingMethod: "COD" }]) {
    await Order.updateOne({ _id: order._id }, changes); assert.equal((await create()).status, 409);
  }
  await Order.collection.updateOne({ _id: order._id }, { $set: { shippingMethod: "VNPAY", createdAt: new Date(Date.now() - 16 * 60000) } });
  assert.equal((await create()).body.code, "PAYMENT_WINDOW_EXPIRED"); assert.equal(await PaymentAttempt.countDocuments(), 0);
});
test("concurrent creators cannot exceed the unresolved-attempt cap", async t => {
  await attempt();
  const gate = pause(t, claim("Order"), 4), pending = Promise.all([create(), create(), create(), create()]);
  await gate.entered(); gate.release();
  assert.deepEqual((await pending).map(result => result.status).sort(), [200, 200, 409, 409]);
  assert.equal(await PaymentAttempt.countDocuments(), 3);
  assert.equal((await create()).body.code, "PAYMENT_ATTEMPT_LIMIT"); await unchanged();
});
test("creation rollback removes the inserted attempt and order revision", async t => {
  const original = PaymentAttempt.create;
  t.mock.method(PaymentAttempt, "create", async function (...args) { await original.apply(this, args); throw new Error("secret failure"); });
  const result = await create();
  assert.equal(result.status, 500); assert.doesNotMatch(JSON.stringify(result.body), /secret/);
  assert.equal(await PaymentAttempt.countDocuments(), 0); assert.equal((await Order.findById(order.id)).paymentRevision, undefined);
});
test("valid IPN settles without browser Return and records provider data without changing stock", async () => {
  const row = await attempt(), result = await ipn(row);
  assert.equal(result.status, 200); assert.equal(result.body.RspCode, "00");
  const saved = await Order.findById(order.id);
  assert.equal((await PaymentAttempt.findById(row._id)).status, "SUCCESS");
  assert.equal(saved.paymentStatus, "PAID"); assert.equal(saved.status, "CONFIRMED");
  assert.equal(String(saved.settledPaymentAttempt), String(row._id)); assert.equal(saved.paymentReference, row.reference);
  assert.equal(saved.providerTransactionNo, "123456789"); assert.ok(saved.paidAt instanceof Date);
  assert.equal(saved.statusHistory.length, 1); assert.equal((await Variant.findById(variant.id)).stock, 3);
  assert.equal((await status(row)).body.state, "PAID");
});
test("sequential and concurrent duplicate IPNs finalize exactly once", async t => {
  const row = await attempt(), gate = pause(t, claim("PaymentAttempt"), 3);
  const pending = Promise.all([ipn(row), ipn(row), ipn(row)]);
  await gate.entered(); gate.release();
  assert.deepEqual((await pending).map(result => result.body.RspCode).sort(), ["00", "02", "02"]);
  const before = await Order.findById(order.id).lean(), attemptBefore = await PaymentAttempt.findById(row._id).lean();
  assert.equal((await ipn(row)).body.RspCode, "02");
  assert.deepEqual(await Order.findById(order.id).lean(), before);
  assert.deepEqual(await PaymentAttempt.findById(row._id).lean(), attemptBefore); assert.equal(before.statusHistory.length, 1);
});
for (const model of ["PaymentAttempt", "Order"]) {
  test("failure after real " + model + " write rolls back settlement and returns retryable 99", async t => {
    const row = await attempt(), original = mongoose.Query.prototype.exec;
    t.mock.method(mongoose.Query.prototype, "exec", async function (...args) {
      const result = await original.apply(this, args); if (claim(model)(this)) throw new Error("secret DB failure"); return result;
    });
    const result = await ipn(row);
    assert.equal(result.body.RspCode, "99"); assert.doesNotMatch(JSON.stringify(result.body), /secret|DB/);
    assert.equal((await PaymentAttempt.findById(row._id)).status, "PENDING");
    assert.equal((await PaymentAttempt.findById(row._id)).providerTransactionNo, undefined); await unchanged();
    t.mock.restoreAll(); assert.equal((await ipn(row)).body.RspCode, "00");
  });
}
test("IPN cannot acknowledge success before the transaction commits", async t => {
  const row = await attempt(), gate = pause(t, claim("Order")); let responded = false;
  const pending = ipn(row).then(result => { responded = true; return result; });
  await gate.entered(); assert.equal(responded, false); await unchanged();
  assert.equal((await PaymentAttempt.findById(row._id)).status, "PENDING");
  gate.release(); assert.equal((await pending).body.RspCode, "00");
});
test("invalid signature, merchant, reference, amount, result and duplicate parameters cannot settle", async () => {
  const row = await attempt();
  assert.equal((await request("GET", "/vnpay/ipn?" + signed(payload(row)).replace(/.$/, "x"), null)).body.RspCode, "97");
  for (const [changes, expected] of [[{ vnp_TmnCode: "OTHER001" }, "99"], [{ vnp_TxnRef: "unknown" }, "01"],
    [{ vnp_Amount: "1" }, "04"], [{ vnp_Amount: "1e3" }, "99"], [{ vnp_ResponseCode: "ZZ" }, "99"],
    [{ vnp_TransactionStatus: "99" }, "99"], [{ vnp_TransactionStatus: "02" }, "99"], [{ vnp_TransactionNo: "0" }, "99"],
    [{ vnp_OrderInfo: "different order" }, "99"], [{ vnp_BankCode: "" }, "99"]]) assert.equal((await ipn(row, changes)).body.RspCode, expected);
  assert.equal((await request("GET", "/vnpay/ipn?" + signed(payload(row)) + "&vnp_Amount=23000000", null)).body.RspCode, "99");
  await unchanged(); assert.equal((await PaymentAttempt.findById(row._id)).status, "PENDING");
});
test("signed callback cannot bypass corrupted order mapping or missing order", async () => {
  const row = await attempt(), foreign = await Order.create({ idUser: other._id, shippingMethod: "VNPAY", total: order.total });
  await PaymentAttempt.collection.updateOne({ _id: row._id }, { $set: { orderId: foreign._id } });
  assert.equal((await ipn(row)).body.RspCode, "99"); assert.equal((await Order.findById(foreign.id)).paymentStatus, "UNPAID");
  await unchanged();
  await PaymentAttempt.collection.updateOne({ _id: row._id }, { $set: { orderId: new mongoose.Types.ObjectId() } });
  assert.equal((await ipn(row)).body.RspCode, "01");
});
test("Return success/failure is read-only: PROCESSING before IPN, PAID after IPN", async () => {
  const row = await attempt(), before = await Order.findById(order.id).lean(), attemptBefore = await PaymentAttempt.findById(row._id).lean();
  for (const changes of [{}, failure]) {
    const result = await browserReturn(row, changes);
    assert.equal(result.status, 302); assert.equal(result.location, "https://shop.test/payment-result?reference=" + row.reference);
    assert.equal((await status(row)).body.state, "PROCESSING");
  }
  assert.deepEqual(await Order.findById(order.id).lean(), before); assert.deepEqual(await PaymentAttempt.findById(row._id).lean(), attemptBefore);
  await ipn(row); assert.equal((await browserReturn(row)).status, 302); assert.equal((await status(row)).body.state, "PAID");
});
test("Return rejects invalid input without reflecting raw query data into HTML", async () => {
  const row = await attempt(), result = await browserReturn(row, { vnp_OrderInfo: "<script>secretAttack()</script>" });
  assert.equal(result.status, 409); assert.doesNotMatch(JSON.stringify(result.body), /<script>|secretAttack/);
  assert.equal((await request("GET", "/vnpay/return?" + signed(payload(row)).replace(/.$/, "x"), null)).status, 400); await unchanged();
});
test("provider failure finalizes its attempt only and permits retry with a new reference", async () => {
  const row = await attempt(); assert.equal((await ipn(row, failure)).body.RspCode, "00");
  assert.equal((await ipn(row, failure)).body.RspCode, "02"); assert.equal((await status(row)).body.state, "FAILED");
  const retry = await create("recreate"); assert.equal(retry.status, 200); assert.notEqual(retry.body.reference, row.reference); await unchanged();
});
test("expiry keeps unresolved attempt PENDING and still accepts verified late IPN", async () => {
  const row = await attempt();
  await PaymentAttempt.collection.updateOne({ _id: row._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await status(row)).body.state, "EXPIRED"); assert.equal((await PaymentAttempt.findById(row._id)).status, "PENDING");
  assert.equal((await ipn(row)).body.RspCode, "00"); assert.equal((await Order.findById(order.id)).paymentStatus, "PAID");
});
test("cancel before IPN preserves CANCEL/stock and records actual money as PAID requiring review", async () => {
  const row = await attempt(); assert.equal((await cancel()).status, 200); assert.equal((await ipn(row)).body.RspCode, "00");
  const saved = await Order.findById(order.id), paid = await PaymentAttempt.findById(row._id);
  assert.equal(saved.status, "CANCEL"); assert.equal(saved.paymentStatus, "PAID"); assert.equal(saved.paymentReviewRequired, true);
  assert.equal(paid.status, "REQUIRES_REVIEW"); assert.equal(paid.reviewReason, "PAYMENT_AFTER_CANCELLATION");
  assert.equal(paid.providerTransactionNo, "123456789"); assert.equal((await status(row)).body.state, "REQUIRES_REVIEW");
  assert.equal((await ipn(row)).body.RspCode, "02"); assert.equal((await Variant.findById(variant.id)).stock, 5);
});
test("IPN before cancel rejects cancellation without restoring inventory", async () => {
  const row = await attempt(); assert.equal((await ipn(row)).body.RspCode, "00");
  assert.equal((await cancel()).status, 409); assert.equal((await Variant.findById(variant.id)).stock, 3);
});
test("two successful attempts race: one order settlement, extra money retained for review", async t => {
  const first = await attempt(), second = await attempt(), gate = pause(t, claim("PaymentAttempt"), 2);
  const pending = Promise.all([ipn(first), ipn(second, { vnp_TransactionNo: "987654321" })]);
  await gate.entered(); gate.release(); assert.deepEqual((await pending).map(result => result.body.RspCode), ["00", "00"]);
  const rows = await PaymentAttempt.find({ orderId: order._id });
  assert.deepEqual(rows.map(row => row.status).sort(), ["REQUIRES_REVIEW", "SUCCESS"]);
  assert.equal(rows.find(row => row.status === "REQUIRES_REVIEW").reviewReason, "ADDITIONAL_PAYMENT");
  const saved = await Order.findById(order.id);
  assert.equal(saved.statusHistory.length, 1); assert.equal(saved.paymentReviewRequired, true); assert.equal(saved.paymentStatus, "PAID");
  assert.equal((await Variant.findById(variant.id)).stock, 3);
});
test("one provider transaction cannot settle two distinct references", async () => {
  const first = await attempt(), second = await attempt();
  assert.equal((await ipn(first)).body.RspCode, "00"); assert.equal((await ipn(second)).body.RspCode, "99");
  assert.equal((await PaymentAttempt.findById(second._id)).status, "PENDING"); assert.equal((await Order.findById(order.id)).statusHistory.length, 1);
});
test("contradictory signed callback preserves first finalization and records later money report for review", async () => {
  const row = await attempt(); await ipn(row, failure); assert.equal((await ipn(row)).body.RspCode, "99");
  const saved = await PaymentAttempt.findById(row._id).lean();
  assert.equal(saved.status, "FAILED"); assert.equal(saved.reviewReason, "CONFLICTING_CALLBACK");
  assert.equal(saved.conflictingResult.providerTransactionNo, "123456789"); assert.equal(saved.conflictingResult.responseCode, "00");
  assert.equal((await status(row)).body.state, "REQUIRES_REVIEW"); assert.equal((await ipn(row)).body.RspCode, "99");
  assert.deepEqual(await PaymentAttempt.findById(row._id).lean(), saved); await unchanged();
});
test("code 07 is retained for review and blocks further payment/cancellation without claiming PAID", async () => {
  const row = await attempt(); assert.equal((await ipn(row, { vnp_ResponseCode: "07", vnp_TransactionStatus: "07" })).body.RspCode, "00");
  assert.equal((await PaymentAttempt.findById(row._id)).status, "REQUIRES_REVIEW");
  assert.equal((await status(row)).body.state, "REQUIRES_REVIEW");
  assert.equal((await create()).status, 409); assert.equal((await cancel()).status, 409); await unchanged();
});
test("status ownership and reconciliation admin authorization are enforced", async () => {
  const row = await attempt(); assert.equal((await request("GET", "/vnpay/status/" + row.reference, other)).status, 404);
  assert.ok((await request("GET", "/vnpay/status/" + row.reference, null)).status >= 400);
  assert.equal((await status(row)).cache, "no-store"); assert.equal((await request("GET", "/vnpay/reconciliation", owner)).status, 403);
  assert.equal((await request("GET", "/vnpay/reconciliation?limit=bad", admin)).status, 400);
});
test("reconciliation identifies overdue pending, unpaid orders, late money and success mismatch with pagination", async () => {
  const pending = await attempt();
  await PaymentAttempt.collection.updateOne({ _id: pending._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  let result = await request("GET", "/vnpay/reconciliation?limit=1", admin);
  assert.equal(result.status, 200); assert.equal(result.body.providerQueried, false);
  assert.ok(result.body.items[0].reasons.includes("PENDING_OVERDUE")); assert.ok(result.body.items[0].reasons.includes("UNPAID_ORDER_WITH_ATTEMPT"));
  const late = await attempt(); await cancel(); await ipn(late);
  result = await request("GET", "/vnpay/reconciliation?limit=1", admin); assert.ok(result.body.nextCursor);
  const next = await request("GET", "/vnpay/reconciliation?limit=1&after=" + result.body.nextCursor, admin);
  assert.ok(next.body.items[0].reasons.includes("PAID_AFTER_CANCELLATION")); assert.ok(next.body.items[0].reasons.includes("REQUIRES_REVIEW"));
  assert.equal(next.body.nextCursor, null);
  await PaymentAttempt.updateOne({ _id: late._id }, { status: "SUCCESS" }); await Order.updateOne({ _id: order._id }, { paymentStatus: "UNPAID" });
  result = await request("GET", "/vnpay/reconciliation", admin);
  assert.ok(result.body.items.find(item => item.reference === late.reference).reasons.includes("SUCCESS_ORDER_MISMATCH"));
});
test("missing config fails before creation without disclosing credentials", async t => {
  const saved = process.env.VNP_RESULT_URL; delete process.env.VNP_RESULT_URL;
  t.after(() => { process.env.VNP_RESULT_URL = saved; });
  const result = await create(); assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result.body), /payment-test-secret/);
  assert.equal(await PaymentAttempt.countDocuments(), 0);
});
