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
const Product = require("../src/models/Product");
const Variant = require("../src/models/ProductVariant");
const Category = require("../src/models/Category");
const Cart = require("../src/models/Cart");
const CartItem = require("../src/models/CartItem");
const Order = require("../src/models/Order");
const OrderItem = require("../src/models/OrderItem");
const Review = require("../src/models/Review");
const ensureCatalogReady = require("../src/utils/catalogReady");
const ensureCheckoutReady = require("../src/utils/checkoutReady");

// No dotenv/server, uploads, production DB, external provider or scheduler.
process.env.JWT_SECRET = "catalog-test-only";
let mongo, server, base, owner, other, admin, product, variant, category;
const address = { receiverName: "Customer", phone: "0901234567", addressLine: "1 Test Street",
  ward: "Ward", district: "District", city: "City" };
const id = () => new mongoose.Types.ObjectId();
async function request(method, route, user = owner, body) {
  const res = await fetch(base + route, { method, headers: { "Content-Type": "application/json",
    ...(user ? { Authorization: "Bearer " + jwt.sign({ userId: user.id, authVersion: user.authVersion ?? 0 }, process.env.JWT_SECRET) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}
const add = (quantity = 1, target = variant) => request("POST", "/cart/add", owner, { idProductVariant: target.id, quantity });
async function intent() {
  const result = await request("GET", "/cart");
  assert.ok(result.body.checkout.snapshot, JSON.stringify(result.body));
  return { ...address, cartId: result.body.cart._id, cartSnapshot: result.body.checkout.snapshot,
    idempotencyKey: randomUUID(), shippingMethod: "COD" };
}
const archiveProduct = () => request("DELETE", "/products/" + product.id, admin);
const archiveVariant = () => request("DELETE", "/variants/" + variant.id, admin);
async function reviewable(status = "DONE", user = owner) {
  const order = await Order.create({ idUser: user._id, status, shippingMethod: "COD", total: 100000 });
  const item = await OrderItem.create({ idOrder: order._id, idProductVariant: variant._id, quantity: 1, price: 100000 });
  return { order, item };
}
const review = (item, user = owner, changes = {}) => request("POST", "/reviews", user, {
  idOrderItem: item.id, rating: 5, comment: "Purchased", ...changes
});

before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.24", downloadDir: path.join(__dirname, "../.cache/mongodb") },
    replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  await mongoose.connect(mongo.getUri(), { dbName: "catalog_integrity" });
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  await ensureCatalogReady();
  await ensureCheckoutReady();
  const app = express();
  app.use(express.json());
  for (const [prefix, route] of [["products", "product.route"], ["variants", "productVariant.route"],
    ["cart", "cart.route"], ["orders", "order.route"], ["reviews", "review.route"]]) {
    app.use("/" + prefix, require("../src/routes/" + route));
  }
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
}, { timeout: 180000 });
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})));
  [owner, other, admin] = await User.create([{ email: "owner@test.invalid", password: "unused" },
    { email: "other@test.invalid", password: "unused" }, { email: "admin@test.invalid", password: "unused", role: "ADMIN" }]);
  category = await Category.create({ nameCategory: "Shirts" });
  product = await Product.create({ nameProduct: "Original shirt", slug: "original-shirt", idCategory: category._id,
    images: ["https://images.test/original.jpg"], selectedTags: ["ORIGINAL"] });
  variant = await Variant.create({ idProduct: product._id, size: "M", color: " Black ", stock: 100, price: 100000 });
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("the three required unique indexes are actually present in MongoDB", async () => {
  for (const [model, name, key] of [[CartItem, "cart_variant_unique", { idCart: 1, idProductVariant: 1 }],
    [Variant, "variant_combination_unique", { idProduct: 1, size: 1, color: 1 }], [Review, "review_order_item_unique", { idOrderItem: 1 }]]) {
    const index = (await model.collection.indexes()).find(index => index.name === name);
    assert.equal(index.unique, true);
    assert.deepEqual(index.key, key);
  }
});

