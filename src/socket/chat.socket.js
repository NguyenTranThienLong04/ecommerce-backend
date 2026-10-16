const jwt = require("jsonwebtoken");
const sendMessage = require("../services/message.service");
const { authenticateSocket, authorizeConversation } = require("../utils/chatAuthorization");

module.exports = (io) => {
  io.use(async (socket, next) => {
    try {
      socket.data.user = await authenticateSocket(socket.handshake.auth?.token);
      next();
    } catch (error) {
      next(error);
    }
  });

  io.on("connection", (socket) => {
    const token = socket.handshake.auth.token;
    const expiresAt = jwt.decode(token).exp;
    const expiryTimer = expiresAt && setTimeout(
      () => socket.disconnect(true), Math.max(0, expiresAt * 1000 - Date.now())
    );
    if (expiryTimer) expiryTimer.unref();
    socket.on("disconnect", () => clearTimeout(expiryTimer));

    function fail(error, ack) {
      const result = { ok: false, status: error.status || 500,
        message: error.status ? error.message : "Lỗi xử lý chat" };
      if (typeof ack === "function") ack(result);
      else socket.emit("chatError", result);
      if (error.status === 401) socket.disconnect(true);
    }

    socket.on("joinConversation", async (id, ack) => {
      try {
        const user = await authenticateSocket(token);
        const conversationId = await authorizeConversation(user, id);
        await socket.join(conversationId);
        if (typeof ack === "function") ack({ ok: true });
      } catch (error) {
        fail(error, ack);
      }
    });

    socket.on("sendMessage", async (data, ack) => {
      try {
        // Re-read the account and role: never use payload userId or JWT role claims.
        const user = await authenticateSocket(token);
        const { message, replayed } = await sendMessage(user, data, io);
        if (typeof ack === "function") ack({ ok: true, messageId: message.id, replayed });
      } catch (error) {
        fail(error, ack);
      }
    });
  });
};
