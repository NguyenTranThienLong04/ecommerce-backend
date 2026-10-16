const net = require("node:net");
module.exports = function configuration(env = process.env) {
  const fail = key => { throw new Error("Invalid or missing configuration: " + key); };
  const mode = env.NODE_ENV || "development";
  if (!["development", "test", "production"].includes(mode)) fail("NODE_ENV");
  if (!/^mongodb(?:\+srv)?:\/\//.test(env.MONGO_URI || "")) fail("MONGO_URI");
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || /^(your_|change|replace)/i.test(env.JWT_SECRET)) fail("JWT_SECRET (at least 32 characters)");
  const port = Number(env.PORT || 5000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("PORT");
  function url(key, origin = false) {
    try {
      const parsed = new URL(env[key]);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash ||
          (origin && parsed.pathname !== "/") || (mode === "production" && parsed.protocol !== "https:")) fail(key);
      return origin ? parsed.origin : parsed.href;
    } catch { fail(key); }
  }
  const frontendOrigin = url("FRONTEND_URL", true);
  // Trust only explicitly named reverse-proxy addresses/subnets, never arbitrary XFF.
  const trustProxy = env.TRUST_PROXY ? env.TRUST_PROXY.split(",").map(value => value.trim()) : false;
  if (trustProxy) for (const entry of trustProxy) {
    const [address, mask, extra] = entry.split("/");
    const family = net.isIP(address);
    if (!family || extra !== undefined || (mask !== undefined &&
        (!/^\d+$/.test(mask) || Number(mask) < 1 || Number(mask) > (family === 4 ? 32 : 128)))) fail("TRUST_PROXY");
  }
  function enabled(key) {
    if (env[key] !== undefined && !["true", "false"].includes(env[key])) fail(key);
    return env[key] === "true";
  }
  const vnpayEnabled = enabled("VNPAY_ENABLED"), cloudinaryEnabled = enabled("CLOUDINARY_ENABLED");
  if (vnpayEnabled) {
    for (const key of ["VNP_TMN_CODE", "VNP_HASH_SECRET"]) if (!env[key]) fail(key);
    for (const key of ["VNP_URL", "VNP_RETURN_URL", "VNP_RESULT_URL"]) url(key);
  }
  if (cloudinaryEnabled) for (const key of ["CLOUD_NAME", "CLOUD_API_KEY", "CLOUD_API_SECRET"]) if (!env[key]) fail(key);
  return Object.freeze({ mode, port, host: env.HOST || "0.0.0.0", mongoUri: env.MONGO_URI, frontendOrigin, vnpayEnabled, cloudinaryEnabled, trustProxy });
};
