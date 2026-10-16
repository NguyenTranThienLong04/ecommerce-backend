const express = require("express");
const router = express.Router();

const controller = require("../controllers/productVariant.controller");
const validate = require("../middlewares/validate.middleware");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware=require("../middlewares/admin.middleware");
const {
  createVariantSchema,
  updateVariantSchema,
  adjustStockSchema,
} = require("../validators/productVariant.validate");

// CREATE
router.post("/", authMiddleware,adminMiddleware,validate(createVariantSchema), controller.createVariant);

// UPDATE
router.patch("/:id", authMiddleware,adminMiddleware,validate(updateVariantSchema), controller.updateVariant);
router.patch("/:id/stock", authMiddleware,adminMiddleware,validate(adjustStockSchema), controller.adjustStock);

// DELETE (có thể thêm validate nếu muốn)
router.delete("/:id", authMiddleware,adminMiddleware,controller.deleteVariant);

module.exports = router;
