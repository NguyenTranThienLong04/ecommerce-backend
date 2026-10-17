const router = require("express").Router();
const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const service = require("../services/notification.service");
router.use(require("../middlewares/auth.middleware"));
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!["USER", "ADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Không có quyền truy cập" });
  // Scope is optional, but an explicitly requested admin inbox requires DB admin authorization.
  if (req.query.scope === "admin" && req.user.role !== "ADMIN") return res.status(403).json({ message: "Không có quyền truy cập" });
  next();
});
const handle = work => async (req, res) => {
  try { await work(req, res); }
  catch { res.status(503).json({ message: "Không tải được thông báo. Vui lòng thử lại." }); }
};
router.get("/", handle(async (req, res) => {
  const { limit = "20", before } = req.query;
  if (typeof limit !== "string" || !/^\d{1,2}$/.test(limit) || +limit < 1 || +limit > 50) {
    return res.status(400).json({ message: "Số lượng không hợp lệ (1–50)" });
  }
  let cursor;
  if (before !== undefined) {
    try {
      if (typeof before !== "string" || before.length > 200) throw new Error();
      const data = JSON.parse(Buffer.from(before, "base64url").toString("utf8"));
      if (!mongoose.isObjectIdOrHexString(data.id) || typeof data.at !== "string" || !Number.isFinite(Date.parse(data.at))) throw new Error();
      cursor = { _id: new mongoose.Types.ObjectId(data.id), createdAt: new Date(data.at) };
    } catch { return res.status(400).json({ message: "Trang thông báo không hợp lệ" }); }
  }
  const page = cursor ? [{ $match: { $or: [{ createdAt: { $lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } }] : [];
  const [snapshot] = await Notification.aggregate([
    { $match: service.identity(req.user) },
    { $sort: { createdAt: -1, _id: -1 } },
    { $facet: { items: [...page, { $limit: +limit + 1 }, { $project: Object.fromEntries(service.publicFields.split(" ").map(key => [key, 1])) }],
      unread: [{ $match: { readAt: null } }, { $count: "count" }] } }
  ]).readConcern("snapshot");
  const items = snapshot.items.slice(0, +limit), last = items.at(-1);
  const nextCursor = snapshot.items.length > +limit
    ? Buffer.from(JSON.stringify({ id: String(last._id), at: last.createdAt.toISOString() })).toString("base64url") : null;
  res.json({ items, unreadCount: snapshot.unread[0]?.count || 0, nextCursor });
}));
router.patch("/read-all", handle(async (req, res) => {
  const result = await Notification.updateMany({ ...service.identity(req.user), readAt: null }, { $set: { readAt: new Date() } });
  await service.changed(req.user);
  res.json({ modifiedCount: result.modifiedCount });
}));
router.patch("/:id/read", handle(async (req, res) => {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ message: "ID không hợp lệ" });
  const filter = { ...service.identity(req.user), _id: req.params.id };
  // Conditional write preserves the first read timestamp under retries.
  await Notification.updateOne({ ...filter, readAt: null }, { $set: { readAt: new Date() } });
  const item = await Notification.findOne(filter).select(service.publicFields).lean();
  if (!item) return res.status(404).json({ message: "Không tìm thấy thông báo" });
  await service.changed(req.user);
  res.json({ item });
}));
module.exports = router;
