const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");
const User = require("../src/models/User");
const Cart = require("../src/models/Cart");
const CartItem = require("../src/models/CartItem");
const Product = require("../src/models/Product");
const Variant = require("../src/models/ProductVariant");
const Address = require("../src/models/UserAddress");
const Order = require("../src/models/Order");
const OrderItem = require("../src/models/OrderItem");
const ensureCheckoutReady = require("../src/utils/checkoutReady");

process.env.JWT_SECRET = "checkout-regression-only";
let mongo, server, base, a, b, product, variant, itemA, itemB, cartA, cartB, addressA, addressB;
const addressData = { receiverName: "Test Customer", phone: "0901234567", addressLine: "1 Test Street",
  ward: "Ward", district: "District", city: "City" };
async function request(method, route, user, body) {
  const response = await fetch(base + route, { method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt.sign({ userId: user.id, authVersion: user.authVersion ?? 0 }, process.env.JWT_SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function intent(user = a, changes = {}) {
  const { body } = await request("GET", "/cart", user);
  return { cartId: body.cart._id, cartSnapshot: body.checkout.snapshot,
    idempotencyKey: randomUUID(), shippingMethod: "COD", ...addressData, ...changes };
}
const post = (input, user = a) => request("POST", "/orders", user, input);
async function unchanged(stock = 5) {
  assert.equal(await Order.countDocuments(), 0);
  assert.equal(await OrderItem.countDocuments(), 0);
  assert.equal((await Variant.findById(variant.id)).stock, stock);
  assert.ok(await CartItem.findById(itemA.id));
}

// Deterministic scheduling of real transactions, not sleeps or mocked database state.
function pauseOrderInsert(t, arrivals = 1) {
  let count = 0, enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = Order.create;
  t.mock.method(Order, "create", async function (...args) {
    if (count++ < arrivals) {
      if (count === arrivals) enter();
      await gate;
    }
    return original.apply(this, args);
  });
  t.after(release);
  return { entered, release };
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.24",
    downloadDir: path.join(__dirname, "../.cache/mongodb") },
    replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  await mongoose.connect(mongo.getUri(), { dbName: "checkout_regression" });
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  await ensureCheckoutReady();
  const app = express();
  app.use(express.json());
  app.use("/cart", require("../src/routes/cart.route"));
  app.use("/orders", require("../src/routes/order.route"));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
}, { timeout: 180000 });

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})));
  [a, b] = await User.create([
    { email: "a@test.invalid", password: "unused" }, { email: "b@test.invalid", password: "unused" }
  ]);
  product = await Product.create({ nameProduct: "Shirt", slug: "shirt" });
  variant = await Variant.create({ idProduct: product._id, size: "M", color: "Black", price: 100000, stock: 5 });
  [cartA, cartB] = await Cart.create([{ idUser: a._id }, { idUser: b._id }]);
  [itemA, itemB] = await CartItem.create([
    { idCart: cartA._id, idProductVariant: variant._id, quantity: 2 },
    { idCart: cartB._id, idProductVariant: variant._id, quantity: 1 }
  ]);
  [addressA, addressB] = await Address.create([
    { ...addressData, idUser: a._id }, { ...addressData, idUser: b._id }
  ]);
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("checkout commits order, line items, conditional stock and only the owner's cart", async () => {
  const input = await intent(a, { addressId: addressA.id, receiverName: "Ignored override" });
  const result = await post(input);
  assert.equal(result.status, 201);
  assert.equal(result.body.order.receiverName, addressData.receiverName);
  assert.equal(result.body.order.subtotal, 200000);
  assert.equal(result.body.order.shippingFee, 30000);
  assert.equal(result.body.order.total, 230000);
  const lines = await OrderItem.find({ idOrder: result.body.order._id });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 2);
  assert.equal(lines[0].price, 100000);
  assert.equal((await Variant.findById(variant.id)).stock, 3);
  assert.equal(await CartItem.countDocuments({ idCart: cartA._id }), 0);
  assert.ok(await CartItem.findById(itemB.id));
});

test("client money and quantity cannot override the backend quote", async () => {
  const result = await post(await intent(a, { shippingFee: 0, price: 1, total: 1, subtotal: 1, quantity: 999 }));
  assert.equal(result.status, 201);
  assert.equal(result.body.order.total, 230000);
  assert.equal((await OrderItem.findOne()).quantity, 2);
});

