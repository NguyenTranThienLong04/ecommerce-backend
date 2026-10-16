const payment = require("../services/payment.service");
const reconciliation = require("../services/paymentReconciliation.service");

function sendError(res, error) {
  res.status(error.status || 500).json({ code: error.status ? error.code : "PAYMENT_ERROR",
    message: error.status ? error.message : "Không thể xử lý thanh toán. Vui lòng kiểm tra trạng thái và thử lại" });
}

exports.createPayment = async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await payment.createAttempt(req.user._id, req.body?.orderId, req.body?.idempotencyKey, req.ip, new Date(), req.body));
  } catch (error) { sendError(res, error); }
};
exports.recreatePayment = exports.createPayment; // Only a new logical request/key creates a new attempt.

exports.vnpayIPN = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    res.json(await payment.processIPN(req.query));
  } catch (error) {
    // HTTP 200 with VNPay's JSON contract; 99/timeout permits provider retry.
    res.json({ RspCode: error.rspCode || "99", Message: error.rspCode ? error.message : "Temporary processing error" });
  }
};

exports.vnpayReturn = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.redirect(await payment.returnLocation(req.query)); }
  catch (error) { sendError(res, error); }
};

exports.getPaymentStatus = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await payment.paymentStatus(req.user._id, req.params.reference)); }
  catch (error) { sendError(res, error); }
};

exports.getReconciliation = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await reconciliation(req.query)); }
  catch (error) { sendError(res, error); }
};
