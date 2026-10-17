const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const User = require("../models/User");
const Member = require("../models/ConversationUser");
const Order = require("../models/Order");
const PaymentAttempt = require("../models/PaymentAttempt");
const { authenticateSocket } = require("../utils/chatAuthorization");
let io;
const room = user => `notifications:${user.role}:${user._id}`;
const publicFields = "_id type title message relatedEntityType relatedEntityId relatedOrderId readAt createdAt";
const publicItem = row => Object.fromEntries(publicFields.split(" ").map(key => [key, row[key]]));
const identity = user => ({ recipientUserId: user._id, recipientRole: user.role });

// Existing Socket.IO server/adapter only. Recheck DB role and session before delivery,
// so a previously joined room cannot retain access after demotion or revocation.
async function emit(recipient, event, payload) {
  if (!io) return;
  const target = room({ _id: recipient.recipientUserId, role: recipient.recipientRole });
  const sockets = await io.in(target).fetchSockets();
  await Promise.all(sockets.map(async socket => {
    try {
      const user = await authenticateSocket(socket.handshake.auth?.token);
      if (room(user) !== target) { await socket.leave(target); return; }
      socket.emit(event, payload);
    } catch { await socket.leave(target); socket.disconnect(true); }
  }));
}

// Notification failures must never turn an already committed checkout/payment into
// a business failure. Replaying the committed operation retries the same unique keys.
async function safely(work) {
  if (mongoose.connection.readyState !== 1) return;
  try { await work(); }
  catch (error) { console.error("Notification delivery failed", error.code || error.name); }
}
async function persist(recipient, event) {
  const dedupeKey = `${event.key}:${recipient.role}:${recipient._id}`;
  let row;
  try {
    row = await Notification.create({ ...identity(recipient), ...event, dedupeKey });
  } catch (error) {
    if (error.code === 11000) return; // Only the unique insert winner emits.
    throw error;
  }
  // A transport failure must not prevent persisting the remaining recipients.
  await safely(() => emit(row, "notification:new", publicItem(row)));
}
async function admins(event) {
  const recipients = await User.find({ role: "ADMIN" }).select("_id role").lean();
  for (const recipient of recipients) await persist(recipient, event);
}
async function customer(id, event) {
  const recipient = await User.findOne({ _id: id, role: "USER" }).select("_id role").lean();
  if (recipient) await persist(recipient, event);
}
const orderEvent = (order, type, key, title, message) => ({ type, key, title, message,
  relatedEntityType: "ORDER", relatedEntityId: String(order._id) });
const short = order => `#${String(order._id).slice(-6)}`;
async function orderHistory(order) {
  const labels = { PENDING: "Chờ xác nhận", CONFIRMED: "Đã xác nhận", SHIPPING: "Đang giao", DONE: "Hoàn tất", CANCEL: "Đã hủy" };
  for (const [index, entry] of (order.statusHistory || []).entries()) {
    if (entry.from === entry.to) continue;
    const key = `order:${order._id}:status:${index}`;
    await customer(order.idUser, orderEvent(order, "ORDER_STATUS_CHANGED", key,
      "Cập nhật đơn hàng", `Đơn hàng ${short(order)}: ${labels[entry.to] || entry.to}.`));
    if (entry.actorType === "USER" && entry.to === "CANCEL") {
      await admins(orderEvent(order, "ORDER_CANCELLED", `${key}:cancel`,
        "Khách hàng hủy đơn", `Khách hàng đã hủy đơn ${short(order)}.`));
    }
  }
  if (order.shippingMethod === "COD" && order.paymentStatus === "PAID") {
    await customer(order.idUser, orderEvent(order, "PAYMENT_PAID", `order:${order._id}:paid`,
      "Đã thanh toán", `Đã xác nhận thanh toán COD cho đơn ${short(order)}.`));
  }
}

module.exports = {
  room, identity, publicFields, publicItem,
  attach(server) { io = server; },
  changed(user) { return safely(() => emit(identity(user), "notification:changed", {})); },
  orderCreated(order) { return safely(() => admins(orderEvent(order, "ORDER_CREATED", `order:${order._id}:created`,
    "Đơn hàng mới", `Đơn hàng ${short(order)} vừa được tạo thành công.`))); },
  orderUpdated(order) { return safely(() => orderHistory(order)); },
  payment(reference) { return safely(async () => {
    const attempt = await PaymentAttempt.findOne({ reference }).lean();
    if (!attempt?.finalizedAt) return;
    const order = await Order.findById(attempt.orderId).lean();
    if (!order || String(order.idUser) !== String(attempt.userId)) return;
    const event = { relatedEntityType: "PAYMENT", relatedEntityId: attempt.reference, relatedOrderId: order._id };
    if (attempt.reviewReason || attempt.status === "REQUIRES_REVIEW") {
      Object.assign(event, { type: "PAYMENT_REQUIRES_REVIEW", key: `payment:${attempt._id}:review`,
        title: "Thanh toán cần kiểm tra", message: `Thanh toán cho đơn ${short(order)} cần được shop kiểm tra.` });
      await admins(event);
      await customer(order.idUser, event);
    } else if (attempt.status === "SUCCESS" && order.paymentStatus === "PAID") {
      await customer(order.idUser, { ...event, type: "PAYMENT_PAID", key: `order:${order._id}:paid`,
        title: "Đã thanh toán", message: `Đã xác nhận thanh toán cho đơn ${short(order)}.` });
    } else if (attempt.status === "FAILED") {
      const expired = attempt.responseCode === "11";
      await customer(order.idUser, { ...event, type: expired ? "PAYMENT_EXPIRED" : "PAYMENT_FAILED",
        key: `payment:${attempt._id}:failed`, title: expired ? "Thanh toán hết hạn" : "Thanh toán không thành công",
        message: `VNPay xác nhận thanh toán cho đơn ${short(order)} ${expired ? "đã hết hạn" : "không thành công"}.` });
    }
    await orderHistory(order);
  }); },
  message(message, sender) { return safely(async () => {
    const event = { type: "CHAT_MESSAGE", key: `message:${message._id}`, title: "Tin nhắn mới",
      message: sender.role === "ADMIN" ? "Shop vừa gửi tin nhắn cho bạn." : "Khách hàng vừa gửi tin nhắn hỗ trợ.",
      relatedEntityType: "CONVERSATION", relatedEntityId: String(message.idConversation) };
    if (sender.role === "USER") await admins(event);
    else {
      const members = await Member.find({ idConversation: message.idConversation, roleInConversation: "USER" }).lean();
      for (const member of members) await customer(member.idUser, event);
    }
  }); }
};
