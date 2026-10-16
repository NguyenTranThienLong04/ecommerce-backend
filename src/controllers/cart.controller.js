const Cart = require("../models/Cart");
const CartItem = require("../models/CartItem");
const mongoose = require("mongoose");
const ProductVariant = require("../models/ProductVariant");
const ensureCatalogReady = require("../utils/catalogReady");
const ensureCheckoutReady = require("../utils/checkoutReady");
const { activeCatalog, availability, unavailableError, catalogError } = require("../utils/catalog");
const { checkoutQuote } = require("../utils/checkoutQuote");

async function getOrCreateCart(userId) {
  try {
    return await Cart.findOneAndUpdate({ idUser: userId }, { $setOnInsert: { idUser: userId } },
      { upsert: true, returnDocument: "after" });
  } catch (error) {
    if (error.code !== 11000) throw error;
    return Cart.findOne({ idUser: userId });
  }
}

// =====================
// GET CART
// =====================
async function getCart(req, res) {
  const cart = await getOrCreateCart(req.user._id);

  const items = await CartItem.find({ idCart: cart._id }).sort({ _id: 1 })
    .populate({ path: "idProductVariant", populate: { path: "idProduct" } }).lean();
  for (const item of items) {
    item.availability = availability(item.idProductVariant, item.idProductVariant?.idProduct, item.quantity);
  }

  let checkout;
  try {
    checkout = checkoutQuote(cart, items);
  } catch (error) {
    if (!error.status) throw error;
    checkout = { code: error.code, message: error.message, itemId: error.itemId };
  }
  const unavailable = items.filter(item => !item.availability.available);
  if (unavailable.length) checkout = { code: "CART_UNAVAILABLE", message: "Giỏ có sản phẩm không còn khả dụng. Vui lòng kiểm tra các dòng được đánh dấu.",
    issues: unavailable.map(item => ({ itemId: String(item._id), ...item.availability })) };
  res.json({ cart, items, checkout, paymentMethods: req.app.locals.paymentMethods || ["COD"] });
}

// =====================
// ADD TO CART
// =====================
async function addToCart(req, res) {
  try {
  const { idProductVariant, quantity } = req.body;
  await ensureCatalogReady();
  await ensureCheckoutReady();
  const cart = await getOrCreateCart(req.user._id);
  let item;
  // A first-upsert unique-key race retries the entire aborted transaction.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      item = await mongoose.connection.transaction(async session => {
        const variant = await ProductVariant.findById(idProductVariant).session(session)
          .populate({ path: "idProduct", options: { session } });
        const state = availability(variant, variant?.idProduct);
        if (!state.available) throw unavailableError(state);
        await ProductVariant.updateOne({ _id: variant._id, ...activeCatalog },
          { $inc: { catalogRevision: 1 } }, { session });
        const result = await CartItem.findOneAndUpdate({ idCart: cart._id, idProductVariant },
          { $inc: { quantity, __v: 1 } }, { upsert: true, returnDocument: "after", session, setDefaultsOnInsert: false });
        if (!Number.isSafeInteger(result.quantity) || result.quantity < 1) {
          throw Object.assign(new Error("Số lượng trong giỏ không hợp lệ"), { status: 400, code: "INVALID_QUANTITY" });
        }
        return result;
      });
      break;
    } catch (error) {
      if (error.code !== 11000 || attempt === 2) throw error;
    }
  }
  res.json(item);
  } catch (error) { catalogError(res, error); }
}

// =====================
// UPDATE CART ITEM
// =====================
async function updateCartItem(req, res) {
  const { idItem, quantity } = req.body;

  const cart = await Cart.findOne({ idUser: req.user._id });
  const item = cart && await CartItem.findOneAndUpdate(
    { _id: idItem, idCart: cart._id }, { $set: { quantity }, $inc: { __v: 1 } }, { returnDocument: "after", runValidators: true }
  );

  if (!item) {
    return res.status(404).json({ message: "Item không tồn tại" });
  }

  res.json(item);
}

// =====================
// REMOVE ITEM
// =====================
async function removeCartItem(req, res) {
  const cart = await Cart.findOne({ idUser: req.user._id });
  const item = cart && await CartItem.findOneAndDelete({ _id: req.params.id, idCart: cart._id });

  if (!item) {
    return res.status(404).json({ message: "Item không tồn tại" });
  }

  res.json({ message: "Đã xóa sản phẩm khỏi giỏ" });
}

module.exports = {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
};
