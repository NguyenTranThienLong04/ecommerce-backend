const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  recipientRole: { type: String, enum: ["USER", "ADMIN"], required: true, immutable: true },
  type: { type: String, enum: ["ORDER_CREATED", "ORDER_CANCELLED", "ORDER_STATUS_CHANGED",
    "PAYMENT_PAID", "PAYMENT_FAILED", "PAYMENT_EXPIRED", "PAYMENT_REQUIRES_REVIEW", "CHAT_MESSAGE"], required: true },
  title: { type: String, required: true, maxlength: 120 },
  message: { type: String, required: true, maxlength: 300 },
  relatedEntityType: { type: String, enum: ["ORDER", "PAYMENT", "CONVERSATION"], required: true },
  relatedEntityId: { type: String, required: true, maxlength: 100 },
  relatedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  readAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, immutable: true },
  dedupeKey: { type: String, required: true, maxlength: 220, immutable: true }
}, { versionKey: false });
schema.index({ recipientUserId: 1, recipientRole: 1, createdAt: -1, _id: -1 }, { name: "notification_inbox" });
schema.index({ recipientUserId: 1, recipientRole: 1, readAt: 1 }, { name: "notification_unread" });
schema.index({ dedupeKey: 1 }, { unique: true, name: "notification_dedupe_unique" });
module.exports = mongoose.model("Notification", schema);
