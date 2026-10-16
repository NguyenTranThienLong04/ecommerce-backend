const express = require("express");
const router = express.Router();
const vnpayController = require("../controllers/vnpay.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
router.post("/create",authMiddleware, vnpayController.createPayment);
router.get("/return", vnpayController.vnpayReturn);
router.get("/ipn", vnpayController.vnpayIPN);
router.get("/status/:reference", authMiddleware, vnpayController.getPaymentStatus);
router.get("/reconciliation", authMiddleware, adminMiddleware, vnpayController.getReconciliation);
router.post("/recreate", authMiddleware, vnpayController.recreatePayment); // 🔹 thêm route mới
module.exports = router;
