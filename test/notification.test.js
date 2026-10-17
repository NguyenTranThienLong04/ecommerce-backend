const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { io: client } = require("socket.io-client");
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");
const { start } = require("../server");
const Notification = require("../src/models/Notification");
const User = require("../src/models/User");
const Order = require("../src/models/Order");
const OrderItem = require("../src/models/OrderItem");
const Product = require("../src/models/Product");
const Variant = require("../src/models/ProductVariant");
const Cart = require("../src/models/Cart");
const CartItem = require("../src/models/CartItem");
const Conversation = require("../src/models/Conversation");
const Member = require("../src/models/ConversationUser");
const Attempt = require("../src/models/PaymentAttempt");
const checkout = require("../src/services/checkout.service");
const transition = require("../src/services/orderTransition.service");
const payment = require("../src/services/payment.service");
const send = require("../src/services/message.service");
const notifications = require("../src/services/notification.service");
const { checkoutQuote } = require("../src/utils/checkoutQuote");
const vnpay = require("../src/utils/vnpay");
let mongo, runtime, url, owner, other, admin, admin2, variant, cart, input;
const env = { NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", JWT_SECRET: "notification-tests-only-not-production",
  FRONTEND_URL: "http://localhost:3000", VNPAY_ENABLED: "true", VNP_TMN_CODE: "TESTSHOP", VNP_HASH_SECRET: "notification-signature",
  VNP_URL: "https://payment.test/pay", VNP_RETURN_URL: "https://api.test/return", VNP_RESULT_URL: "https://shop.test/payment-result" };
