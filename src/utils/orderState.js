const ORDER_STATUSES = Object.freeze(["PENDING", "CONFIRMED", "SHIPPING", "DONE", "CANCEL"]);
const ADMIN_TRANSITIONS = Object.freeze({
  PENDING: ["CONFIRMED", "CANCEL"],
  CONFIRMED: ["SHIPPING", "CANCEL"],
  SHIPPING: ["DONE"], DONE: [], CANCEL: []
});

function orderError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
const conflict = () => orderError(409, "ORDER_TRANSITION_DENIED", "Không thể chuyển trạng thái đơn hàng này");
const knownMethod = order => ["COD", "VNPAY"].includes(order.shippingMethod);
const unpaid = order => order.paymentStatus === "UNPAID" && !order.inventoryRestoredAt && !order.paymentReviewRequired;

function canUserCancel(order) {
  return order.status === "PENDING" && knownMethod(order) && unpaid(order);
}

function canCreatePayment(order) {
  return order.status === "PENDING" && order.shippingMethod === "VNPAY" && unpaid(order);
}

function allowedAdminTransitions(order) {
  if (!knownMethod(order) || order.inventoryRestoredAt || order.paymentReviewRequired ||
      !["UNPAID", "PAID"].includes(order.paymentStatus)) return [];
  return (ADMIN_TRANSITIONS[order.status] || []).filter(target => target === "CANCEL"
    ? unpaid(order) : order.shippingMethod === "COD" || order.paymentStatus === "PAID");
}

function autoCancelFilter(cutoff) {
  if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
    throw orderError(400, "INVALID_CUTOFF", "Mốc thời gian hủy đơn không hợp lệ");
  }
  return { status: "PENDING", paymentStatus: "UNPAID", shippingMethod: "VNPAY",
    inventoryRestoredAt: null, paymentReviewRequired: { $ne: true }, createdAt: { $lte: cutoff } };
}

// Pure policy shared by every writer and the admin UI's server-supplied options.
function transitionPlan(order, target, actor) {
  if (!["USER", "ADMIN", "AUTO"].includes(actor.type)) {
    throw orderError(403, "ORDER_ACTOR_DENIED", "Không có quyền cập nhật đơn hàng");
  }
  if (!ORDER_STATUSES.includes(target)) throw orderError(400, "INVALID_ORDER_STATUS", "Trạng thái không hợp lệ");
  if (actor.type !== "ADMIN" && target !== "CANCEL") throw conflict();
  if (actor.type === "AUTO") autoCancelFilter(actor.cutoff);
  // Legacy CANCEL orders have no restoration marker: never attempt to restore them again.
  if (order.status === target) return { replayed: true };
  if (actor.type === "USER" && !canUserCancel(order)) throw conflict();
  if (actor.type === "ADMIN" && !allowedAdminTransitions(order).includes(target)) throw conflict();
  if (actor.type === "AUTO" && (!canCreatePayment(order) || !(order.createdAt <= actor.cutoff))) throw conflict();

  const set = { status: target };
  // For COD only, completing delivery also confirms cash collection.
  if (target === "DONE" && order.shippingMethod === "COD") set.paymentStatus = "PAID";
  return { set, restore: target === "CANCEL" };
}

// Only the verified IPN service applies this plan, in its attempt/order transaction.
function settlementPlan(order) {
  if (order.paymentStatus === "PAID" || order.settledPaymentAttempt) {
    return { status: order.status, reviewReason: "ADDITIONAL_PAYMENT", alreadyPaid: true };
  }
  if (order.status === "CANCEL") return { status: "CANCEL", reviewReason: "PAYMENT_AFTER_CANCELLATION" };
  if (order.inventoryRestoredAt || order.status === "DONE" || order.paymentReviewRequired) {
    return { status: order.status, reviewReason: "ORDER_STATE_MISMATCH" };
  }
  if (!["PENDING", "CONFIRMED", "SHIPPING"].includes(order.status)) throw conflict();
  return { status: order.status === "PENDING" ? "CONFIRMED" : order.status };
}

module.exports = { ORDER_STATUSES, orderError, canUserCancel, canCreatePayment,
  allowedAdminTransitions, autoCancelFilter, transitionPlan, settlementPlan };
