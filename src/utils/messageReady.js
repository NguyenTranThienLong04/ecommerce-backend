const mongoose = require("mongoose");
const Message = require("../models/Message");
const ready = new WeakMap();
module.exports = function ensureMessageReady() {
  const client = mongoose.connection.getClient();
  if (!client || mongoose.connection.readyState !== 1) throw new Error("Database not connected");
  if (!ready.has(client)) {
    const check = Message.createIndexes();
    ready.set(client, check);
    check.catch(() => ready.delete(client));
  }
  return ready.get(client);
};
