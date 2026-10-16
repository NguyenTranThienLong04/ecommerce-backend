const { createHash } = require("node:crypto");
const { availability, unavailableError } = require("./catalog");

const SHIPPING_FEE = 30000;
const addressFields = ["receiverName", "phone", "addressLine", "ward", "district", "city"];
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const checkoutError = (status, code, message) => Object.assign(new Error(message), { status, code });

function checkoutQuote(cart, items) {
  if (!items.length) throw checkoutError(400, "EMPTY_CART", "Giỏ hàng trống");
  let subtotal = 0;
  const lines = items.map(item => {
    const variant = item.idProductVariant;
    const state = availability(variant, variant?.idProduct, item.quantity, false);
    if (!state.available) throw unavailableError(state, item._id);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw checkoutError(400, "INVALID_QUANTITY", "Số lượng trong giỏ không hợp lệ");
    }
    if (!Number.isSafeInteger(variant.price) || variant.price < 0) {
      throw checkoutError(400, "INVALID_PRICE", "Giá sản phẩm không hợp lệ");
    }
    const lineTotal = variant.price * item.quantity;
    subtotal += lineTotal;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotal + SHIPPING_FEE)) {
      throw checkoutError(400, "INVALID_TOTAL", "Tổng tiền không hợp lệ");
    }
    return { itemId: String(item._id), quantity: item.quantity, unitPrice: variant.price, lineTotal };
  });
  // Stable across retries, but changes on quantity edits (including ABA), replacement or price changes.
  const snapshot = digest([String(cart._id), SHIPPING_FEE, items.map(item => [
    String(item._id), String(item.idProductVariant._id), String(item.idProductVariant.idProduct?._id || item.idProductVariant.idProduct),
    item.quantity, item.__v ?? 0, item.updatedAt?.toISOString(), item.idProductVariant.price,
    item.idProductVariant.size, item.idProductVariant.color,
    item.idProductVariant.idProduct?.nameProduct, item.idProductVariant.idProduct?.images?.[0]
  ]).sort((a, b) => a[0].localeCompare(b[0]))]);
  return { snapshot, subtotal, shippingFee: SHIPPING_FEE, total: subtotal + SHIPPING_FEE, lines };
}

module.exports = { checkoutQuote, checkoutError, digest, addressFields };
