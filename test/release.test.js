const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { io: client } = require("socket.io-client");
const { MongoMemoryReplSet, MongoMemoryServer } = require("mongodb-memory-server-core");
const { start } = require("../server");
const config = require("../src/config/env");
const seed = require("../scripts/seed");
const send = require("../src/services/message.service");
const Message = require("../src/models/Message");
const Conversation = require("../src/models/Conversation");
const Member = require("../src/models/ConversationUser");
const User = require("../src/models/User");
const Product = require("../src/models/Product");
const Variant = require("../src/models/ProductVariant");
const binary = { version: "7.0.24", downloadDir: path.join(__dirname, "../.cache/mongodb") };
let mongo, runtime, env, accounts, conversation, second, url;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary, replSet: { count: 1, ip: "127.0.0.1" } });
  env = { NODE_ENV: "test", PORT: "0", HOST: "127.0.0.1", MONGO_URI: mongo.getUri("clothing_e2e"),
    JWT_SECRET: "release-tests-only-secret-never-for-production", FRONTEND_URL: "http://localhost:3000", DEMO_PASSWORD: "LocalDemo123!" };
  Object.assign(process.env, env);
  runtime = await start({ env, scheduler: false });
  url = "http://127.0.0.1:" + runtime.server.address().port;
});
after(async () => { await runtime?.close(); await mongoose.disconnect(); await mongo?.stop(); });
test("startup rejects missing/invalid environment without accepting requests or exposing values", async () => {
  for (const key of ["MONGO_URI", "JWT_SECRET", "FRONTEND_URL"]) {
    const invalid = { ...env }; delete invalid[key];
    await assert.rejects(start({ env: invalid }), new RegExp(key));
  }
  assert.throws(() => config({ ...env, NODE_ENV: "production" }), /FRONTEND_URL/);
  assert.throws(() => config({ ...env, VNPAY_ENABLED: "true" }), /VNP_TMN_CODE/);
  assert.throws(() => config({ ...env, CLOUDINARY_ENABLED: "true" }), /CLOUD_NAME/);
});
test("transaction-capable startup listens only after required indexes and exposes readiness", async () => {
  assert.equal((await fetch(url + "/health/live")).status, 200);
  assert.equal((await fetch(url + "/health/ready")).status, 200);
  const indexes = await Message.collection.indexes();
  assert.ok(indexes.some(index => index.name === "message_sender_client_unique" && index.unique));
  assert.equal((await fetch(url + "/api/vnpay/status/unused")).status, 503);
});
test("demo seed succeeds on a clean local database and reruns without changing accounts/stock", async () => {
  accounts = await seed(env);
  const hash = accounts.user.password;
  const stock = await Variant.findOne();
  await Variant.updateOne({ _id: stock._id }, { $set: { stock: 7 } });
  await seed(env);
  assert.equal(await User.countDocuments(), 2);
  assert.equal(await Product.countDocuments(), 3);
  assert.equal(await Variant.countDocuments(), 6);
  assert.equal((await User.findById(accounts.user._id)).password, hash);
  assert.equal((await Variant.findById(stock._id)).stock, 7);
  [conversation, second] = await Conversation.create([{}, {}]);
  await Member.create([conversation, second].map(row => ({ idConversation: row._id, idUser: accounts.user._id, roleInConversation: "USER" })));
});
test("seed refuses production and remote destinations before making changes", async () => {
  await assert.rejects(seed({ ...env, NODE_ENV: "production" }), /local/);
  await assert.rejects(seed({ ...env, MONGO_URI: "mongodb://example.test:27017/clothing_demo" }), /local/);
  assert.equal(await User.countDocuments(), 2);
});
test("real bootstrap routes validate demo login and public catalog queries", async () => {
  const login = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user@demo.example.com", password: env.DEMO_PASSWORD }) });
  assert.equal(login.status, 200);
  assert.equal(typeof (await login.json()).token, "string");
  const products = await fetch(url + "/api/products?size=M&page=1&limit=2");
  assert.equal(products.status, 200);
  assert.equal((await products.json()).products.length, 2);
});
function payload(changes = {}) { return { conversationId: conversation.id, content: "Hello", clientMessageId: randomUUID(), ...changes }; }
function observer() {
  const events = [];
  const token = jwt.sign({ userId: accounts.user.id, authVersion: accounts.user.authVersion ?? 0 }, env.JWT_SECRET);
  return { events, io: { in: () => ({ fetchSockets: async () => [{ handshake: { auth: { token } },
    emit: (name, message) => events.push({ name, message }), leave() {}, disconnect() {} }] }) } };
}
test("same client ID retry returns the stored message and emits once", async () => {
  const body = payload(), watch = observer();
  const first = await send(accounts.user, body, watch.io);
  const retry = await send(accounts.user, body, watch.io);
  assert.equal(first.message.id, retry.message.id);
  assert.equal(retry.replayed, true);
  assert.equal(await Message.countDocuments({ clientMessageId: body.clientMessageId }), 1);
  assert.equal(watch.events.length, 1);
});
test("concurrent same-ID sends have one database record and one emitter", async () => {
  const body = payload(), watch = observer();
  const results = await Promise.all(Array.from({ length: 8 }, () => send(accounts.user, body, watch.io)));
  assert.equal(new Set(results.map(result => result.message.id)).size, 1);
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(await Message.countDocuments({ clientMessageId: body.clientMessageId }), 1);
  assert.equal(watch.events.length, 1);
});
test("a reused ID with changed content/type/conversation conflicts and different senders remain isolated", async () => {
  const body = payload(); await send(accounts.user, body);
  for (const changes of [{ content: "Changed" }, { type: "IMAGE" }, { conversationId: second.id }]) {
    await assert.rejects(send(accounts.user, { ...body, ...changes }), error => error.status === 409);
  }
  const admin = await send(accounts.admin, body);
  assert.equal(admin.replayed, false);
  assert.equal(await Message.countDocuments({ clientMessageId: body.clientMessageId }), 2);
});
test("concurrent conflicting payloads cannot overwrite the winner", async () => {
  const body = payload();
  const results = await Promise.allSettled([send(accounts.user, body), send(accounts.user, { ...body, content: "Changed" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.status, 409);
  assert.equal(await Message.countDocuments({ clientMessageId: body.clientMessageId }), 1);
});
test("missing/malformed IDs are rejected and a replay still checks current membership", async () => {
  for (const id of [undefined, "", "not-a-uuid", { $ne: null }]) await assert.rejects(send(accounts.user, payload({ clientMessageId: id })), error => error.status === 400);
  const body = payload({ conversationId: second.id }); await send(accounts.user, body);
  await Member.deleteOne({ idConversation: second._id, idUser: accounts.user._id });
  await assert.rejects(send(accounts.user, body), error => error.status === 403);
});
test("REST send then socket retry share the same persisted message without broadcasting twice", async t => {
  const token = jwt.sign({ userId: accounts.user.id, authVersion: accounts.user.authVersion ?? 0 }, env.JWT_SECRET);
  const socket = client(url, { auth: { token }, transports: ["websocket"], reconnection: false });
  t.after(() => socket.disconnect());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  const ack = (name, data) => new Promise((resolve, reject) => socket.timeout(3000).emit(name, data, (error, result) => error ? reject(error) : resolve(result)));
  await ack("joinConversation", conversation.id);
  const events = []; socket.on("newMessage", message => events.push(message));
  const received = new Promise(resolve => socket.once("newMessage", resolve));
  const body = payload();
  const res = await fetch(url + "/api/chat/message", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  const stored = await res.json(); await received;
  const replay = await ack("sendMessage", body);
  assert.equal(replay.messageId, stored._id);
  assert.equal(replay.replayed, true);
  assert.equal(events.length, 1);
});
test("DB disconnected makes readiness fail while liveness stays live", async () => {
  await mongoose.disconnect();
  assert.equal((await fetch(url + "/health/ready")).status, 503);
  assert.equal((await fetch(url + "/health/live")).status, 200);
});
test("standalone MongoDB rejects startup instead of starting a checkout-incapable server", async () => {
  await runtime.close();
  const standalone = await MongoMemoryServer.create({ binary, instance: { ip: "127.0.0.1" } });
  try { await assert.rejects(start({ env: { ...env, MONGO_URI: standalone.getUri("clothing_e2e") }, scheduler: false }), /replica set.*standalone/); }
  finally { await standalone.stop(); }
});
