const Order = require("../models/Order");
const transitionOrder = require("../services/orderTransition.service");
const { autoCancelFilter } = require("./orderState");

async function autoCancelPendingOrders(minutes = 15, now = new Date()) {
  if (!Number.isFinite(minutes) || minutes <= 0 || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Auto-cancel requires positive minutes and a valid time");
  }
  // One immutable cutoff for candidate selection AND the conditional write.
  const cutoff = new Date(now.getTime() - minutes * 60 * 1000);
  const result = { cancelled: 0, skipped: 0, failed: 0 };
  try {
    const orders = await Order.find(autoCancelFilter(cutoff)).select("_id").lean();
    for (const order of orders) {
      try {
        const transition = await transitionOrder({ orderId: order._id, status: "CANCEL", actor: { type: "AUTO", cutoff } });
        if (transition.replayed) result.skipped++;
        else result.cancelled++;
      } catch (error) {
        // A candidate is only a hint: payment/manual transitions may have won meanwhile.
        if (["ORDER_TRANSITION_DENIED", "ORDER_CHANGED", "ORDER_NOT_FOUND"].includes(error.code)) result.skipped++;
        else {
          result.failed++;
          console.error("Auto-cancel failed for order", String(order._id), error.code || "ORDER_UPDATE_FAILED");
        }
      }
    }
  } catch {
    result.failed++;
    console.error("Auto-cancel candidate lookup failed");
  }
  return result;
}

module.exports = autoCancelPendingOrders;
