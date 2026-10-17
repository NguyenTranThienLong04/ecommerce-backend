const mongoose = require("mongoose");
const { randomBytes } = require("node:crypto");
const Order = require("../models/Order");
const PaymentAttempt = require("../models/PaymentAttempt");
const ensurePaymentReady = require("../utils/paymentReady");
const { orderError, canCreatePayment, settlementPlan } = require("../utils/orderState");
const vnpay = require("../utils/vnpay");
const { digest } = require("../utils/checkoutQuote");
const transactionOptions = { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
  readPreference: "primary", timeoutMS: 10000 };
const MAX_UNRESOLVED_ATTEMPTS = 3;
const ORDER_PAYMENT_WINDOW_MS = 15 * 60000;
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const currentOrder = order => ({ _id: order._id, idUser: order.idUser, status: order.status,
  paymentStatus: order.paymentStatus, shippingMethod: order.shippingMethod, total: order.total,
  settledPaymentAttempt: order.settledPaymentAttempt || null });

async function createAttempt(userId, orderId, idempotencyKey, ip, now = new Date(), payload = { orderId }) {
  if (!mongoose.isObjectIdOrHexString(orderId)) throw orderError(400, "INVALID_ORDER_ID", "Mã đơn hàng không hợp lệ");
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw orderError(400, "INVALID_PAYMENT_KEY", "Cần mã yêu cầu thanh toán hợp lệ");
  }
  const identity = { _id: orderId, idUser: userId };
  const keyFilter = { userId, idempotencyKey };
  // Extra client fields never set payment facts, but cannot change under a reused key.
  const requestHash = digest(Object.keys(payload).filter(key => key !== "idempotencyKey").sort()
    .map(key => [key, key === "orderId" ? String(orderId).toLowerCase() : payload[key]]));
  async function result(attempt, replayed, session = null) {
    if (!sameId(attempt.orderId, orderId) || attempt.requestHash !== requestHash) {
      throw orderError(409, "PAYMENT_KEY_REUSED", "Mã thanh toán đã được dùng cho yêu cầu khác");
    }
    const order = await Order.findOne(identity).session(session).lean();
    if (!order) throw orderError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng");
    if (order.total !== attempt.expectedAmount || order.shippingMethod !== "VNPAY") {
      throw orderError(409, "PAYMENT_INTENT_CHANGED", "Thông tin đơn hàng không còn khớp yêu cầu thanh toán");
    }
    // Replays never mint another reference or extend the original payment window.
    const payable = attempt.status === "PENDING" && !attempt.reviewReason && canCreatePayment(order) && attempt.expiresAt > now;
    return { reference: attempt.reference, expiresAt: attempt.expiresAt, replayed,
      paymentUrl: payable ? attempt.paymentUrl : null };
  }
  const existing = await PaymentAttempt.findOne(keyFilter).lean();
  if (existing) return result(existing, true);
  if (!await Order.exists(identity)) throw orderError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng");
  const settings = vnpay.config(true); // Fail before any write if configuration is incomplete.
  await ensurePaymentReady();
  try {
    return await mongoose.connection.transaction(async session => {
    const committed = await PaymentAttempt.findOne(keyFilter).session(session).lean();
    if (committed) return result(committed, true, session);
    const order = await Order.findOne(identity).session(session).lean();
    if (!order) throw orderError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng");
    if (!canCreatePayment(order)) throw orderError(409, "ORDER_NOT_PAYABLE", "Đơn hàng không còn cho phép thanh toán VNPay");
    const expiresAt = new Date(Math.min(now.getTime() + ORDER_PAYMENT_WINDOW_MS, order.createdAt.getTime() + ORDER_PAYMENT_WINDOW_MS));
    if (expiresAt <= now) throw orderError(409, "PAYMENT_WINDOW_EXPIRED", "Đã hết thời gian thanh toán đơn hàng");
    if (!Number.isSafeInteger(order.total) || order.total <= 0 || order.total * 100 > 999999999999) {
      throw orderError(409, "INVALID_PAYMENT_AMOUNT", "Số tiền thanh toán không hợp lệ");
    }
    const unresolved = await PaymentAttempt.countDocuments({ orderId: order._id,
      $or: [{ status: { $in: ["PENDING", "REQUIRES_REVIEW"] } }, { reviewReason: { $exists: true } }] }).session(session);
    if (unresolved >= MAX_UNRESOLVED_ATTEMPTS) {
      throw orderError(409, "PAYMENT_ATTEMPT_LIMIT", "Có nhiều lần thanh toán chưa rõ kết quả. Vui lòng chờ xác nhận hoặc liên hệ hỗ trợ");
    }
    // Serializes creation with other creators, IPN and cancellation across instances.
    const claimed = await Order.findOneAndUpdate({ ...currentOrder(order), inventoryRestoredAt: null,
      paymentReviewRequired: { $ne: true } }, { $inc: { paymentRevision: 1 } }, { session, returnDocument: "after" });
    if (!claimed) throw orderError(409, "ORDER_CHANGED", "Đơn hàng đã thay đổi");
    const data = { orderId: order._id, userId, idempotencyKey, requestHash, merchant: settings.merchant,
      reference: randomBytes(16).toString("hex"), expectedAmount: order.total, createdAt: now, expiresAt };
    data.paymentUrl = vnpay.paymentUrl(data, ip, settings);
    const [created] = await PaymentAttempt.create([data], { session });
    return result(created, false, session);
  }, transactionOptions);
  } catch (error) {
    // Resolve unique-key races/uncertain commits only after the transaction closes.
    const winner = await PaymentAttempt.findOne(keyFilter).lean();
    if (winner) return result(winner, true);
    if (error.status) throw error;
    if (error.code === 11000 || error.hasErrorLabel?.("TransientTransactionError") ||
        error.hasErrorLabel?.("UnknownTransactionCommitResult") || error.name === "MongoOperationTimeoutError") {
      throw orderError(409, "PAYMENT_RETRY", "Chưa xác nhận được link thanh toán. Vui lòng thử lại cùng yêu cầu.");
    }
    throw error;
  }
}

