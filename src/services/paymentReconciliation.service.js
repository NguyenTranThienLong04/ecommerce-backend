const mongoose = require("mongoose");
const PaymentAttempt = require("../models/PaymentAttempt");
const Order = require("../models/Order");
const { orderError } = require("../utils/orderState");

// Read-only local mismatch inventory, not a provider query or automatic reconciliation.
module.exports = async function reconciliation({ after, limit = "50" } = {}, now = new Date()) {
  if (typeof limit !== "string" || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 ||
      (after !== undefined && !mongoose.isObjectIdOrHexString(after))) {
    throw orderError(400, "INVALID_RECONCILIATION_QUERY", "Tham số tra cứu không hợp lệ");
  }
  const reason = (condition, label) => ({ $cond: [condition, [label], []] });
  const rows = await PaymentAttempt.aggregate([
    { $match: after ? { _id: { $gt: new mongoose.Types.ObjectId(after) } } : {} },
    { $lookup: { from: Order.collection.name, localField: "orderId", foreignField: "_id", as: "orders" } },
    { $set: { order: { $arrayElemAt: ["$orders", 0] } } },
    { $set: { reasons: { $concatArrays: [
      reason({ $and: [{ $eq: ["$status", "PENDING"] }, { $lte: ["$expiresAt", now] }] }, "PENDING_OVERDUE"),
      reason({ $or: [{ $eq: ["$status", "REQUIRES_REVIEW"] }, { $ne: [{ $ifNull: ["$reviewReason", null] }, null] }] }, "REQUIRES_REVIEW"),
      reason({ $eq: [{ $ifNull: ["$order._id", null] }, null] }, "ORDER_MISSING"),
      reason({ $and: [{ $eq: ["$order.shippingMethod", "VNPAY"] }, { $eq: ["$order.paymentStatus", "UNPAID"] }] }, "UNPAID_ORDER_WITH_ATTEMPT"),
      reason({ $and: [{ $eq: ["$status", "SUCCESS"] }, { $or: [
        { $ne: ["$order.paymentStatus", "PAID"] }, { $ne: ["$order.settledPaymentAttempt", "$_id"] },
        { $in: ["$order.status", ["CANCEL", "PENDING"]] },
        { $ne: [{ $ifNull: ["$order.inventoryRestoredAt", null] }, null] }
      ] }] }, "SUCCESS_ORDER_MISMATCH"),
      reason({ $and: [{ $eq: ["$order.status", "CANCEL"] }, { $eq: ["$responseCode", "00"] },
        { $eq: ["$transactionStatus", "00"] }] }, "PAID_AFTER_CANCELLATION"),
      reason({ $or: [{ $ne: ["$expectedAmount", "$order.total"] }, { $ne: ["$userId", "$order.idUser"] },
        { $ne: ["$order.shippingMethod", "VNPAY"] }] }, "ORDER_MAPPING_MISMATCH")
    ] } } },
    { $match: { "reasons.0": { $exists: true } } }, { $sort: { _id: 1 } }, { $limit: Number(limit) + 1 },
    { $project: { orders: 0, resultFingerprint: 0, paymentUrl: 0, idempotencyKey: 0, requestHash: 0 } }
  ]).readConcern("snapshot");
  const hasMore = rows.length > Number(limit);
  const items = rows.slice(0, Number(limit)).map(({ order, ...attempt }) => ({ ...attempt,
    order: order ? { _id: order._id, status: order.status, paymentStatus: order.paymentStatus,
      paymentReviewRequired: order.paymentReviewRequired, total: order.total } : null }));
  return { items, nextCursor: hasMore ? String(items.at(-1)._id) : null, providerQueried: false };
};
