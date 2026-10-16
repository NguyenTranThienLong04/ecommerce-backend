const mongoose = require("mongoose");
const Message = require("../models/Message");
const { createDiagnostic } = require("./startupDiagnostic");
const ready = new WeakMap();
module.exports = function ensureMessageReady(diagnostic = createDiagnostic(process.env.MONGO_URI)) {
  const client = mongoose.connection.getClient();
  if (!client || mongoose.connection.readyState !== 1) throw new Error("Database not connected");
  if (!ready.has(client)) {
    const check = diagnostic.run("message createIndexes:Message/messages", () => Message.createIndexes());
    ready.set(client, check);
    check.catch(() => ready.delete(client));
  }
  return ready.get(client);
};
