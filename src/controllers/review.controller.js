const Review = require("../models/Review");
const Order = require("../models/Order");
const OrderItem = require("../models/OrderItem");
const ProductVariant = require("../models/ProductVariant");
const ensureCatalogReady = require("../utils/catalogReady");
const { catalogError } = require("../utils/catalog");

async function createReview(req, res) {
  try {
    const { idOrderItem, rating, comment } = req.body;
    const orderItem = await OrderItem.findById(idOrderItem);
    if (!orderItem) return res.status(404).json({ message: "Order item không tồn tại" });
    const order = await Order.findById(orderItem.idOrder);
    if (!order) return res.status(404).json({ message: "Đơn hàng không tồn tại" });
    if (String(order.idUser) !== String(req.user._id)) return res.status(403).json({ message: "Không có quyền đánh giá" });
    if (order.status !== "DONE") return res.status(400).json({ message: "Đơn hàng chưa hoàn tất" });
    // DONE is terminal. Archived variants remain reviewable; broken legacy references do not create new orphans.
    const variant = await ProductVariant.findById(orderItem.idProductVariant).populate("idProduct");
    if (!variant?.idProduct) return res.status(409).json({ message: "Dữ liệu sản phẩm của đơn hàng không còn đầy đủ" });
    await ensureCatalogReady();
    const review = await Review.create({ idUser: req.user._id, idProductVariant: variant._id, idOrderItem, rating, comment });
    res.status(201).json(review);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ code: "REVIEW_EXISTS", message: "Bạn đã đánh giá sản phẩm này rồi" });
    catalogError(res, error);
  }
}

async function getReviewsByVariant(req, res) {
  const reviews = await Review.find({ idProductVariant: req.params.idVariant, status: "VISIBLE" }).populate("idUser", "name");
  res.json(reviews);
}

async function updateReview(req, res) {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ message: "Review không tồn tại" });
    if (String(review.idUser) !== String(req.user._id)) return res.status(403).json({ message: "Không có quyền sửa review" });
    const fields = Object.fromEntries(["rating", "comment"].filter(key => Object.hasOwn(req.body, key)).map(key => [key, req.body[key]]));
    res.json(await Review.findByIdAndUpdate(review._id, { $set: fields }, { returnDocument: "after", runValidators: true }));
  } catch (error) { catalogError(res, error); }
}

async function updateReviewStatus(req, res) {
  try {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Không có quyền" });
    const review = await Review.findByIdAndUpdate(req.params.id, { $set: { status: req.body.status } }, { returnDocument: "after", runValidators: true });
    if (!review) return res.status(404).json({ message: "Review không tồn tại" });
    res.json(review);
  } catch (error) { catalogError(res, error); }
}
module.exports = { createReview, getReviewsByVariant, updateReview, updateReviewStatus };
