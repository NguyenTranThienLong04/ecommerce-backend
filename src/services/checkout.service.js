const mongoose = require("mongoose");
const Cart = require("../models/Cart");
const CartItem = require("../models/CartItem");
const Order = require("../models/Order");
const OrderItem = require("../models/OrderItem");
const ProductVariant = require("../models/ProductVariant");
const Address = require("../models/UserAddress");
const ensureCheckoutReady = require("../utils/checkoutReady");
const { availability, unavailableError, activeCatalog } = require("../utils/catalog");
const { checkoutQuote, checkoutError, digest, addressFields } = require("../utils/checkoutQuote");

function replay(order, requestHash) {
  if (order.checkoutRequestHash !== requestHash) {
    throw checkoutError(409, "IDEMPOTENCY_KEY_REUSED", "Mã đặt hàng đã được dùng cho yêu cầu khác");
  }
  return { order, replayed: true };
}

async function checkout(userId, input, { paymentMethods = ["COD"] } = {}) {
  await ensureCheckoutReady();
  const keyFilter = { idUser: userId, idempotencyKey: input.idempotencyKey };
  const addressInput = input.addressId ? { addressId: input.addressId }
    : Object.fromEntries(addressFields.map(field => [field, input[field]]));
  const requestHash = digest([String(userId), input.cartId, input.cartSnapshot, input.shippingMethod, addressInput]);

  // Must precede reading today's cart: a committed retry returns the original order.
  const existing = await Order.findOne(keyFilter);
  if (existing) return replay(existing, requestHash);

  // A committed replay stays readable, but disabled methods cannot create new orders.
  if (!paymentMethods.includes(input.shippingMethod)) {
    throw checkoutError(409, "PAYMENT_METHOD_UNAVAILABLE", "Phương thức thanh toán này hiện không khả dụng. Vui lòng chọn COD.");
  }

  try {
    return await mongoose.connection.transaction(async session => {
      const committed = await Order.findOne(keyFilter).session(session);
      if (committed) return replay(committed, requestHash);

      const cart = await Cart.findOne({ _id: input.cartId, idUser: userId }).session(session);
      if (!cart) throw checkoutError(404, "CART_NOT_FOUND", "Không tìm thấy giỏ hàng");
      const items = await CartItem.find({ idCart: cart._id }).sort({ _id: 1 })
        .session(session).populate({ path: "idProductVariant", options: { session },
          populate: { path: "idProduct", options: { session } } });
      const quote = checkoutQuote(cart, items);
      if (quote.snapshot !== input.cartSnapshot) {
        throw checkoutError(409, "CART_CHANGED", "Giỏ hàng hoặc giá đã thay đổi. Vui lòng kiểm tra lại");
      }

      let address = addressInput;
      if (input.addressId) {
        address = await Address.findOne({ _id: input.addressId, idUser: userId }).session(session);
        if (!address) throw checkoutError(404, "ADDRESS_NOT_FOUND", "Không tìm thấy địa chỉ của bạn");
      }
      if (addressFields.some(field => typeof address[field] !== "string" || !address[field].trim())) {
        throw checkoutError(400, "INVALID_ADDRESS", "Địa chỉ không hợp lệ");
      }

      for (const item of items) {
        const variant = item.idProductVariant;
        const state = availability(variant, variant.idProduct, item.quantity);
        if (!state.available) throw unavailableError(state, item._id);
      }

      const [order] = await Order.create([{
        idUser: userId, idCart: cart._id, idempotencyKey: input.idempotencyKey,
        checkoutSnapshot: input.cartSnapshot, checkoutRequestHash: requestHash,
        ...Object.fromEntries(addressFields.map(field => [field, address[field]])),
        shippingMethod: input.shippingMethod, subtotal: quote.subtotal,
        shippingFee: quote.shippingFee, total: quote.total, status: "PENDING"
      }], { session });

      // Sequential session operations; conditional decrement is the stock authority.
      for (const item of items) {
        const variant = item.idProductVariant;
        const stock = await ProductVariant.updateOne(
          { _id: variant._id, ...activeCatalog, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity, inventoryVersion: 1 } }, { session }
        );
        if (stock.modifiedCount !== 1) {
          throw checkoutError(409, "INSUFFICIENT_STOCK", "Sản phẩm không đủ tồn kho");
        }
        await OrderItem.create([{
          idOrder: order._id, idProductVariant: variant._id, quantity: item.quantity, price: variant.price,
          productSnapshot: { nameProduct: variant.idProduct.nameProduct, size: variant.size || "",
            color: variant.color || "", image: variant.idProduct.images?.[0] || "" }
        }], { session });
      }

      // Never delete by cart alone. Concurrent edits/deletes of these documents cause
      // a write conflict; retries keep the original snapshot and cannot consume a newer cart.
      const consumed = await CartItem.deleteMany({
        idCart: cart._id, _id: { $in: items.map(item => item._id) }
      }, { session });
      if (consumed.deletedCount !== items.length) {
        throw checkoutError(409, "CART_CHANGED", "Giỏ hàng đã thay đổi. Vui lòng kiểm tra lại");
      }
      return { order, replayed: false };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
      readPreference: "primary", timeoutMS: 10000 });
  } catch (error) {
    // Unique-index races and uncertain commits are resolved using committed state,
    // after the failed transaction has been aborted/closed by the driver.
    const winner = await Order.findOne(keyFilter);
    if (winner) return replay(winner, requestHash);
    if (error.status) throw error;
    if (error.code === 11000) {
      throw checkoutError(409, "CHECKOUT_RETRY", "Yêu cầu đang được xử lý. Vui lòng thử lại");
    }
    if (error.hasErrorLabel?.("TransientTransactionError") || error.hasErrorLabel?.("UnknownTransactionCommitResult") ||
        error.name === "MongoOperationTimeoutError") {
      throw checkoutError(409, "CHECKOUT_RETRY", "Chưa xác nhận được kết quả. Vui lòng thử lại cùng yêu cầu");
    }
    throw error;
  }
}

module.exports = checkout;
