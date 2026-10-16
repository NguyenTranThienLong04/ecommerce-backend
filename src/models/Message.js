const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  idConversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Conversation"
  },
  idUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  content: String,
  clientMessageId: String,
  type: {
    type: String,
    enum: ["TEXT", "IMAGE"],
    default: "TEXT"
  },
  isRead: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

// A sender's logical send is bound to one immutable conversation and payload.
// Legacy messages without a client ID are excluded; no destructive backfill.
messageSchema.index({ idUser: 1, clientMessageId: 1 }, {
  unique: true, name: "message_sender_client_unique",
  partialFilterExpression: { clientMessageId: { $type: "string" } }
});
module.exports = mongoose.model("Message", messageSchema);