async function callbackBinding(result, session) {
  const attempt = await PaymentAttempt.findOne({ reference: result.reference }).session(session || null).lean();
  if (!attempt) throw vnpay.ipnError("01", "Reference not found", 404);
  const order = await Order.findById(attempt.orderId).session(session || null).lean();
  if (!order) throw vnpay.ipnError("01", "Order not found", 404);
  if (attempt.provider !== "VNPAY" || attempt.merchant !== result.merchant ||
      !sameId(attempt.userId, order.idUser) || order.shippingMethod !== "VNPAY" ||
      result.orderInfo !== vnpay.orderInfo(attempt)) {
    throw vnpay.ipnError("99", "Invalid order mapping", 409);
  }
  if (!Number.isSafeInteger(attempt.expectedAmount) || attempt.expectedAmount <= 0 ||
      result.amount !== attempt.expectedAmount * 100 || order.total !== attempt.expectedAmount) {
    throw vnpay.ipnError("04", "Amount mismatch", 409);
  }
  return { attempt, order };
}

async function processIPN(query) {
  const result = vnpay.verifyCallback(query);
  await ensurePaymentReady();
  const response = await mongoose.connection.transaction(async session => {
    const { attempt, order } = await callbackBinding(result, session);
    if (attempt.status !== "PENDING") {
      if (attempt.resultFingerprint === result.fingerprint) return { RspCode: "02", Message: "Already processed" };
      if (!attempt.resultFingerprint) throw vnpay.ipnError("99", "Invalid attempt state", 409);
      // Preserve the first final result and one contradictory signed report for review.
      // In particular, a later report of money received must not disappear after FAILED.
      if (!attempt.conflictingResult?.receivedAt) {
        const recorded = await PaymentAttempt.updateOne({ _id: attempt._id, resultFingerprint: attempt.resultFingerprint,
          "conflictingResult.receivedAt": { $exists: false } }, { $set: { reviewReason: "CONFLICTING_CALLBACK",
          conflictingResult: { responseCode: result.responseCode, transactionStatus: result.transactionStatus,
            providerTransactionNo: result.providerTransactionNo, receivedAt: new Date() } } }, { session });
        if (recorded.modifiedCount !== 1) throw vnpay.ipnError("99", "Attempt changed", 409);
        const marked = await Order.updateOne(currentOrder(order), { $set: { paymentReviewRequired: true },
          $inc: { paymentRevision: 1 } }, { session });
        if (marked.modifiedCount !== 1) throw vnpay.ipnError("99", "Order changed", 409);
      }
      return { RspCode: "99", Message: "Conflicting result requires review" };
    }
    const finalizedAt = new Date();
    const plan = result.outcome === "SUCCESS" ? settlementPlan(order) : null;
    const reviewReason = plan?.reviewReason || (result.outcome === "REQUIRES_REVIEW" ? "PROVIDER_REPORTED_RISK" : undefined);
    const fields = { status: reviewReason ? "REQUIRES_REVIEW" : result.outcome,
      responseCode: result.responseCode, transactionStatus: result.transactionStatus,
      resultFingerprint: result.fingerprint, finalizedAt,
      ...(!/^0+$/.test(result.providerTransactionNo) ? { providerTransactionNo: result.providerTransactionNo } : {}),
      ...(result.providerPayDate ? { providerPayDate: result.providerPayDate } : {}),
      ...(reviewReason ? { reviewReason } : {}) };
    const claimed = await PaymentAttempt.findOneAndUpdate({ _id: attempt._id, status: "PENDING",
      reference: result.reference, orderId: order._id, expectedAmount: order.total }, { $set: fields },
    { session, returnDocument: "after", runValidators: true });
    if (!claimed) throw vnpay.ipnError("99", "Attempt changed", 409);
    if (result.outcome === "SUCCESS") {
      const set = { paymentReviewRequired: Boolean(reviewReason) };
      const update = { $set: set, $inc: { paymentRevision: 1 } };
      if (!plan.alreadyPaid) {
        Object.assign(set, { status: plan.status, paymentStatus: "PAID", settledPaymentAttempt: attempt._id,
          paymentReference: attempt.reference, providerTransactionNo: result.providerTransactionNo, paidAt: finalizedAt });
        update.$push = { statusHistory: { from: order.status, to: plan.status, actorType: "PAYMENT", at: finalizedAt } };
      }
      const settled = await Order.findOneAndUpdate(currentOrder(order), update, { session, returnDocument: "after", runValidators: true });
      if (!settled) throw vnpay.ipnError("99", "Order changed", 409);
    } else if (reviewReason) {
      const marked = await Order.updateOne(currentOrder(order), { $set: { paymentReviewRequired: true },
        $inc: { paymentRevision: 1 } }, { session });
      if (marked.modifiedCount !== 1) throw vnpay.ipnError("99", "Order changed", 409);
    }
    // FAILED finalizes this attempt only; it never cancels the Order or changes stock.
    return { RspCode: "00", Message: "Result recorded" };
  }, transactionOptions);
  await require("./notification.service").payment(result.reference);
  return response;
}

