const mongoose = require("mongoose");
const ProductVariant = require("../models/ProductVariant");
const Product = require("../models/Product");
const ensureCatalogReady = require("../utils/catalogReady");
const ensureCheckoutReady = require("../utils/checkoutReady");
const { activeCatalog, catalogError } = require("../utils/catalog");

async function createVariant(req, res) {
  try {
    await ensureCatalogReady();
    await ensureCheckoutReady();
    const { idProduct, size, color, price, stock } = req.body;
    const variant = await mongoose.connection.transaction(async session => {
      // Serialize creation with parent archival; never create a child after archival.
      const product = await Product.findOneAndUpdate({ _id: idProduct, ...activeCatalog },
        { $inc: { catalogRevision: 1 } }, { session, returnDocument: "after" });
      if (!product) throw Object.assign(new Error("Sản phẩm không tồn tại hoặc đã ngừng bán"),
        { status: 409, code: "PRODUCT_UNAVAILABLE" });
      const [created] = await ProductVariant.create([{ idProduct, size, color, price, stock }], { session });
      return created;
    });
    res.status(201).json(variant);
  } catch (error) { catalogError(res, error); }
}

async function updateVariant(req, res) {
  try {
    await ensureCatalogReady();
    const changes = Object.fromEntries(["size", "color", "price"]
      .filter(key => Object.hasOwn(req.body, key)).map(key => [key, req.body[key]]));
    const variant = await ProductVariant.findByIdAndUpdate(req.params.id, { $set: changes },
      { returnDocument: "after", runValidators: true });
    if (!variant) return res.status(404).json({ message: "Không tìm thấy variant" });
    res.json(variant);
  } catch (error) { catalogError(res, error); }
}

async function adjustStock(req, res) {
  try {
    const { stock, expectedStock, expectedVersion } = req.body;
    // Legacy rows without a version start at zero. Every stock writer increments it.
    const version = expectedVersion === 0
      ? { $or: [{ inventoryVersion: 0 }, { inventoryVersion: { $exists: false } }] }
      : { inventoryVersion: expectedVersion };
    const variant = await ProductVariant.findOneAndUpdate(
      { _id: req.params.id, stock: expectedStock, ...version },
      { $set: { stock }, $inc: { inventoryVersion: 1 } },
      { returnDocument: "after", runValidators: true }
    );
    if (!variant) {
      if (!await ProductVariant.exists({ _id: req.params.id })) {
        return res.status(404).json({ message: "Không tìm thấy variant" });
      }
      return res.status(409).json({ code: "INVENTORY_CHANGED",
        message: "Tồn kho đã thay đổi. Vui lòng tải lại và kiểm tra trước khi điều chỉnh." });
    }
    res.json(variant);
  } catch (error) { catalogError(res, error); }
}

async function deleteVariant(req, res) {
  try {
    // Keep the original archive time on retries, and keep all references/images.
    const variant = await ProductVariant.findById(req.params.id);
    if (!variant) return res.status(404).json({ message: "Không tìm thấy variant" });
    await ProductVariant.updateOne({ _id: variant._id, ...activeCatalog }, { $set: { archivedAt: new Date() } });
    res.json({ message: "Đã ngừng bán biến thể" });
  } catch (error) { catalogError(res, error); }
}

module.exports = { createVariant, updateVariant, adjustStock, deleteVariant };
