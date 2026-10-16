// The same canonical values are used by model setters and public filters.
const cleanAttribute = value => String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
const normalizeSize = value => cleanAttribute(value).toUpperCase();
const normalizeColor = value => cleanAttribute(value).toLowerCase();
const activeCatalog = { archivedAt: null }; // Matches legacy documents with no field, too.

function availability(variant, product, quantity = 1, checkStock = true) {
  let code, message, status = 409;
  if (!variant) { code = "VARIANT_NOT_FOUND"; message = "Biến thể không còn tồn tại"; status = 404; }
  else if (variant.archivedAt) { code = "VARIANT_ARCHIVED"; message = "Biến thể đã ngừng bán"; }
  else if (!product) { code = "PRODUCT_NOT_FOUND"; message = "Sản phẩm không còn tồn tại"; status = 404; }
  else if (product.archivedAt) { code = "PRODUCT_ARCHIVED"; message = "Sản phẩm đã ngừng bán"; }
  else if (!Number.isSafeInteger(quantity) || quantity < 1) {
    code = "INVALID_QUANTITY"; message = "Số lượng trong giỏ không hợp lệ"; status = 400;
  } else if (!Number.isSafeInteger(variant.price) || variant.price < 0) {
    code = "INVALID_PRICE"; message = "Giá sản phẩm không hợp lệ"; status = 400;
  } else if (!Number.isSafeInteger(variant.stock) || variant.stock < 0) {
    code = "INVALID_STOCK"; message = "Tồn kho sản phẩm không hợp lệ";
  } else if (checkStock && variant.stock < quantity) {
    code = "INSUFFICIENT_STOCK"; message = "Sản phẩm không đủ tồn kho";
  }
  return code ? { available: false, code, message, status } : { available: true };
}

function unavailableError(state, itemId) {
  return Object.assign(new Error(state.message), { status: state.status, code: state.code,
    ...(itemId ? { itemId: String(itemId) } : {}) });
}

function catalogError(res, error) {
  if (error.code === 11000) return res.status(409).json({ code: "DUPLICATE_CATALOG_ENTRY", message: "Dữ liệu đã tồn tại" });
  const invalid = ["ValidationError", "CastError"].includes(error.name);
  res.status(error.status || (invalid ? 400 : 500)).json({
    code: error.status ? error.code : invalid ? "INVALID_CATALOG_DATA" : "CATALOG_FAILED",
    message: error.status ? error.message : invalid ? "Dữ liệu không hợp lệ" : "Không thể cập nhật dữ liệu",
    ...(error.itemId ? { itemId: error.itemId } : {})
  });
}

module.exports = { normalizeSize, normalizeColor, activeCatalog, availability, unavailableError, catalogError };
