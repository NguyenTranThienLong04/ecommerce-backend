const crypto = require("node:crypto");
const net = require("node:net");
const { orderError } = require("./orderState");

const ipnError = (rspCode, message, status = 400) => Object.assign(orderError(status, "PAYMENT_CALLBACK_REJECTED", message), { rspCode });
function config(creation = false) {
  const merchant = process.env.VNP_TMN_CODE;
  const secret = process.env.VNP_HASH_SECRET;
  if (!merchant || !secret) throw orderError(503, "PAYMENT_UNAVAILABLE", "Chưa cấu hình VNPay");
  const settings = { merchant, secret };
  if (creation) {
    for (const [key, env] of [["payUrl", "VNP_URL"], ["returnUrl", "VNP_RETURN_URL"], ["resultUrl", "VNP_RESULT_URL"]]) {
      try {
        const url = new URL(process.env[env]);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        settings[key] = url.href;
      } catch { throw orderError(503, "PAYMENT_UNAVAILABLE", "Cấu hình URL VNPay chưa hợp lệ"); }
    }
  }
  return settings;
}
const encode = value => encodeURIComponent(String(value)).replace(/%20/g, "+");
const canonical = params => Object.keys(params).sort().map(key => encode(key) + "=" + encode(params[key])).join("&");
const sign = (params, secret) => crypto.createHmac("sha512", secret).update(canonical(params)).digest("hex");
const formatDate = date => new Date(date.getTime() + 7 * 3600000).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const orderInfo = attempt => `Thanh toan don hang ${attempt.orderId} ${attempt.reference}`;

function paymentUrl(attempt, ip, settings) {
  const params = { vnp_Version: "2.1.0", vnp_Command: "pay", vnp_TmnCode: settings.merchant,
    vnp_Amount: attempt.expectedAmount * 100, vnp_CurrCode: "VND", vnp_TxnRef: attempt.reference,
    vnp_OrderInfo: orderInfo(attempt), vnp_OrderType: "other", vnp_Locale: "vn",
    vnp_ReturnUrl: settings.returnUrl, vnp_CreateDate: formatDate(attempt.createdAt),
    vnp_ExpireDate: formatDate(attempt.expiresAt), vnp_IpAddr: net.isIP(ip || "") ? ip : "127.0.0.1" };
  return settings.payUrl + "?" + canonical(params) + "&vnp_SecureHash=" + sign(params, settings.secret);
}

function verifyCallback(query) {
  const settings = config();
  if (!query || Object.keys(query).length > 30 || Object.entries(query).some(([key, value]) =>
    !/^vnp_[A-Za-z0-9_]+$/.test(key) || typeof value !== "string" || value.length > 512)) {
    throw ipnError("99", "Malformed payload");
  }
  const { vnp_SecureHash: hash, vnp_SecureHashType, ...params } = query;
  if (!/^[a-fA-F0-9]{128}$/.test(hash || "") ||
      !crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(sign(params, settings.secret), "hex"))) {
    throw ipnError("97", "Invalid signature");
  }
  if (params.vnp_TmnCode !== settings.merchant) throw ipnError("99", "Merchant mismatch");
  if (!/^[a-zA-Z0-9]{1,100}$/.test(params.vnp_TxnRef || "") ||
      !/^[0-9]{1,12}$/.test(params.vnp_Amount || "") ||
      !/^[0-9]{1,15}$/.test(params.vnp_TransactionNo || "") ||
      !/^[a-zA-Z0-9]{3,20}$/.test(params.vnp_BankCode || "") ||
      typeof params.vnp_OrderInfo !== "string" || params.vnp_OrderInfo.length > 255 ||
      (params.vnp_PayDate !== undefined && !/^[0-9]{14}$/.test(params.vnp_PayDate))) {
    throw ipnError("99", "Malformed payload");
  }
  const code = params.vnp_ResponseCode, state = params.vnp_TransactionStatus;
  const failures = ["09", "10", "11", "12", "13", "24", "51", "65", "75", "79", "99"];
  let outcome;
  if (code === "00" && state === "00" && !/^0+$/.test(params.vnp_TransactionNo)) outcome = "SUCCESS";
  else if (failures.includes(code) && state === "02") outcome = "FAILED";
  // 07 can report money debited but suspected fraud; never silently classify it as failure.
  else if (code === "07" && ["00", "07"].includes(state)) outcome = "REQUIRES_REVIEW";
  else throw ipnError("99", "Invalid provider result/status");
  const result = { reference: params.vnp_TxnRef, amount: Number(params.vnp_Amount), merchant: params.vnp_TmnCode,
    orderInfo: params.vnp_OrderInfo, responseCode: code, transactionStatus: state, outcome,
    providerTransactionNo: params.vnp_TransactionNo, providerPayDate: params.vnp_PayDate };
  result.fingerprint = crypto.createHash("sha256").update(JSON.stringify([
    result.reference, result.amount, code, state, result.providerTransactionNo
  ])).digest("hex");
  return result;
}

module.exports = { config, ipnError, canonical, sign, formatDate, orderInfo, paymentUrl, verifyCallback };
