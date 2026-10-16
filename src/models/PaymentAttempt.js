const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  provider: { type: String, enum: ["VNPAY"], default: "VNPAY", immutable: true },
  reference: { type: String, required: true, immutable: true },
  idempotencyKey: { type: String, immutable: true },
  requestHash: { type: String, immutable: true },
  paymentUrl: { type: String, immutable: true },
  merchant: { type: String, required: true, immutable: true },
  expectedAmount: { type: Number, required: true, immutable: true }, // VND, from Order
  expiresAt: { type: Date, required: true, immutable: true },
  status: { type: String, enum: ["PENDING", "SUCCESS", "FAILED", "REQUIRES_REVIEW"], default: "PENDING" },
  providerTransactionNo: String,
  providerPayDate: String,
  responseCode: String,
  transactionStatus: String,
  resultFingerprint: String,
  finalizedAt: Date,
  reviewReason: String,
  conflictingResult: {
    responseCode: String, transactionStatus: String, providerTransactionNo: String, receivedAt: Date
  }
}, { timestamps: true });

schema.index({ reference: 1 }, { unique: true, name: "payment_reference_unique" });
schema.index({ userId: 1, idempotencyKey: 1 }, {
  unique: true, name: "payment_user_key_unique",
  partialFilterExpression: { idempotencyKey: { $type: "string" } }
});
schema.index({ provider: 1, merchant: 1, providerTransactionNo: 1 }, {
  unique: true, name: "payment_provider_transaction_unique",
  partialFilterExpression: { providerTransactionNo: { $type: "string" } }
});
schema.index({ orderId: 1, status: 1 }, { name: "payment_order_status" });
schema.index({ status: 1, expiresAt: 1 }, { name: "payment_pending_expiry" });
// No TTL: an expired link may still have a late IPN and must remain reconcilable.
module.exports = mongoose.model("PaymentAttempt", schema);