test("checkout snapshots purchase facts; rename, variant edit and archive preserve both histories", async () => {
  assert.equal((await add(2)).status, 200);
  const created = await request("POST", "/orders", owner, await intent());
  assert.equal(created.status, 201);
  const line = await OrderItem.findOne({ idOrder: created.body.order._id }).lean();
  assert.deepEqual(line.productSnapshot, { nameProduct: "Original shirt", size: "M", color: "black", image: "https://images.test/original.jpg" });
  assert.equal((await request("PATCH", "/products/" + product.id, admin, { nameProduct: "New shirt" })).status, 200);
  assert.equal((await request("PATCH", "/variants/" + variant.id, admin, { size: "XL", color: "WHITE", price: 900000 })).status, 200);
  assert.equal((await archiveProduct()).status, 200);
  for (const [route, user] of [["/orders/my", owner], ["/orders", admin]]) {
    const result = await request("GET", route, user);
    assert.equal(result.status, 200);
    const saved = result.body[0].items[0];
    assert.deepEqual(saved.productSnapshot, line.productSnapshot);
    assert.equal(saved.price, 100000);
    assert.equal(saved.quantity, 2);
    assert.equal(saved.idProductVariant.size, "XL");
  }
  assert.deepEqual((await Product.findById(product.id)).images, ["https://images.test/original.jpg"]);
  assert.equal((await Variant.findById(variant.id)).stock, 98);
  assert.equal((await request("PUT", "/orders/" + created.body.order._id + "/cancel")).status, 200);
  assert.equal((await Variant.findById(variant.id)).stock, 100, "archived variant still receives cancellation restoration");
});

test("public list/search/category/detail/filters hide archives; admin reads remain authorized", async () => {
  assert.equal((await archiveProduct()).status, 200);
  assert.equal((await request("GET", "/products?search=Original", null)).body.total, 0);
  assert.deepEqual((await request("GET", "/products/category/" + category.id, null)).body, []);
  for (const param of [product.id, product.slug]) assert.equal((await request("GET", "/products/" + param, null)).status, 404);
  assert.deepEqual((await request("GET", "/products/filters", null)).body, { sizes: [], colors: [], categories: [] });
  assert.equal((await request("GET", "/products?catalogAdmin=true&includeArchived=true", null)).body.total, 0);
  for (const route of ["/products/admin", "/products/admin/" + product.id]) {
    assert.equal((await request("GET", route, owner)).status, 403);
    assert.ok((await request("GET", route, null)).status >= 400);
    assert.equal((await request("GET", route, admin)).status, 200);
  }
  const detail = (await request("GET", "/products/admin/" + product.id, admin)).body;
  assert.ok(detail.product.archivedAt);
  assert.ok(detail.variants[0].archivedAt);
  assert.equal((await archiveProduct()).status, 200);
  assert.equal((await Product.findById(product.id)).archivedAt.toISOString(), detail.product.archivedAt);
});

test("archived variants are excluded from public prices, stock and filters", async () => {
  await Variant.create({ idProduct: product._id, size: "L", color: "white", price: 200000, stock: 4 });
  await archiveVariant();
  const listing = (await request("GET", "/products", null)).body.products[0];
  assert.equal(listing.minPrice, 200000);
  assert.equal(listing.totalStock, 4);
  assert.equal(listing.variants.length, 1);
  assert.equal((await request("GET", "/products?size=m", null)).body.total, 0);
  assert.equal((await request("GET", "/products?size= l &color= WHITE ", null)).body.total, 1);
  assert.deepEqual((await request("GET", "/products/filters", null)).body.sizes, ["L"]);
  assert.equal((await request("GET", "/products/" + product.id, null)).body.variants.length, 1);
});

