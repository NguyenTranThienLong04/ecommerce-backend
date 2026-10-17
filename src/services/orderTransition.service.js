const mongoose = require("mongoose");
const Order = require("../models/Order");
const OrderItem = require("../models/OrderItem");
const ProductVariant = require("../models/ProductVariant");
const ensureCheckoutReady = require("../utils/checkoutReady");
const { orderError, autoCancelFilter, transitionPlan } = require("../utils/orderState");

async function restoreInventory(orderId, session) {
  const items = await OrderItem.find({ idOrder: orderId }).session(session).lean();
  const quantities = new Map();
  const invalid = () => orderError(409, "INVENTORY_RESTORE_FAILED", "Không thể hoàn kho; cần kiểm tra dữ liệu đơn hàng");
  if (!items.length) throw invalid();
  for (const item of items) {
    if (!item.idProductVariant || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw invalid();
    const id = String(item.idProductVariant);
    const quantity = (quantities.get(id) || 0) + item.quantity;
    if (!Number.isSafeInteger(quantity)) throw invalid();
    quantities.set(id, quantity);
  }
  // Stable ordering and atomic increments also compose with concurrent checkouts.
  for (const [id, quantity] of [...quantities].sort(([a], [b]) => a.localeCompare(b))) {
    const variant = await ProductVariant.findById(id).session(session).lean();
    if (!variant || !Number.isSafeInteger(variant.stock) || variant.stock < 0 ||
        !Number.isSafeInteger(variant.stock + quantity)) throw invalid();
    const result = await ProductVariant.updateOne(
      { _id: id, stock: variant.stock }, { $inc: { stock: quantity, inventoryVersion: 1 } }, { session }
    );
    if (result.modifiedCount !== 1) throw invalid();
  }
}

async function transitionOrder({ orderId, status, actor }) {
  if (!mongoose.isObjectIdOrHexString(orderId)) throw orderError(400, "INVALID_ORDER_ID", "Mã đơn hàng không hợp lệ");
  if (!actor || !["USER", "ADMIN", "AUTO"].includes(actor.type) ||
      (["USER", "ADMIN"].includes(actor.type) && !mongoose.isObjectIdOrHexString(actor.id))) {
    throw orderError(403, "ORDER_ACTOR_DENIED", "Không có quyền cập nhật đơn hàng");
  }
  const identity = { _id: orderId, ...(actor.type === "USER" ? { idUser: actor.id } : {}) };
  const notFound = () => orderError(404, "ORDER_NOT_FOUND", "Không tìm thấy đơn hàng");
  // Check ownership before infrastructure readiness; re-read it inside the transaction.
  if (!await Order.exists(identity)) throw notFound();
  try {
    await ensureCheckoutReady();
  } catch {
    throw orderError(503, "ORDER_UNAVAILABLE", "Cập nhật đơn hàng cần cơ sở dữ liệu hỗ trợ transaction");
  }
  try {
    return await mongoose.connection.transaction(async session => {
      const order = await Order.findOne(identity).session(session).lean();
      if (!order) throw notFound();
      const plan = transitionPlan(order, status, actor);
      if (plan.replayed) return { order, replayed: true };
      const at = new Date();
      if (plan.restore) plan.set.inventoryRestoredAt = at;
      // Every competing writer claims the SAME order using its current state at write time.
      const filter = { ...identity, status: order.status, paymentStatus: order.paymentStatus,
        shippingMethod: order.shippingMethod, inventoryRestoredAt: null,
        ...(actor.type === "AUTO" ? autoCancelFilter(actor.cutoff) : {}) };
      const claimed = await Order.findOneAndUpdate(filter, {
        $set: plan.set,
        $push: { statusHistory: { from: order.status, to: plan.set.status, actorType: actor.type,
          ...(actor.id ? { actorId: actor.id } : {}), at } }
      }, { session, returnDocument: "after", runValidators: true }).lean();
      if (!claimed) throw orderError(409, "ORDER_CHANGED", "Đơn hàng đã thay đổi. Vui lòng tải lại");
      if (plan.restore) await restoreInventory(order._id, session);
      return { order: claimed, replayed: false };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
      readPreference: "primary", timeoutMS: 10000 });
  } catch (error) {
    if (error.hasErrorLabel?.("TransientTransactionError") || error.hasErrorLabel?.("UnknownTransactionCommitResult") ||
        error.name === "MongoOperationTimeoutError") {
      throw orderError(409, "ORDER_RETRY", "Chưa xác nhận được kết quả. Vui lòng thử lại cùng yêu cầu");
    }
    throw error;
  }
}

module.exports = async (...args) => {
  const result = await transitionOrder(...args);
  await require("./notification.service").orderUpdated(result.order);
  return result;
};
