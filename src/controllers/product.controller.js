const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const slugify = require("slugify");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const Category = require("../models/Category");
const ensureCheckoutReady = require("../utils/checkoutReady");
const { activeCatalog, normalizeSize, normalizeColor, catalogError } = require("../utils/catalog");

const invalid = message => Object.assign(new Error(message), { status: 400, code: "INVALID_PRODUCT" });
function stringArray(value, field) {
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { throw invalid(field + " không hợp lệ"); }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) throw invalid(field + " không hợp lệ");
  return parsed;
}
async function productFields(body) {
  const fields = Object.fromEntries(["nameProduct", "description", "idCategory"]
    .filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  if (fields.idCategory && !await Category.exists({ _id: fields.idCategory })) throw invalid("Danh mục không tồn tại");
  for (const field of ["selectedTags", "customTags"]) {
    if (Object.hasOwn(body, field)) fields[field] = stringArray(body[field], field);
  }
  return fields;
}
async function uniqueSlug(name, id) {
  const slug = slugify(name, { lower: true, strict: true }) || "product";
  return await Product.exists({ slug, ...(id ? { _id: { $ne: id } } : {}) }) ? slug + "-" + randomUUID() : slug;
}

async function createProduct(req, res) {
  try {
    if (!req.files?.length) throw invalid("Phải có ít nhất 1 ảnh");
    const fields = await productFields(req.body);
    res.status(201).json(await Product.create({ ...fields, images: req.files.map(file => file.path),
      slug: await uniqueSlug(fields.nameProduct) }));
  } catch (error) { catalogError(res, error); }
}

async function updateProduct(req, res) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Không tìm thấy sản phẩm" });
    const fields = await productFields(req.body);
    if (Object.hasOwn(fields, "nameProduct")) fields.slug = await uniqueSlug(fields.nameProduct, product._id);
    if (Object.hasOwn(req.body, "oldImages") || req.files?.length) {
      const oldImages = Object.hasOwn(req.body, "oldImages") ? stringArray(req.body.oldImages, "oldImages") : product.images;
      if (oldImages.some(image => !product.images.includes(image))) throw invalid("Ảnh cũ không thuộc sản phẩm");
      fields.images = [...oldImages, ...(req.files || []).map(file => file.path)];
      if (!fields.images.length) throw invalid("Phải có ít nhất 1 ảnh");
    }
    const updated = await Product.findByIdAndUpdate(product._id, { $set: fields }, { returnDocument: "after", runValidators: true });
    res.json(updated);
  } catch (error) { catalogError(res, error); }
}

async function getProducts(req, res) {
  try {
    // Only the authenticated admin route can set this flag; public query params cannot.
    const admin = res.locals.catalogAdmin === true;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 40));
    const { size, color, category, price, sort, search } = req.query;
    const pipeline = [
      { $match: admin ? {} : activeCatalog },
      { $lookup: { from: "productvariants", localField: "_id", foreignField: "idProduct",
        pipeline: admin ? [] : [{ $match: activeCatalog }], as: "variants" } },
      { $lookup: { from: "categories", localField: "idCategory", foreignField: "_id", as: "category" } },
      { $addFields: { category: { $arrayElemAt: ["$category", 0] },
        minPrice: { $min: "$variants.price" }, totalStock: { $sum: "$variants.stock" } } }
    ];
    if (search) {
      const literal = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pipeline.push({ $match: { $or: ["nameProduct", "description", "slug"].map(key =>
        ({ [key]: { $regex: literal, $options: "i" } })) } });
    }
    const attributes = { ...(size ? { size: normalizeSize(size) } : {}), ...(color ? { color: normalizeColor(color) } : {}) };
    if (Object.keys(attributes).length) pipeline.push({ $match: { variants: { $elemMatch: attributes } } });
    const prices = { "0-200": { $lte: 200000 }, "200-400": { $gt: 200000, $lte: 400000 },
      "400-600": { $gt: 400000, $lte: 600000 }, "600+": { $gt: 600000 } };
    if (prices[price]) pipeline.push({ $match: { minPrice: prices[price] } });
    if (category) pipeline.push({ $match: { "category.nameCategory": category } });
    const [count] = await Product.aggregate([...pipeline, { $count: "total" }]);
    const sortFields = sort === "price_asc" ? { minPrice: 1, _id: 1 } : sort === "price_desc"
      ? { minPrice: -1, _id: 1 } : { createdAt: -1, _id: 1 };
    const products = await Product.aggregate([...pipeline, { $sort: sortFields }, { $skip: (page - 1) * limit }, { $limit: limit }]);
    const total = count?.total || 0;
    res.json({ products, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) { catalogError(res, error); }
}

async function getProductsByCategory(req, res) {
  try {
    res.json(await Product.find({ idCategory: req.params.categoryId, ...activeCatalog }).populate("idCategory"));
  } catch (error) { catalogError(res, error); }
}

async function getProductByParam(req, res) {
  try {
    const { param } = req.params;
    const filter = res.locals.catalogAdmin === true ? {} : activeCatalog;
    let product;
    if (mongoose.isObjectIdOrHexString(param)) product = await Product.findOne({ _id: param, ...filter }).populate("idCategory");
    if (!product) product = await Product.findOne({ slug: param, ...filter }).populate("idCategory");
    if (!product) return res.status(404).json({ message: "Không tìm thấy sản phẩm" });
    const variants = await ProductVariant.find({ idProduct: product._id, ...filter });
    res.json({ product, variants });
  } catch (error) { catalogError(res, error); }
}

async function deleteProduct(req, res) {
  try {
    await ensureCheckoutReady();
    await mongoose.connection.transaction(async session => {
      const product = await Product.findById(req.params.id).session(session);
      if (!product) throw Object.assign(new Error("Không tìm thấy sản phẩm"), { status: 404, code: "PRODUCT_NOT_FOUND" });
      const archivedAt = product.archivedAt || new Date();
      await Product.updateOne({ _id: product._id }, { $set: { archivedAt }, $inc: { catalogRevision: 1 } }, { session });
      // Stock/cart writes touch these same documents, preventing stale purchases in a race.
      await ProductVariant.updateMany({ idProduct: product._id, ...activeCatalog }, { $set: { archivedAt } }, { session });
    });
    res.json({ message: "Đã ngừng bán sản phẩm và các biến thể" });
  } catch (error) { catalogError(res, error); }
}

async function getFilters(req, res) {
  try {
    const products = await Product.find(activeCatalog).select("_id").lean();
    const filter = { ...activeCatalog, idProduct: { $in: products.map(product => product._id) } };
    const sizes = await ProductVariant.distinct("size", filter);
    const colors = await ProductVariant.distinct("color", filter);
    const categories = await Product.aggregate([{ $match: activeCatalog },
      { $lookup: { from: "categories", localField: "idCategory", foreignField: "_id", as: "category" } },
      { $unwind: "$category" }, { $group: { _id: "$category.nameCategory" } }]);
    res.json({ sizes: sizes.filter(Boolean), colors: colors.filter(Boolean), categories: categories.map(category => category._id) });
  } catch (error) { catalogError(res, error); }
}

module.exports = { createProduct, updateProduct, getProducts, getProductsByCategory,
  getProductByParam, deleteProduct, getFilters };
