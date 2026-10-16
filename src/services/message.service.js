const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const ensureMessageReady = require("../utils/messageReady");
const { authorizeConversation, messageFields, emitConversationMessage } = require("../utils/chatAuthorization");

module.exports = async function sendMessage(user, body, io) {
  // Check access on every replay too; an idempotency key is not an authorization token.
  const conversationId = await authorizeConversation(user, body?.conversationId);
  const { content, type } = messageFields(body);
  if (typeof body.clientMessageId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientMessageId)) {
    throw Object.assign(new Error("clientMessageId phải là UUID v4"), { status: 400 });
  }
  const clientMessageId = body.clientMessageId.toLowerCase();
  await ensureMessageReady();
  let message, replayed = false;
  try {
    message = await Message.create({ idUser: user._id, idConversation: conversationId, content, type, clientMessageId });
  } catch (error) {
    if (error.code !== 11000) throw error;
    message = await Message.findOne({ idUser: user._id, clientMessageId });
    if (!message) throw error;
    if (String(message.idConversation) !== conversationId || message.content !== content || message.type !== type) {
      throw Object.assign(new Error("Mã gửi tin đã được dùng cho nội dung hoặc hội thoại khác"), { status: 409 });
    }
    replayed = true;
  }
  if (!replayed) {
    await Conversation.findByIdAndUpdate(conversationId, { lastMessage: content, lastMessageAt: message.createdAt });
  }
  await message.populate("idUser", "name");
  // Only the unique insert winner broadcasts. After a process/network failure,
  // history resync recovers the persisted message; retry never broadcasts twice.
  if (!replayed && io) await emitConversationMessage(io, conversationId, message);
  return { message, replayed };
};