async function returnLocation(query) {
  const result = vnpay.verifyCallback(query);
  const { attempt } = await callbackBinding(result);
  const url = new URL(vnpay.config(true).resultUrl);
  url.searchParams.set("reference", attempt.reference);
  return url.href; // No settlement or other writes, regardless of the browser result.
}

async function paymentStatus(userId, reference, now = new Date()) {
  if (typeof reference !== "string" || !/^[a-zA-Z0-9]{1,100}$/.test(reference)) {
    throw orderError(400, "INVALID_REFERENCE", "Mã thanh toán không hợp lệ");
  }
  // Single aggregation snapshot: do not combine an old attempt read with a newer Order read.
  const [attempt] = await PaymentAttempt.aggregate([
    { $match: { reference, userId: new mongoose.Types.ObjectId(String(userId)) } },
    { $lookup: { from: Order.collection.name, localField: "orderId", foreignField: "_id", as: "orders" } }
  ]).readConcern("snapshot");
  const order = attempt?.orders[0];
  if (!attempt || !order || !sameId(order.idUser, userId)) throw orderError(404, "PAYMENT_NOT_FOUND", "Không tìm thấy thanh toán");
  let state = "PROCESSING";
  if (attempt.reviewReason || order.paymentReviewRequired || (attempt.status === "SUCCESS" && order.paymentStatus !== "PAID")) state = "REQUIRES_REVIEW";
  else if (order.paymentStatus === "PAID") state = "PAID";
  else if (attempt.status === "FAILED") state = "FAILED";
  else if (order.status === "CANCEL") state = "CANCELLED";
  else if (attempt.expiresAt <= now) state = "EXPIRED";
  return { reference: attempt.reference, orderId: order._id, state, attemptStatus: attempt.status,
    orderStatus: order.status, paymentStatus: order.paymentStatus, expiresAt: attempt.expiresAt,
    confirmedByProvider: Boolean(attempt.finalizedAt) };
}

module.exports = { createAttempt, processIPN, returnLocation, paymentStatus, MAX_UNRESOLVED_ATTEMPTS };