const token = user => jwt.sign({ userId: user.id, authVersion: user.authVersion || 0, role: "ADMIN" }, env.JWT_SECRET, { expiresIn: "1h" });
async function request(method, route, user = owner, body) {
  const response = await fetch(url + "/api" + route, { method, headers: { Authorization: "Bearer " + token(user), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}
const rows = (user, type) => Notification.find({ recipientUserId: user._id, ...(type ? { type } : {}) }).lean();
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { version: "7.0.24", downloadDir: path.join(__dirname, "../.cache/mongodb") }, replSet: { count: 1, ip: "127.0.0.1" } });
  env.MONGO_URI = mongo.getUri("notifications_test"); Object.assign(process.env, env);
  runtime = await start({ env, scheduler: false }); url = "http://127.0.0.1:" + runtime.server.address().port;
});
beforeEach(async () => {
  for (const model of Object.values(mongoose.models)) await model.deleteMany({});
  [owner, other, admin, admin2] = await User.create(["owner", "other", "admin", "admin2"].map(name => ({ name, email: name + "@test.invalid", password: "unused", role: name.startsWith("admin") ? "ADMIN" : "USER" })));
  const product = await Product.create({ nameProduct: "Shirt", slug: "shirt" });
  variant = await Variant.create({ idProduct: product._id, price: 100000, stock: 20, size: "M" });
  cart = await Cart.create({ idUser: owner._id });
  await CartItem.create({ idCart: cart._id, idProductVariant: variant._id, quantity: 1 });
  const items = await CartItem.find({ idCart: cart._id }).populate({ path: "idProductVariant", populate: { path: "idProduct" } });
  input = { cartId: cart.id, cartSnapshot: checkoutQuote(cart, items).snapshot, idempotencyKey: randomUUID(), shippingMethod: "COD",
    receiverName: "Customer", phone: "0901234567", addressLine: "1 Street", ward: "Ward", district: "District", city: "City" };
});
after(async () => { await runtime?.close(); await mongo?.stop(); });
async function order(method = "COD") { return (await checkout(owner._id, { ...input, shippingMethod: method }, { paymentMethods: ["COD", "VNPAY"] })).order; }
async function attempt() {
  const row = await order("VNPAY");
  const result = await payment.createAttempt(owner._id, row.id, randomUUID(), "127.0.0.1");
  return Attempt.findOne({ reference: result.reference });
}
function signed(row, changes = {}) {
  const params = { vnp_TmnCode: "TESTSHOP", vnp_TxnRef: row.reference, vnp_Amount: String(row.expectedAmount * 100),
    vnp_OrderInfo: vnpay.orderInfo(row), vnp_BankCode: "NCB", vnp_TransactionNo: "123456", vnp_ResponseCode: "00", vnp_TransactionStatus: "00", ...changes };
  return { ...params, vnp_SecureHash: vnpay.sign(params, env.VNP_HASH_SECRET) };
}
async function socketFor(t, user) {
  const socket = client(url, { auth: { token: token(user) }, transports: ["websocket"], reconnection: false });
  t.after(() => socket.disconnect());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  socket.joinInbox = payload => new Promise((resolve, reject) => socket.timeout(3000).emit("joinNotifications", payload, (error, result) => error ? reject(error) : resolve(result)));
  assert.equal((await socket.joinInbox({ userId: admin.id, role: "ADMIN" })).ok, true);
  return socket;
}
test("new order and concurrent same-key checkout retries create exactly one notification per admin", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => checkout(owner._id, input)));
  assert.equal(new Set(results.map(result => result.order.id)).size, 1);
  for (const user of [admin, admin2]) assert.equal((await rows(user, "ORDER_CREATED")).length, 1);
  assert.equal((await rows(owner)).length, 0);
  const indexes = await Notification.collection.indexes();
  assert.ok(indexes.some(index => index.name === "notification_dedupe_unique" && index.unique));
});
test("notification is neither persisted nor emitted before real checkout commit; rollback leaves none", async t => {
  const socket = await socketFor(t, admin), events = [];
  socket.on("notification:new", item => events.push(item));
  const original = mongoose.connection.transaction.bind(mongoose.connection);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const mock = t.mock.method(mongoose.connection, "transaction", (callback, options) => original(async session => {
    const result = await callback(session); entered(); await gate; return result;
  }, options));
  t.after(release);
  const pending = order(); await reached;
  assert.equal(await Notification.countDocuments(), 0); assert.equal(events.length, 0);
  const emitted = new Promise(resolve => socket.once("notification:new", resolve));
  release(); const committed = await pending; const item = await emitted;
  assert.ok(await Order.exists({ _id: committed._id })); assert.ok(await Notification.exists({ _id: item._id }));
  mock.mock.restore();
  await CartItem.create({ idCart: cart._id, idProductVariant: variant._id, quantity: 1 });
  input.idempotencyKey = randomUUID();
  const items = await CartItem.find({ idCart: cart._id }).populate({ path: "idProductVariant", populate: { path: "idProduct" } });
  input.cartSnapshot = checkoutQuote(cart, items).snapshot;
  t.mock.method(OrderItem, "create", async () => { throw new Error("rollback"); });
  const before = await Notification.countDocuments(); await assert.rejects(order(), /rollback/);
  assert.equal(await Notification.countDocuments(), before);
});
test("customer cancel retry notifies each admin once and only the owning customer about status", async () => {
  const row = await order();
  const action = { orderId: row.id, status: "CANCEL", actor: { type: "USER", id: owner._id } };
  await Promise.all([transition(action), transition(action)]);
  assert.equal((await rows(admin, "ORDER_CANCELLED")).length, 1);
  assert.equal((await rows(owner, "ORDER_STATUS_CHANGED")).length, 1);
  assert.equal((await rows(other)).length, 0);
});
test("admin status changes and COD cash collection notify customer once per actual transition", async () => {
  const row = await order();
  for (const status of ["CONFIRMED", "SHIPPING", "DONE", "DONE"]) await transition({ orderId: row.id, status, actor: { type: "ADMIN", id: admin._id } });
  assert.equal((await rows(owner, "ORDER_STATUS_CHANGED")).length, 3);
  assert.equal((await rows(owner, "PAYMENT_PAID")).length, 1);
});
test("HTTP ownership, forged role/userId, admin scope and role demotion cannot expose another inbox", async () => {
  await order(); const [item] = await rows(admin);
  const own = await request("GET", `/notifications?recipientUserId=${admin.id}&role=ADMIN`);
  assert.equal(own.body.items.length, 0); assert.equal(own.body.unreadCount, 0);
  assert.equal((await request("GET", "/notifications?scope=admin")).status, 403);
  assert.equal((await request("PATCH", `/notifications/${item._id}/read`, other)).status, 404);
  assert.equal((await request("PATCH", `/notifications/${item._id}/read`, admin2)).status, 404);
  await request("PATCH", "/notifications/read-all", owner, { recipientUserId: admin.id });
  assert.equal((await Notification.findById(item._id)).readAt, null);
  await User.updateOne({ _id: admin._id }, { $set: { role: "USER" } });
  assert.equal((await request("GET", "/notifications", admin)).body.items.length, 0);
  assert.equal((await request("PATCH", `/notifications/${item._id}/read`, admin)).status, 404);
});
test("duplicate concurrent signed IPNs yield one paid notification and one order status notification", async () => {
  const row = await attempt(), query = signed(row);
  await Promise.all(Array.from({ length: 5 }, () => payment.processIPN(query)));
  assert.equal((await rows(owner, "PAYMENT_PAID")).length, 1);
  assert.equal((await rows(owner, "ORDER_STATUS_CHANGED")).length, 1);
  assert.equal((await rows(other)).length, 0);
});
test("IPN rollback creates no payment notification", async t => {
  const row = await attempt();
  const original = Order.findOneAndUpdate.bind(Order);
  t.mock.method(Order, "findOneAndUpdate", async (...args) => { await original(...args); throw new Error("rollback"); });
  await assert.rejects(payment.processIPN(signed(row)), /rollback/);
  assert.equal((await rows(owner)).length, 0);
  assert.equal((await Attempt.findById(row._id)).status, "PENDING");
});
test("provider REQUIRES_REVIEW and duplicate callbacks notify admin and customer once without a PAID claim", async () => {
  const row = await attempt(), query = signed(row, { vnp_ResponseCode: "07", vnp_TransactionStatus: "07" });
  await payment.processIPN(query); await payment.processIPN(query);
  for (const user of [owner, admin, admin2]) assert.equal((await rows(user, "PAYMENT_REQUIRES_REVIEW")).length, 1);
  assert.equal((await rows(owner, "PAYMENT_PAID")).length, 0);
});
test("late success after cancellation creates review for both roles, preserving order and inventory", async () => {
  const row = await attempt();
  await transition({ orderId: row.orderId, status: "CANCEL", actor: { type: "USER", id: owner._id } });
  await payment.processIPN(signed(row)); await payment.processIPN(signed(row));
  for (const user of [owner, admin]) assert.equal((await rows(user, "PAYMENT_REQUIRES_REVIEW")).length, 1);
  assert.equal((await rows(owner, "PAYMENT_PAID")).length, 0);
  assert.equal((await Order.findById(row.orderId)).status, "CANCEL");
  assert.equal((await Variant.findById(variant._id)).stock, 20);
});
test("local expiry and browser return create nothing; verified provider expiry creates one notification", async () => {
  const row = await attempt();
  await payment.paymentStatus(owner.id, row.reference, new Date(Date.now() + 3600000));
  await payment.returnLocation(signed(row));
  assert.equal((await rows(owner)).length, 0);
  const query = signed(row, { vnp_ResponseCode: "11", vnp_TransactionStatus: "02", vnp_TransactionNo: "0" });
  await payment.processIPN(query); await payment.processIPN(query);
  assert.equal((await rows(owner, "PAYMENT_EXPIRED")).length, 1);
});
test("confirmed failure and conflicting signed callback retain one failure and one review per recipient", async () => {
  const row = await attempt();
  const fail = signed(row, { vnp_ResponseCode: "24", vnp_TransactionStatus: "02", vnp_TransactionNo: "0" });
  await payment.processIPN(fail); await payment.processIPN(fail);
  await payment.processIPN(signed(row)); await payment.processIPN(signed(row));
  assert.equal((await rows(owner, "PAYMENT_FAILED")).length, 1);
  for (const user of [owner, admin]) assert.equal((await rows(user, "PAYMENT_REQUIRES_REVIEW")).length, 1);
});
test("duplicate chat retry across REST/socket and changed payload never duplicates notifications", async t => {
  const conversation = await Conversation.create({});
  await Member.create({ idConversation: conversation._id, idUser: owner._id, roleInConversation: "USER" });
  const body = { conversationId: conversation.id, clientMessageId: randomUUID(), content: "Hello", userId: other.id };
  const first = await request("POST", "/chat/message", owner, body); assert.equal(first.status, 200);
  const socket = await socketFor(t, owner);
  const result = await new Promise(resolve => socket.emit("sendMessage", body, resolve)); assert.equal(result.replayed, true);
  await Promise.all(Array.from({ length: 4 }, () => send(owner, body, runtime.io)));
  assert.equal((await rows(admin, "CHAT_MESSAGE")).length, 1);
  await assert.rejects(send(owner, { ...body, content: "changed" }), error => error.status === 409);
  await send(admin, { ...body, clientMessageId: randomUUID() }, runtime.io);
  assert.equal((await rows(owner, "CHAT_MESSAGE")).length, 1); assert.equal((await rows(other)).length, 0);
});
test("mark read/read-all are idempotent, per admin and reflected in snapshot/unread count", async () => {
  await order(); const [item] = await rows(admin);
  const first = await request("PATCH", `/notifications/${item._id}/read`, admin);
  const second = await request("PATCH", `/notifications/${item._id}/read`, admin);
  assert.equal(first.body.item.readAt, second.body.item.readAt);
  assert.equal((await request("GET", "/notifications", admin)).body.unreadCount, 0);
  assert.equal((await request("GET", "/notifications", admin2)).body.unreadCount, 1);
  assert.equal((await request("PATCH", "/notifications/read-all", admin2)).body.modifiedCount, 1);
  assert.equal((await request("PATCH", "/notifications/read-all", admin2)).body.modifiedCount, 0);
});
test("cursor pagination is newest first with stable timestamp ties and full inbox unread count", async () => {
  const at = new Date();
  await Notification.create(Array.from({ length: 7 }, (_, i) => ({ recipientUserId: owner._id, recipientRole: "USER", type: "CHAT_MESSAGE",
    title: "New", message: "Message", relatedEntityType: "CONVERSATION", relatedEntityId: "test", dedupeKey: "page:" + i, createdAt: at, readAt: i === 0 ? at : null })));
  let cursor, ids = [];
  do {
    const result = await request("GET", "/notifications?limit=2" + (cursor ? "&before=" + cursor : ""));
    assert.equal(result.status, 200); assert.equal(result.cache, "no-store"); assert.equal(result.body.unreadCount, 6);
    ids.push(...result.body.items.map(item => item._id)); cursor = result.body.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 7); assert.equal(new Set(ids).size, 7); assert.deepEqual(ids, [...ids].sort().reverse());
  for (const query of ["limit=0", "limit=51", "limit=2&limit=3", "before=bad"]) assert.equal((await request("GET", "/notifications?" + query)).status, 400);
});
test("socket derives recipient, reconnect rejoins, missed persisted events recover over HTTP", async t => {
  const socket = await socketFor(t, owner);
  const serverSocket = runtime.io.sockets.sockets.get(socket.id);
  assert.ok(serverSocket.rooms.has(notifications.room(owner)));
  assert.ok(!serverSocket.rooms.has(notifications.room(admin)));
  const row = await order(); socket.disconnect();
  await transition({ orderId: row.id, status: "CONFIRMED", actor: { type: "ADMIN", id: admin._id } });
  const connected = new Promise(resolve => socket.once("connect", resolve)); socket.connect(); await connected;
  assert.equal((await socket.joinInbox({})).ok, true);
  const snapshot = await request("GET", "/notifications"); assert.equal(snapshot.body.items.length, 1);
  const received = new Promise(resolve => socket.once("notification:new", resolve));
  await transition({ orderId: row.id, status: "SHIPPING", actor: { type: "ADMIN", id: admin._id } });
  const event = await received;
  const next = await request("GET", "/notifications");
  assert.equal(new Set([...snapshot.body.items, event, ...next.body.items].map(item => item._id)).size, 2);
});
test("a previously joined admin socket loses notification access immediately after role demotion", async t => {
  const socket = await socketFor(t, admin);
  await User.updateOne({ _id: admin._id }, { $set: { role: "USER" } });
  await notifications.changed(admin);
  assert.ok(!runtime.io.sockets.sockets.get(socket.id).rooms.has(notifications.room(admin)));
});
test("post-commit notification failure does not roll back checkout; same-key retry repairs it once", async t => {
  const mock = t.mock.method(Notification, "create", async () => { throw Object.assign(new Error("temporary"), { code: "TEST_FAILURE" }); });
  const result = await checkout(owner._id, input);
  assert.ok(await Order.exists({ _id: result.order._id })); assert.equal(await Notification.countDocuments(), 0);
  mock.mock.restore();
  await checkout(owner._id, input); await checkout(owner._id, input);
  assert.equal((await rows(admin, "ORDER_CREATED")).length, 1);
});