for (const target of ["variant", "product", "missing variant", "missing product", "invalid stock"]) {
  test("stale cart reports and rejects " + target + " without losing other rows", async () => {
    const added = await add();
    const input = await intent();
    const anotherProduct = await Product.create({ nameProduct: "Another shirt", slug: "another" });
    const another = await Variant.create({ idProduct: anotherProduct._id, size: "L", price: 200000, stock: 5 });
    const live = await add(1, another);
    if (target === "variant") await archiveVariant();
    if (target === "product") await archiveProduct();
    if (target === "missing variant") await Variant.collection.deleteOne({ _id: variant._id });
    if (target === "missing product") await Product.collection.deleteOne({ _id: product._id });
    if (target === "invalid stock") await Variant.collection.updateOne({ _id: variant._id }, { $set: { stock: -1 } });
    const cart = (await request("GET", "/cart")).body;
    assert.equal(cart.items.length, 2);
    assert.equal(cart.items.find(item => item._id === added.body._id).availability.available, false);
    assert.equal(cart.items.find(item => item._id === live.body._id).availability.available, true);
    assert.equal(cart.checkout.issues[0].itemId, added.body._id);
    assert.equal(cart.checkout.snapshot, undefined);
    const checkout = await request("POST", "/orders", owner, input);
    assert.ok([400, 404, 409].includes(checkout.status));
    assert.equal(checkout.body.itemId, added.body._id);
    assert.equal(await Order.countDocuments(), 0);
    assert.equal(await OrderItem.countDocuments(), 0);
    assert.ok((await add()).status >= 400);
    assert.equal((await request("DELETE", "/cart/remove/" + added.body._id)).status, 200);
    assert.ok(await CartItem.findById(live.body._id));
    assert.ok((await request("GET", "/cart")).body.checkout.snapshot);
  });
}

test("parent archive alone is authoritative for legacy active children", async () => {
  await add();
  const input = await intent();
  await Product.collection.updateOne({ _id: product._id }, { $set: { archivedAt: new Date() } });
  assert.equal((await add()).body.code, "PRODUCT_ARCHIVED");
  assert.equal((await request("POST", "/orders", owner, input)).body.code, "PRODUCT_ARCHIVED");
});

test("parallel first cart additions create one cart, one row and the exact sum", async () => {
  const amounts = [1, 2, 3, 4, 5, 6];
  const results = await Promise.all(amounts.map(amount => add(amount)));
  assert.ok(results.every(result => result.status === 200), JSON.stringify(results));
  assert.equal(await Cart.countDocuments({ idUser: owner._id }), 1);
  assert.equal(await CartItem.countDocuments(), 1);
  assert.equal((await CartItem.findOne()).quantity, 21);
  assert.equal((await Variant.findById(variant.id)).stock, 100);
});