for (const phase of ["line insert", "cart consumption"]) {
  test("failure during " + phase + " rolls back every write and hides DB details", async t => {
    const input = await intent();
    const model = phase === "line insert" ? OrderItem : CartItem;
    const method = phase === "line insert" ? "create" : "deleteMany";
    const original = model[method];
    t.mock.method(model, method, async function (...args) {
      await original.apply(this, args);
      throw new Error("secret database host / injected failure");
    });
    const result = await post(input);
    assert.equal(result.status, 500);
    assert.doesNotMatch(JSON.stringify(result.body), /secret|database host/);
    await unchanged();
    t.mock.restoreAll();
    assert.equal((await post(input)).status, 201, "same key succeeds after rollback");
  });
}

test("two users buying the final unit: exactly one succeeds and stock never goes negative", async t => {
  await Variant.updateOne({ _id: variant._id }, { stock: 1 });
  await CartItem.updateOne({ _id: itemA._id }, { quantity: 1 });
  const [first, second] = await Promise.all([intent(a), intent(b)]);
  const gate = pauseOrderInsert(t, 2);
  const pending = Promise.all([post(first, a), post(second, b)]);
  await gate.entered;
  gate.release();
  const results = await pending;
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal((await Variant.findById(variant.id)).stock, 0);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await OrderItem.countDocuments(), 1);
  assert.equal(await CartItem.countDocuments(), 1);
});

test("concurrent successful checkouts decrement the combined quantity without lost updates", async t => {
  const [first, second] = await Promise.all([intent(a), intent(b)]);
  const gate = pauseOrderInsert(t, 2);
  const pending = Promise.all([post(first, a), post(second, b)]);
  await gate.entered;
  gate.release();
  assert.deepEqual((await pending).map(r => r.status), [201, 201]);
  assert.equal((await Variant.findById(variant.id)).stock, 2);
  assert.equal(await Order.countDocuments(), 2);
});

test("same key replays one order, even after a new cart item is added", async () => {
  const input = await intent();
  const first = await post(input);
  const added = await request("POST", "/cart/add", a, { idProductVariant: variant.id, quantity: 1 });
  const second = await post(input);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(first.body.order._id, second.body.order._id);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await Variant.findById(variant.id)).stock, 3);
  assert.ok(await CartItem.findById(added.body._id));
  const changed = await intent(a, { idempotencyKey: input.idempotencyKey });
  assert.equal((await post(changed)).status, 409, "old key cannot consume a newer snapshot");
  assert.ok(await CartItem.findById(added.body._id));
});

test("two same-key transactions racing both return the same committed order", async t => {
  const input = await intent();
  const gate = pauseOrderInsert(t, 2);
  const pending = Promise.all([post(input), post(input)]);
  await gate.entered;
  gate.release();
  const [first, second] = await pending;
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(first.body.order._id, second.body.order._id);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await OrderItem.countDocuments(), 1);
  assert.equal((await Variant.findById(variant.id)).stock, 3);
  assert.equal(await CartItem.countDocuments({ idCart: cartA._id }), 0);
});

test("database unique key constraint works, ignores legacy orders and is scoped to user", async () => {
  const input = await intent();
  assert.equal((await post(input)).status, 201);
  await assert.rejects(Order.collection.insertOne({ idUser: a._id, idempotencyKey: input.idempotencyKey }), { code: 11000 });
  await Order.create([{ idUser: a._id }, { idUser: a._id }]);
  assert.equal((await post(await intent(b, { idempotencyKey: input.idempotencyKey }), b)).status, 201);
});

test("same key with a different checkout intent races to one winner, not a mismatched replay", async t => {
  const input = await intent();
  const gate = pauseOrderInsert(t, 2);
  const pending = Promise.all([post(input), post({ ...input, receiverName: "Different customer" })]);
  await gate.entered;
  gate.release();
  const results = await pending;
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(results.find(r => r.status === 409).body.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await Variant.findById(variant.id)).stock, 3);
});

test("saved address ID alone is resolved from the authenticated user's address book", async () => {
  const input = await intent(a, { addressId: addressA.id });
  for (const field of Object.keys(addressData)) delete input[field];
  const result = await post(input);
  assert.equal(result.status, 201);
  assert.equal(result.body.order.addressLine, addressData.addressLine);
});

test("different keys cannot checkout the same cart twice", async t => {
  const first = await intent();
  const gate = pauseOrderInsert(t, 2);
  const pending = Promise.all([post(first), post({ ...first, idempotencyKey: randomUUID() })]);
  await gate.entered;
  gate.release();
  const results = await pending;
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await Variant.findById(variant.id)).stock, 3);
});

