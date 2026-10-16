const { randomUUID } = require("node:crypto");
const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server-core");
const { Server } = require("socket.io");
const { io: client } = require("socket.io-client");
const User = require("../src/models/User");
const Cart = require("../src/models/Cart");
const CartItem = require("../src/models/CartItem");
const Address = require("../src/models/UserAddress");
const Conversation = require("../src/models/Conversation");
const Member = require("../src/models/ConversationUser");
const Message = require("../src/models/Message");
const Order = require("../src/models/Order");
const OrderItem = require("../src/models/OrderItem");
const Review = require("../src/models/Review");

// Deliberately do not import app/server or dotenv: these tests cannot use a real DB.
process.env.JWT_SECRET = "security-regression-only-secret";
let mongo, server, io, base, a, b, admin, cartA, cartB, itemA, itemB, addrA, addrB, convA, convB;
const sockets = [];
const addressData = { receiverName: "Customer", phone: "0901234567", addressLine: "1 Test St",
  ward: "Ward", district: "District", city: "City", isDefault: true };
const token = (user, claims = {}, options = {}) => jwt.sign(
  { userId: user.id, authVersion: user.authVersion ?? 0, ...claims }, process.env.JWT_SECRET, { expiresIn: "1h", ...options }
);
async function request(method, route, user, body) {
  const res = await fetch(base + route, { method,
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: "Bearer " + token(user) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}
function connect(authToken) {
  const socket = client(base, { auth: { token: authToken }, transports: ["websocket"], reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}
const emit = (socket, event, data) => socket.timeout(3000).emitWithAck(event, data);

before(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: "7.0.24",
    downloadDir: path.join(__dirname, "../.cache/mongodb") }, instance: { ip: "127.0.0.1" } });
  await mongoose.connect(mongo.getUri(), { dbName: "security_regression" });
  const app = express();
  app.use(express.json());
  for (const [prefix, route] of [["cart", "cart.route"], ["addresses", "userAddress.route"],
    ["chat", "chat.routes"], ["orders", "order.route"], ["reviews", "review.route"], ["vnpay", "vnpay.route"]]) {
    app.use("/" + prefix, require("../src/routes/" + route));
  }
  server = http.createServer(app);
  io = new Server(server);
  app.set("io", io);
  require("../src/socket/chat.socket")(io);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
}, { timeout: 180000 });

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})));
  [a, b, admin] = await User.create([
    { name: "A", email: "a@test.invalid", password: "unused" },
    { name: "B", email: "b@test.invalid", password: "unused" },
    { name: "Admin", email: "admin@test.invalid", password: "unused", role: "ADMIN" }
  ]);
  process.env.ADMIN_ID = admin.id;
  [cartA, cartB] = await Cart.create([{ idUser: a._id }, { idUser: b._id }]);
  [itemA, itemB] = await CartItem.create([{ idCart: cartA._id, quantity: 1 }, { idCart: cartB._id, quantity: 2 }]);
  [addrA, addrB] = await Address.create([{ ...addressData, idUser: a._id }, { ...addressData, idUser: b._id }]);
  [convA, convB] = await Conversation.create([{}, {}]);
  await Member.create([
    { idConversation: convA._id, idUser: a._id, roleInConversation: "USER" },
    { idConversation: convB._id, idUser: b._id, roleInConversation: "USER" },
    { idConversation: convB._id, idUser: admin._id, roleInConversation: "ADMIN" }
  ]);
});
afterEach(() => { for (const socket of sockets.splice(0)) socket.disconnect(); });
after(async () => {
  if (io) await new Promise(resolve => io.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("cart: foreign update/delete are denied and leave stored items intact", async () => {
  assert.equal((await request("PUT", "/cart/update", a, { idItem: itemB.id, quantity: 9 })).status, 404);
  assert.equal((await request("DELETE", "/cart/remove/" + itemB.id, a)).status, 404);
  assert.equal((await CartItem.findById(itemB.id)).quantity, 2);
  assert.equal((await request("PUT", "/cart/update", a, { idItem: itemA.id, quantity: 3 })).status, 200);
  assert.equal((await CartItem.findById(itemA.id)).quantity, 3);
  assert.equal((await request("DELETE", "/cart/remove/" + itemA.id, a)).status, 200);
  assert.equal(await CartItem.findById(itemA.id), null);
});

test("cart: no cart, missing token and query-object IDs cannot bypass ownership", async () => {
  assert.equal((await request("PUT", "/cart/update", admin, { idItem: itemB.id, quantity: 9 })).status, 404);
  assert.equal((await request("PUT", "/cart/update", a, { idItem: { $ne: null }, quantity: 9 })).status, 400);
  assert.ok((await request("DELETE", "/cart/remove/" + itemB.id)).status >= 400);
  assert.equal((await CartItem.findById(itemB.id)).quantity, 2);
});

test("addresses: foreign update/delete/default and nonexistent IDs have no side effects", async () => {
  for (const id of [addrB.id, new mongoose.Types.ObjectId().toString()]) {
    assert.equal((await request("PUT", "/addresses/" + id, a, { receiverName: "Stolen", isDefault: true })).status, 404);
    assert.equal((await request("DELETE", "/addresses/" + id, a)).status, 404);
    assert.equal((await request("PUT", "/addresses/default/" + id, a)).status, 404);
  }
  assert.equal((await Address.findById(addrA.id)).isDefault, true);
  assert.equal((await Address.findById(addrB.id)).receiverName, "Customer");
  assert.equal((await Address.findById(addrB.id)).isDefault, true);
});

test("addresses: create/update cannot assign ownership, own CRUD still works", async () => {
  const created = await request("POST", "/addresses", a, { ...addressData, idUser: b.id, _id: addrB.id });
  assert.equal(created.status, 200);
  assert.equal(created.body.idUser, a.id);
  assert.notEqual(created.body._id, addrB.id);
  const updated = await request("PUT", "/addresses/" + created.body._id, a,
    { receiverName: "Updated", idUser: b.id, $set: { idUser: b.id } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.idUser, a.id);
  assert.equal(updated.body.receiverName, "Updated");
  assert.equal((await request("PUT", "/addresses/default/" + addrA.id, a)).status, 200);
  assert.equal((await Address.findById(created.body._id)).isDefault, false);
  assert.equal((await request("DELETE", "/addresses/" + created.body._id, a)).status, 200);
  assert.equal((await request("PUT", "/addresses/default/not-an-id", a)).status, 400);
});

test("chat REST: foreign read/send/mark-read/list denied, without mutation", async () => {
  const msg = await Message.create({ idConversation: convB._id, idUser: b._id, content: "Private" , clientMessageId: randomUUID() });
  assert.equal((await request("GET", "/chat/messages/" + convB.id, a)).status, 403);
  assert.equal((await request("POST", "/chat/message", a, { conversationId: convB.id, content: "Attack" })).status, 403);
  assert.equal((await request("PUT", "/chat/read/" + convB.id, a)).status, 403);
  assert.equal((await request("GET", "/chat/admin/conversations", a)).status, 403);
  assert.equal((await Message.findById(msg.id)).isRead, false);
  assert.equal(await Message.countDocuments(), 1);
  assert.equal((await Conversation.findById(convB.id)).lastMessage, undefined);
});

test("chat REST: owner and current DB admin allowed; sender comes from authentication", async () => {
  const sent = await request("POST", "/chat/message", a, { conversationId: convA.id, userId: b.id, idUser: b.id, content: "Hello" , clientMessageId: randomUUID() });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.idUser._id, a.id);
  assert.equal((await request("GET", "/chat/messages/" + convA.id, a)).body.length, 1);
  assert.equal((await request("GET", "/chat/messages/" + convA.id, admin)).status, 200);
  assert.equal((await request("GET", "/chat/admin/conversations", admin)).status, 200);
  assert.equal((await request("PUT", "/chat/read/" + convA.id, admin)).status, 200);
  assert.equal((await Message.findById(sent.body._id)).isRead, true);
  assert.equal((await request("POST", "/chat/conversation", a, { userId: b.id })).body._id, convA.id);
});

test("chat REST: malformed IDs/content rejected, demoted admin membership grants no customer access", async () => {
  for (const id of ["bad", { $ne: null }]) {
    assert.equal((await request("POST", "/chat/message", a, { conversationId: id, content: "Attack" })).status, 400);
  }
  assert.equal((await request("POST", "/chat/message", a, { conversationId: convA.id, content: { text: "x" } })).status, 400);
  await User.updateOne({ _id: admin._id }, { role: "USER" });
  assert.equal((await request("GET", "/chat/messages/" + convB.id, admin)).status, 403);
  assert.notEqual((await request("POST", "/chat/conversation", admin)).body._id, convB.id);
});

test("socket: missing, invalid, expired, nonexistent user JWTs cannot connect", async () => {
  for (const authToken of [undefined, "invalid", token(a, {}, { expiresIn: -1 }),
    token({ id: new mongoose.Types.ObjectId().toString() })]) {
    await assert.rejects(connect(authToken), /Token/);
  }
});

test("socket: forged role/userId and foreign room cannot bypass membership", async () => {
  const socket = await connect(token(a, { role: "ADMIN" }));
  assert.equal((await emit(socket, "joinConversation", convB.id)).status, 403);
  assert.equal(io.sockets.adapter.rooms.get(convB.id)?.has(socket.id) || false, false);
  assert.equal((await emit(socket, "sendMessage", { conversationId: convB.id, userId: b.id, content: "Attack" })).status, 403);
  assert.equal((await emit(socket, "joinConversation", { $ne: null })).status, 400);
  assert.equal(await Message.countDocuments(), 0);
});

test("socket: owner/admin join and receive messages with server-derived sender", async () => {
  const owner = await connect(token(a));
  const support = await connect(token(admin));
  assert.equal((await emit(owner, "joinConversation", convA.id.toUpperCase())).ok, true);
  assert.equal((await emit(support, "joinConversation", convA.id)).ok, true);
  const received = new Promise(resolve => support.once("newMessage", resolve));
  assert.equal((await emit(owner, "sendMessage", { conversationId: convA.id, userId: b.id, content: "Hello" , clientMessageId: randomUUID() })).ok, true);
  assert.equal((await received).idUser._id, a.id);
  assert.equal((await Message.findOne()).idUser.toString(), a.id);
  assert.equal((await emit(support, "sendMessage", { conversationId: convA.id, content: "Support" , clientMessageId: randomUUID() })).ok, true);
});

test("socket: revocation stops room delivery and denies subsequent sends", async () => {
  const support = await connect(token(admin));
  await emit(support, "joinConversation", convA.id);
  let leaked = false;
  support.on("newMessage", () => { leaked = true; });
  await User.updateOne({ _id: admin._id }, { role: "USER" });
  assert.equal((await request("POST", "/chat/message", a, { conversationId: convA.id, content: "Private" , clientMessageId: randomUUID() })).status, 200);
  assert.equal(io.sockets.adapter.rooms.get(convA.id)?.has(support.id) || false, false);
  assert.equal((await emit(support, "sendMessage", { conversationId: convA.id, content: "Attack" })).status, 403);
  assert.equal(leaked, false);
  const owner = await connect(token(a));
  await emit(owner, "joinConversation", convA.id);
  await Member.deleteOne({ idConversation: convA._id, idUser: a._id });
  assert.equal((await emit(owner, "sendMessage", { conversationId: convA.id, content: "Attack" })).status, 403);
});

test("socket: expired connections are disconnected", async () => {
  const socket = await connect(token(a, {}, { expiresIn: 2 }));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Expired socket remained connected")), 3500);
    socket.once("disconnect", () => { clearTimeout(timeout); resolve(); });
  });
});

test("similar ownership paths: order cancellation, review create/update, payment create/recreate", async () => {
  const order = await Order.create({ idUser: b._id, total: 1000, status: "DONE" });
  const orderItem = await OrderItem.create({ idOrder: order._id });
  const review = await Review.create({ idUser: b._id, idOrderItem: orderItem._id, comment: "Original", rating: 4 });
  assert.equal((await request("PUT", "/orders/" + order.id + "/cancel", a)).status, 404);
  assert.equal((await request("POST", "/reviews", a, { idOrderItem: orderItem.id, rating: 1 })).status, 403);
  assert.equal((await request("PATCH", "/reviews/" + review.id, a, { comment: "Attack" })).status, 403);
  for (const route of ["create", "recreate"]) {
    assert.equal((await request("POST", "/vnpay/" + route, a, { orderId: order.id, idempotencyKey: randomUUID() })).status, 404);
  }
  assert.equal((await Review.findById(review.id)).comment, "Original");
  assert.equal((await Order.findById(order.id)).status, "DONE");
});