test("database rejects concurrent duplicate cart inserts with E11000", async () => {
  const cart = await Cart.create({ idUser: owner._id });
  const results = await Promise.allSettled([1, 2].map(quantity => CartItem.create({ idCart: cart._id, idProductVariant: variant._id, quantity })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, 11000);
  assert.equal(await CartItem.countDocuments(), 1);
});

test("normalized parallel variant creates get one winner and a controlled duplicate response", async () => {
  const results = await Promise.all([" L ", "l", "Ｌ"].map(size => request("POST", "/variants", admin,
    { idProduct: product.id, size, color: "  Dark  BLUE ", price: 50000, stock: 10 })));
  assert.equal(results.filter(result => result.status === 201).length, 1, JSON.stringify(results));
  assert.ok(results.filter(result => result.status !== 201).every(result => result.status === 409));
  assert.equal(await Variant.countDocuments({ idProduct: product._id, size: "L", color: "dark blue" }), 1);
  const races = await Promise.allSettled([" XL ", "xl"].map(size => Variant.create({ idProduct: product._id, size, color: " green ", price: 1, stock: 1 })));
  assert.equal(races.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(races.find(result => result.status === "rejected").reason.code, 11000);
});

test("variant updates validate integers, ignore protected fields and reject collisions including archives", async () => {
  const another = await Variant.create({ idProduct: product._id, size: "L", color: "black", price: 10, stock: 3 });
  for (const changes of [{ stock: -1 }, { stock: 1.5 }, { price: -1 }, { price: 1.5 }]) {
    assert.equal((await request("PATCH", "/variants/" + variant.id, admin, changes)).status, 400);
  }
  assert.equal((await request("PATCH", "/variants/" + another.id, admin, { size: " m ", color: "BLACK" })).status, 409);
  await archiveVariant();
  assert.equal((await request("POST", "/variants", admin, { idProduct: product.id, size: "m", color: "black", price: 1, stock: 1 })).status, 409);
  assert.equal((await request("PATCH", "/variants/" + variant.id, admin,
    { price: 70000, idProduct: id(), archivedAt: null, catalogRevision: 999, inventoryVersion: 999, $set: { stock: -4 } })).status, 200);
  const saved = await Variant.findById(variant.id);
  assert.equal(saved.stock, 100);
  assert.equal(saved.price, 70000);
  assert.equal(saved.inventoryVersion, 0);
  assert.equal(String(saved.idProduct), product.id);
  assert.ok(saved.archivedAt);
  assert.notEqual(saved.catalogRevision, 999);
});

test("product partial updates preserve tags and cannot unarchive or replace protected identity", async () => {
  await archiveProduct();
  const result = await request("PATCH", "/products/" + product.id, admin, {
    nameProduct: "Changed name", archivedAt: null, catalogRevision: 999, slug: "injected", $set: { archivedAt: null }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.nameProduct, "Changed name");
  assert.ok(result.body.archivedAt);
  assert.equal(result.body.slug, "changed-name");
  assert.deepEqual(result.body.selectedTags, ["ORIGINAL"]);
  for (const changes of [{ selectedTags: '{}' }, { customTags: '[1]' }, { nameProduct: "  " }, { idCategory: id() }]) {
    assert.equal((await request("PATCH", "/products/" + product.id, admin, changes)).status, 400);
  }
  assert.equal((await request("POST", "/variants", admin, { idProduct: product.id, size: "L", stock: 1, price: 1 })).status, 409);
});

test("review before DONE, foreign/missing orders and invalid ratings return without creating", async () => {
  for (const status of ["PENDING", "CONFIRMED", "SHIPPING", "CANCEL"]) {
    assert.equal((await review((await reviewable(status)).item)).status, 400);
  }
  const foreign = await reviewable("DONE", other);
  assert.equal((await review(foreign.item)).status, 403);
  assert.equal((await review({ id: String(id()) })).status, 404);
  const orphan = await OrderItem.create({ idOrder: id(), idProductVariant: variant._id });
  assert.equal((await review(orphan)).status, 404);
  const valid = await reviewable();
  for (const rating of [0, 6, 1.5, "bad", null]) assert.equal((await review(valid.item, owner, { rating })).status, 400);
  assert.equal((await request("POST", "/reviews", owner, { idOrderItem: valid.item.id })).status, 400);
  assert.equal(await Review.countDocuments(), 0);
});

test("parallel reviews use the database uniqueness rule; a valid archived purchase stays reviewable", async () => {
  const { item } = await reviewable();
  await archiveProduct();
  const results = await Promise.all([review(item), review(item), review(item)]);
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.ok(results.filter(result => result.status !== 201).every(result => result.status === 409 && result.body.code === "REVIEW_EXISTS"));
  assert.equal(await Review.countDocuments(), 1);
  assert.equal((await review(item)).status, 409);
  const saved = await Review.findOne();
  assert.equal((await request("PATCH", "/reviews/" + saved.id, owner, { rating: 2.5 })).status, 400);
  assert.equal((await request("PATCH", "/reviews/" + saved.id, owner, { rating: 3, idUser: other.id, status: "HIDDEN" })).status, 200);
  assert.equal((await Review.findById(saved.id)).status, "VISIBLE");
  assert.equal((await Review.findById(saved.id)).rating, 3);
});

test("legacy missing archive/snapshot fields and dangling references can be read and removed", async () => {
  await Product.collection.updateOne({ _id: product._id }, { $unset: { archivedAt: "", catalogRevision: "" } });
  await Variant.collection.updateOne({ _id: variant._id }, { $unset: { archivedAt: "", catalogRevision: "" } });
  assert.equal((await request("GET", "/products/" + product.id, null)).status, 200);
  assert.equal((await add()).status, 200);
  const legacy = await reviewable();
  assert.equal((await request("GET", "/orders/my")).body[0].items[0].productSnapshot, undefined);
  await Variant.collection.deleteOne({ _id: variant._id });
  assert.equal((await request("GET", "/orders/my")).body[0].items[0].idProductVariant, null);
  assert.equal((await review(legacy.item)).status, 409);
  const item = (await request("GET", "/cart")).body.items[0];
  assert.equal(item.availability.code, "VARIANT_NOT_FOUND");
  assert.equal((await request("DELETE", "/cart/remove/" + item._id)).status, 200);
});

for (const target of ["product", "variant"]) {
  test(target + " archive committed during checkout forces retry/rejection with no partial order", async t => {
    await add();
    const input = await intent();
    let enter, release, paused = false;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const original = Order.create;
    t.mock.method(Order, "create", async function (...args) {
      if (!paused) { paused = true; enter(); await gate; }
      return original.apply(this, args);
    });
    t.after(release);
    const pending = request("POST", "/orders", owner, input);
    await entered;
    assert.equal((await (target === "product" ? archiveProduct() : archiveVariant())).status, 200);
    release();
    const result = await pending;
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "VARIANT_ARCHIVED");
    assert.equal(await Order.countDocuments(), 0);
    assert.equal(await OrderItem.countDocuments(), 0);
    assert.equal((await Variant.findById(variant.id)).stock, 100);
    assert.equal(await CartItem.countDocuments(), 1);
  });
}

test("parent archive rolls back as a unit if variant archival fails", async t => {
  t.mock.method(Variant, "updateMany", async () => { throw new Error("Injected failure"); });
  assert.equal((await archiveProduct()).status, 500);
  assert.equal((await Product.findById(product.id)).archivedAt, undefined);
  assert.equal((await Variant.findById(variant.id)).archivedAt, undefined);
});

function pauseWrite(t, model, method) {
  let enter, release, paused = false;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = model[method];
  t.mock.method(model, method, function (...args) {
    const query = original.apply(this, args);
    const exec = query.exec;
    query.exec = async function (...params) {
      if (!paused) { paused = true; enter(); await gate; }
      return exec.apply(this, params);
    };
    return query;
  });
  t.after(release);
  return { entered, release };
}

test("add-to-cart loses an archive race after reading availability and writes no item", async t => {
  const gate = pauseWrite(t, Variant, "updateOne");
  const pending = add();
  await gate.entered;
  assert.equal((await archiveProduct()).status, 200);
  gate.release();
  assert.equal((await pending).body.code, "VARIANT_ARCHIVED");
  assert.equal(await CartItem.countDocuments(), 0);
});

test("archival retries its stale snapshot and includes a variant concurrently created under that parent", async t => {
  const gate = pauseWrite(t, Product, "updateOne");
  const pending = archiveProduct();
  await gate.entered;
  const created = await request("POST", "/variants", admin, { idProduct: product.id, size: "L", color: "red", price: 1, stock: 1 });
  assert.equal(created.status, 201);
  gate.release();
  assert.equal((await pending).status, 200);
  assert.ok((await Variant.findById(created.body._id)).archivedAt);
  assert.ok((await Variant.findById(variant.id)).archivedAt);
  assert.equal(await Variant.countDocuments({ idProduct: product._id, archivedAt: null }), 0);
});

test("unique index creation fails on legacy duplicates until cleanup (real database)", async () => {
  await Review.collection.dropIndex("review_order_item_unique");
  const idOrderItem = id();
  try {
    await Review.collection.insertMany([{ idOrderItem, rating: 4 }, { idOrderItem, rating: 5 }]);
    await assert.rejects(Review.createIndexes(), { code: 11000 });
  } finally {
    await Review.deleteMany({ idOrderItem });
    await Review.createIndexes();
  }
  assert.ok((await Review.collection.indexes()).find(index => index.name === "review_order_item_unique" && index.unique));
});