test("new item inserted after the transaction snapshot is not consumed", async t => {
  const input = await intent();
  const gate = pauseOrderInsert(t);
  const pending = post(input);
  await gate.entered;
  const other = await Variant.create({ idProduct: product._id, size: "L", price: 120000, stock: 5 });
  const added = await request("POST", "/cart/add", a, { idProductVariant: other.id, quantity: 1 });
  assert.equal(added.status, 200);
  gate.release();
  assert.equal((await pending).status, 201);
  assert.ok(await CartItem.findById(added.body._id));
  assert.equal(await CartItem.findById(itemA.id), null);
  assert.equal((await Variant.findById(other.id)).stock, 5);
});

test("editing a selected item during checkout rolls back; the edited quantity survives", async t => {
  const input = await intent();
  const gate = pauseOrderInsert(t);
  const pending = post(input);
  await gate.entered;
  assert.equal((await request("PUT", "/cart/update", a, { idItem: itemA.id, quantity: 3 })).status, 200);
  gate.release();
  assert.equal((await pending).status, 409);
  await unchanged();
  assert.equal((await CartItem.findById(itemA.id)).quantity, 3);
});

test("snapshot rejects quantity ABA and price changes before checkout", async () => {
  const input = await intent();
  for (const quantity of [3, 2]) await request("PUT", "/cart/update", a, { idItem: itemA.id, quantity });
  assert.equal((await post(input)).status, 409);
  const newInput = await intent();
  await Variant.updateOne({ _id: variant._id }, { price: 200000 });
  assert.equal((await post(newInput)).status, 409);
  await unchanged();
});

test("cart add uses atomic increments during concurrent requests", async () => {
  const results = await Promise.all([1, 2, 3].map(() => request("POST", "/cart/add", a,
    { idProductVariant: variant.id, quantity: 1 })));
  assert.ok(results.every(r => r.status === 200));
  assert.equal((await CartItem.findById(itemA.id)).quantity, 5);
});

test("foreign cart/address and missing cart are rejected before writes", async () => {
  const input = await intent();
  for (const cartId of [cartB.id, new mongoose.Types.ObjectId().toString()])
    assert.equal((await post({ ...input, cartId })).status, 404);
  assert.equal((await post({ ...input, addressId: addressB.id })).status, 404);
  await unchanged();
});

test("invalid key, snapshot, method or address is a validation error", async () => {
  const input = await intent();
  for (const changes of [{ idempotencyKey: "" }, { cartSnapshot: "bad" }, { shippingMethod: "MOMO" },
    { receiverName: "" }, { addressId: { $ne: null } }, { cartId: "bad" }]) {
    assert.equal((await post({ ...input, ...changes })).status, 400);
  }
  await unchanged();
});

test("missing variant/product, empty cart and invalid quantity/price are rejected", async () => {
  const input = await intent();
  for (const quantity of [0, -1, 1.5]) {
    await CartItem.updateOne({ _id: itemA._id }, { quantity });
    assert.equal((await post(input)).status, 400);
  }
  await CartItem.updateOne({ _id: itemA._id }, { quantity: 2 });
  await Variant.updateOne({ _id: variant._id }, { price: -1 });
  assert.equal((await post(input)).status, 400);
  await Variant.updateOne({ _id: variant._id }, { price: 100000 });
  const current = await intent();
  await Product.deleteOne({ _id: product._id });
  assert.equal((await post(current)).status, 404);
  await Variant.deleteOne({ _id: variant._id });
  assert.equal((await post(current)).status, 404);
  await CartItem.deleteMany({ idCart: cartA._id });
  assert.equal((await post(current)).status, 400);
  assert.equal(await Order.countDocuments(), 0);
});

test("duplicate cart rows are rejected and merged quantities cannot bypass stock checks", async () => {
  const input = await intent();
  await assert.rejects(CartItem.create({ idCart: cartA._id, idProductVariant: variant._id, quantity: 2 }), { code: 11000 });
  await request("POST", "/cart/add", a, { idProductVariant: variant.id, quantity: 2 });
  const merged = await intent();
  await Variant.updateOne({ _id: variant._id }, { stock: 3 });
  assert.equal((await post(input)).status, 409);
  assert.equal((await post(merged)).status, 409);
  await unchanged(3);
  assert.equal(await CartItem.countDocuments({ idCart: cartA._id }), 1);
  assert.equal((await CartItem.findById(itemA.id)).quantity, 4);
});
