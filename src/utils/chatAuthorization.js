const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Conversation = require("../models/Conversation");
const ConversationUser = require("../models/ConversationUser");
const validSession = require("./sessionVersion");

function chatError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function authenticateSocket(token) {
  try {
    if (typeof token !== "string") throw new Error("Missing token");
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (!mongoose.isObjectIdOrHexString(decoded.userId)) throw new Error("Invalid user");
    const user = await User.findById(decoded.userId).select("-password");
    if (!validSession(decoded, user)) throw new Error("Revoked session");
    return user;
  } catch {
    throw chatError(401, "Token không hợp lệ");
  }
}

async function authorizeConversation(user, conversationId) {
  if (typeof conversationId !== "string" || !mongoose.isObjectIdOrHexString(conversationId)) {
    throw chatError(400, "ID hội thoại không hợp lệ");
  }
  // All current shop admins may support customers; customers need explicit membership.
  if (user.role !== "ADMIN") {
    const membership = await ConversationUser.exists({
      idConversation: conversationId,
      idUser: user._id,
      roleInConversation: "USER"
    });
    if (!membership) throw chatError(403, "Không có quyền truy cập hội thoại");
  }
  if (!await Conversation.exists({ _id: conversationId })) {
    throw chatError(404, "Hội thoại không tồn tại");
  }
  return conversationId.toLowerCase();
}

function messageFields(body = {}) {
  const { content, type = "TEXT" } = body;
  if (typeof content !== "string" || !content.trim() || !["TEXT", "IMAGE"].includes(type)) {
    throw chatError(400, "Tin nhắn không hợp lệ");
  }
  return { content, type };
}

async function emitConversationMessage(io, conversationId, message) {
  // A previously joined room must not retain access after account/role/membership revocation.
  const sockets = await io.in(conversationId).fetchSockets();
  await Promise.all(sockets.map(async socket => {
    try {
      const user = await authenticateSocket(socket.handshake.auth?.token);
      await authorizeConversation(user, conversationId);
      socket.emit("newMessage", message);
    } catch (error) {
      await socket.leave(conversationId);
      if (error.status === 401) socket.disconnect(true);
    }
  }));
}

module.exports = { authenticateSocket, authorizeConversation, messageFields, emitConversationMessage };
