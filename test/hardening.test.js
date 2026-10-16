const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { io: client } = require("socket.io-client");
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");
const { start } = require("../server");
const User = require("../src/models/User");
const Product = require("../src/models/Product");
const Variant = require("../src/models/ProductVariant");
const Category = require("../src/models/Category");
const Cart = require("../src/models/Cart");
const CartItem = require("../src/models/CartItem");
const Order = require("../src/models/Order");
const OrderItem = require("../src/models/OrderItem");
const Attempt = require("../src/models/PaymentAttempt");
const Conversation = require("../src/models/Conversation");
const Member = require("../src/models/ConversationUser");
const Message = require("../src/models/Message");
const address = { receiverName: "Customer", phone: "0901234567", addressLine: "1 Test Street", ward: "Ward", district: "District", city: "City" };
const password = "Batch8Test123!";
let mongo, runtime, disabledServer, base, disabledBase, hash, owner, other, admin, product, variant, cart, item;
const tokenFor = user => jwt.sign({ userId: user.id, authVersion: user.authVersion ?? 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function request(method, route, { user = owner, token, body, disabled = false } = {}) {
  const response = await fetch((disabled ? disabledBase : base) + "/api" + route, { method,
    headers: { "Content-Type": "application/json", ...(user || token ? { Authorization: "Bearer " + (token || tokenFor(user)) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function intent(method = "COD", disabled = false) {
  const { body } = await request("GET", "/cart", { disabled });
  return { ...address, cartId: body.cart._id, cartSnapshot: body.checkout.snapshot, shippingMethod: method, idempotencyKey: randomUUID() };
}
async function checkout(method = "COD") {
  const result = await request("POST", "/orders", { body: await intent(method) });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.order;
}
const stockEdit = (stock, previous = variant) => request("PATCH", "/variants/" + variant.id + "/stock", {
  user: admin, body: { stock, expectedStock: previous.stock, expectedVersion: previous.inventoryVersion ?? 0 }
});
const createPayment = (orderId, key = randomUUID(), user = owner) => request("POST", "/vnpay/create", {
  user, body: { orderId, idempotencyKey: key }
});
async function complete(order) {
  for (const status of ["CONFIRMED", "SHIPPING", "DONE"]) {
    const result = await request("PUT", "/orders/" + order._id + "/status", { user: admin, body: { status } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.24", downloadDir: path.join(__dirname, "../.cache/mongodb") },
    replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  const env = { NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", MONGO_URI: mongo.getUri("clothing_batch8"),
    JWT_SECRET: "batch8-isolated-tests-only-secret-key", FRONTEND_URL: "http://localhost:3000", VNPAY_ENABLED: "true",
    CLOUDINARY_ENABLED: "false", VNP_TMN_CODE: "BATCH8", VNP_HASH_SECRET: "batch8-provider-test-only",
    VNP_URL: "https://gateway.test/pay", VNP_RETURN_URL: "https://api.test/return", VNP_RESULT_URL: "https://shop.test/payment-result" };
  Object.assign(process.env, env);
  runtime = await start({ env, scheduler: false });
  base = "http://127.0.0.1:" + runtime.server.address().port;
  disabledServer = http.createServer(require("../src/app")({ ...runtime.config, vnpayEnabled: false }));
  await new Promise(resolve => disabledServer.listen(0, "127.0.0.1", resolve));
  disabledBase = "http://127.0.0.1:" + disabledServer.address().port;
  hash = await bcrypt.hash(password, 10);
}, { timeout: 180000 });
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})));
  [owner, other, admin] = await User.create([
    { email: "owner@batch8.example.com", password: hash }, { email: "other@batch8.example.com", password: hash },
    { email: "admin@batch8.example.com", password: hash, role: "ADMIN" }
  ]);
  const category = await Category.create({ nameCategory: "Shirts" });
  product = await Product.create({ nameProduct: "Batch Eight Shirt", slug: "batch-eight-shirt", idCategory: category._id });
  variant = await Variant.create({ idProduct: product._id, size: "M", color: "black", price: 100000, stock: 5 });
  cart = await Cart.create({ idUser: owner._id });
  item = await CartItem.create({ idCart: cart._id, idProductVariant: variant._id, quantity: 2 });
});
after(async () => {
  if (disabledServer) await new Promise(resolve => disabledServer.close(resolve));
  await runtime?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

test("H01: metadata from an old form cannot overwrite stock consumed by checkout", async () => {
  const read = await request("GET", "/products/admin/" + product.id, { user: admin });
  assert.equal(read.body.variants[0].stock, 5);
  await checkout();
  const result = await request("PATCH", "/variants/" + variant.id, { user: admin, body: { price: 120000, size: "L" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.price, 120000);
  assert.equal(result.body.stock, 3);
  assert.equal(result.body.inventoryVersion, 1);
  const legacy = await request("PATCH", "/variants/" + variant.id, { user: admin, body: { price: 130000, stock: 5 } });
  assert.equal(legacy.status, 400);
  assert.equal((await Variant.findById(variant.id)).stock, 3);
});
test("H01: explicit stale stock edit returns 409 after checkout", async () => {
  await checkout();
  const result = await stockEdit(8);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "INVENTORY_CHANGED");
  assert.equal((await Variant.findById(variant.id)).stock, 3);
});
test("H01: cancellation restores stock; stale metadata/stock cannot erase it, including ABA", async () => {
  const order = await checkout();
  const readAfterCheckout = await Variant.findById(variant.id);
  assert.equal((await request("PUT", "/orders/" + order._id + "/cancel")).status, 200);
  assert.equal((await request("PATCH", "/variants/" + variant.id, { user: admin, body: { price: 110000 } })).status, 200);
  assert.equal((await stockEdit(1, readAfterCheckout)).status, 409);
  assert.equal((await stockEdit(8, variant)).status, 409, "stock is 5 again but its version changed twice");
  const saved = await Variant.findById(variant.id);
  assert.equal(saved.stock, 5); assert.equal(saved.inventoryVersion, 2);
});
test("H01: two concurrent adjustments have one winner and legacy version zero is supported", async () => {
  await Variant.collection.updateOne({ _id: variant._id }, { $unset: { inventoryVersion: "" } });
  const results = await Promise.all([stockEdit(7), stockEdit(9)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = await Variant.findById(variant.id);
  assert.ok([7, 9].includes(saved.stock)); assert.equal(saved.inventoryVersion, 1);
  const body = { stock: 6, expectedStock: saved.stock, expectedVersion: 1 };
  assert.equal((await request("PATCH", "/variants/" + variant.id + "/stock", { body })).status, 403);
  for (const stock of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await request("PATCH", "/variants/" + variant.id + "/stock", { user: admin, body: { ...body, stock } })).status, 400);
  }
});
test("H01: checkout retries a real transaction conflict with an inventory adjustment", async t => {
  let enter, release, paused = false;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = Order.create;
  t.mock.method(Order, "create", async function (...args) {
    if (!paused) { paused = true; enter(); await gate; }
    return original.apply(this, args);
  });
  t.after(release);
  const pending = checkout();
  await entered;
  assert.equal((await stockEdit(4)).status, 200);
  release();
  await pending;
  const saved = await Variant.findById(variant.id);
  assert.equal(saved.stock, 2); assert.equal(saved.inventoryVersion, 2);
  assert.equal(await Order.countDocuments(), 1);
});

test("M01: disabled VNPay rejects before any checkout transaction write; COD still succeeds", async t => {
  const quote = await request("GET", "/cart", { disabled: true });
  assert.deepEqual(quote.body.paymentMethods, ["COD"]);
  assert.deepEqual((await request("GET", "/cart")).body.paymentMethods, ["COD", "VNPAY"]);
  const rows = await CartItem.find().lean();
  const original = mongoose.connection.transaction;
  const transaction = t.mock.method(mongoose.connection, "transaction", function (...args) { return original.apply(this, args); });
  const result = await request("POST", "/orders", { disabled: true, body: await intent("VNPAY", true) });
  assert.equal(result.status, 409); assert.equal(result.body.code, "PAYMENT_METHOD_UNAVAILABLE");
  assert.equal(transaction.mock.callCount(), 0);
  assert.equal(await Order.countDocuments(), 0); assert.equal(await OrderItem.countDocuments(), 0);
  assert.equal((await Variant.findById(variant.id)).stock, 5);
  assert.deepEqual(await CartItem.find().lean(), rows);
  assert.equal((await request("POST", "/orders", { disabled: true, body: await intent("COD", true) })).status, 201);
  assert.equal((await Variant.findById(variant.id)).stock, 3);
});
test("M01: disabling new VNPay checkouts does not destroy an already committed checkout replay", async () => {
  const input = await intent("VNPAY");
  const first = await request("POST", "/orders", { body: input });
  const replay = await request("POST", "/orders", { disabled: true, body: input });
  assert.equal(first.status, 201); assert.equal(replay.status, 200);
  assert.equal(replay.body.order._id, first.body.order._id); assert.equal(replay.body.replayed, true);
  assert.equal(await Order.countDocuments(), 1); assert.equal((await Variant.findById(variant.id)).stock, 3);
});

test("M02: drop the HTTP response after attempt commit, then retry the exact key/link without another attempt", async t => {
  const order = await checkout("VNPAY"), key = randomUUID();
  const json = express.response.json;
  let dropped = false;
  t.mock.method(express.response, "json", function (body) {
    if (!dropped && this.req.originalUrl === "/api/vnpay/create" && body.reference) {
      dropped = true; this.destroy(); return this;
    }
    return json.call(this, body);
  });
  await assert.rejects(createPayment(order._id, key));
  assert.equal(dropped, true);
  const saved = await Attempt.findOne({ idempotencyKey: key }).lean();
  assert.ok(saved);
  const retry = await createPayment(order._id, key);
  assert.equal(retry.status, 200); assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.reference, saved.reference); assert.equal(retry.body.paymentUrl, saved.paymentUrl);
  assert.equal(await Attempt.countDocuments(), 1);
  const current = await Order.findById(order._id);
  assert.equal(current.paymentRevision, 1); assert.equal(current.status, "PENDING"); assert.equal(current.paymentStatus, "UNPAID");
  assert.equal(current.total, 230000); assert.equal((await Variant.findById(variant.id)).stock, 3);
});
test("M02: concurrent same-key creation has one attempt and a real unique index", async () => {
  const order = await checkout("VNPAY"), key = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => createPayment(order._id, key)));
  assert.deepEqual(results.map(result => result.status), Array(6).fill(200));
  assert.equal(new Set(results.map(result => result.body.reference)).size, 1);
  assert.equal(new Set(results.map(result => result.body.paymentUrl)).size, 1);
  assert.equal(await Attempt.countDocuments(), 1);
  assert.equal((await Order.findById(order._id)).paymentRevision, 1);
  const index = (await Attempt.collection.indexes()).find(index => index.name === "payment_user_key_unique");
  assert.equal(index.unique, true); assert.deepEqual(index.key, { userId: 1, idempotencyKey: 1 });
});
test("M02: new intentional keys create distinct attempts, cap remains, replay still works at the cap", async () => {
  const order = await checkout("VNPAY"), key = randomUUID();
  const first = await createPayment(order._id, key);
  const second = await createPayment(order._id);
  assert.notEqual(first.body.reference, second.body.reference);
  assert.equal((await createPayment(order._id)).status, 200);
  assert.equal((await createPayment(order._id)).body.code, "PAYMENT_ATTEMPT_LIMIT");
  assert.equal((await createPayment(order._id, key)).body.reference, first.body.reference);
  assert.equal(await Attempt.countDocuments(), 3); assert.equal((await Variant.findById(variant.id)).stock, 3);
});
test("M02: same key cannot change order/amount, and keys are scoped to their authenticated owner", async () => {
  const order = await checkout("VNPAY"), key = randomUUID();
  assert.equal((await createPayment(order._id, key)).status, 200);
  const another = await Order.create({ idUser: owner._id, total: 230000, shippingMethod: "VNPAY" });
  const foreign = await Order.create({ idUser: other._id, total: 230000, shippingMethod: "VNPAY" });
  assert.equal((await createPayment(another.id, key)).body.code, "PAYMENT_KEY_REUSED");
  assert.equal((await request("POST", "/vnpay/create", { body: { orderId: order._id, idempotencyKey: key, amount: 1 } })).body.code,
    "PAYMENT_KEY_REUSED");
  assert.equal((await createPayment(order._id, key, other)).status, 404);
  assert.equal((await createPayment(foreign.id, key, other)).status, 200);
  await Order.updateOne({ _id: order._id }, { total: 240000 });
  assert.equal((await createPayment(order._id, key)).body.code, "PAYMENT_INTENT_CHANGED");
  assert.equal(await Attempt.countDocuments(), 2);
});
test("M02: replay after cancellation returns the existing reference without another payable link", async () => {
  const order = await checkout("VNPAY"), key = randomUUID();
  const first = await createPayment(order._id, key);
  assert.equal((await request("PUT", "/orders/" + order._id + "/cancel")).status, 200);
  const replay = await createPayment(order._id, key);
  assert.equal(replay.status, 200); assert.equal(replay.body.reference, first.body.reference);
  assert.equal(replay.body.paymentUrl, null); assert.equal(await Attempt.countDocuments(), 1);
});

test("M03: a real checkout completed through the state machine contributes 230000, never 260000", async () => {
  const order = await checkout(); await complete(order);
  for (const extra of [{ status: "PENDING", paymentStatus: "UNPAID" }, { status: "CANCEL", paymentStatus: "PAID" },
    { status: "DONE", paymentStatus: "UNPAID" }, { status: "DONE", paymentStatus: "PAID", paymentReviewRequired: true }]) {
    await Order.create({ idUser: owner._id, total: 999999, shippingFee: 30000, ...extra });
  }
  assert.equal((await request("GET", "/admin/dashboard", { user: admin })).body.revenue, 230000);
  const daily = (await request("GET", "/admin/revenue-by-date", { user: admin })).body;
  assert.equal(daily.reduce((sum, row) => sum + row.revenue, 0), 230000);
  const users = (await request("GET", "/admin/top-users", { user: admin })).body;
  assert.equal(users[0].totalSpent, 230000);
  assert.equal((await request("GET", "/admin/dashboard")).status, 403);
});
test("M03: top products groups actual OrderItems across variants, using sale prices and preserving archives", async () => {
  const order = await checkout(); await complete(order);
  const secondProduct = await Product.create({ nameProduct: "Other Shirt", slug: "other-shirt", archivedAt: new Date() });
  const otherVariant = await Variant.create({ idProduct: secondProduct._id, price: 900000, stock: 1, archivedAt: new Date() });
  const sameProductVariant = await Variant.create({ idProduct: product._id, size: "L", color: "black", price: 800000, stock: 1 });
  const paid = await Order.create({ idUser: owner._id, status: "DONE", paymentStatus: "PAID", total: 200000, subtotal: 170000, shippingFee: 30000 });
  await OrderItem.create([{ idOrder: paid._id, idProductVariant: sameProductVariant._id, quantity: 1, price: 50000 },
    { idOrder: paid._id, idProductVariant: otherVariant._id, quantity: 4, price: 30000 }]);
  const cancelled = await Order.create({ idUser: owner._id, status: "CANCEL", paymentStatus: "PAID", total: 900000 });
  await OrderItem.create({ idOrder: cancelled._id, idProductVariant: variant._id, quantity: 100, price: 1 });
  const top = (await request("GET", "/admin/top-products", { user: admin })).body;
  assert.equal(top.length, 2);
  assert.equal(top[0]._id, secondProduct.id); assert.equal(top[0].totalSold, 4); assert.equal(top[0].revenue, 120000);
  assert.equal(top[1]._id, product.id); assert.equal(top[1].totalSold, 3); assert.equal(top[1].revenue, 250000);
  assert.equal(top[0].nameProduct, "Other Shirt");
});

function connect(t, token) {
  const socket = client(base, { auth: { token }, transports: ["websocket"], reconnection: false });
  t.after(() => socket.disconnect());
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket)); socket.once("connect_error", reject);
  });
}
test("M04: password reset revokes old HTTP, new socket handshakes, existing sends and recipient delivery", async t => {
  const login = () => request("POST", "/auth/login", { user: null, body: { email: owner.email, password } });
  const first = await login(); assert.equal(first.status, 200);
  const tokenA = first.body.token;
  assert.equal(jwt.decode(tokenA).authVersion, 0);
  const conversation = await Conversation.create({});
  await Member.create({ idConversation: conversation._id, idUser: owner._id, roleInConversation: "USER" });
  const sender = await connect(t, tokenA), recipient = await connect(t, tokenA);
  for (const socket of [sender, recipient]) assert.equal((await socket.timeout(3000).emitWithAck("joinConversation", conversation.id)).ok, true);
  let leaked = false; recipient.on("newMessage", () => { leaked = true; });
  const updated = await request("PUT", "/users/" + owner.id, { user: admin, body: { password: "Replacement123!" } });
  assert.equal(updated.status, 200); assert.equal(updated.body.authVersion, 1);
  assert.equal((await request("GET", "/auth/me", { token: tokenA })).status, 401);
  await assert.rejects(connect(t, tokenA));
  const sent = await sender.timeout(3000).emitWithAck("sendMessage", { conversationId: conversation.id, content: "Must not persist", clientMessageId: randomUUID() });
  assert.equal(sent.status, 401); assert.equal(await Message.countDocuments(), 0);
  const disconnected = new Promise(resolve => recipient.once("disconnect", resolve));
  assert.equal((await request("POST", "/chat/message", { user: admin, body: { conversationId: conversation.id,
    content: "New private message", clientMessageId: randomUUID() } })).status, 200);
  await disconnected; assert.equal(leaked, false);
  assert.equal((await login()).status, 400);
  const next = await request("POST", "/auth/login", { user: null, body: { email: owner.email, password: "Replacement123!" } });
  assert.equal(next.status, 200); assert.equal(jwt.decode(next.body.token).authVersion, 1);
  assert.equal((await request("GET", "/auth/me", { token: next.body.token })).status, 200);
  const current = await connect(t, next.body.token);
  assert.equal((await current.timeout(3000).emitWithAck("joinConversation", conversation.id)).ok, true);
});
test("M04: legacy users can log in, versionless tokens cannot, metadata edits do not revoke sessions", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $unset: { authVersion: "" } });
  const result = await request("POST", "/auth/login", { user: null, body: { email: owner.email, password } });
  assert.equal(result.status, 200); assert.equal(jwt.decode(result.body.token).authVersion, 0);
  const oldToken = jwt.sign({ userId: owner.id }, process.env.JWT_SECRET);
  assert.equal((await request("GET", "/auth/me", { token: oldToken })).status, 401);
  assert.equal((await request("PUT", "/users/" + owner.id, { user: admin, body: { name: "Updated" } })).status, 200);
  assert.equal((await request("GET", "/auth/me", { token: result.body.token })).status, 200);
  assert.equal((await request("PUT", "/users/" + owner.id, { user: admin, body: { password: "NewPassword123!" } })).status, 200);
  assert.equal((await request("GET", "/auth/me", { token: result.body.token })).status, 401);
});
