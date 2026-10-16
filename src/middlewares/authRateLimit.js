const net = require("node:net");

// One in-memory store per app; no shared test/process singleton or background timer.
const policies = Object.freeze({
  "/login": { limit: 60, windowMs: 15 * 60000 },
  "/register": { limit: 20, windowMs: 60 * 60000 }
});
function clientKey(address = "unknown") {
  if (address.startsWith("::ffff:") && net.isIP(address.slice(7)) === 4) return address.slice(7);
  if (net.isIP(address) !== 6) return address;
  // Group IPv6 clients by /64, so rotating interface addresses cannot reset a quota.
  const canonical = new URL("http://[" + address + "]").hostname.slice(1, -1);
  const [head, tail = ""] = canonical.split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const words = canonical.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return words.slice(0, 4).map(word => parseInt(word, 16).toString(16)).join(":") + "::/64";
}
function createAuthRateLimit({ now = Date.now, maxEntries = 10000 } = {}) {
  const buckets = new Map();
  let nextSweep = 0;
  return (req, res, next) => {
    const policy = req.method === "POST" && policies[req.path.toLowerCase().replace(/\/$/, "")];
    if (!policy) return next();
    const at = now();
    if (at >= nextSweep) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= at) buckets.delete(key);
      nextSweep = at + 60000;
    }
    const key = req.path.toLowerCase().replace(/\/$/, "") + ":" + clientKey(req.ip);
    let bucket = buckets.get(key);
    if (bucket?.resetAt <= at) { buckets.delete(key); bucket = null; }
    // Fail closed instead of evicting live quotas if distinct client capacity is exhausted.
    if (!bucket && buckets.size < maxEntries) {
      bucket = { count: 0, resetAt: at + policy.windowMs };
      buckets.set(key, bucket);
    }
    const remaining = bucket ? Math.max(0, policy.limit - ++bucket.count) : 0;
    res.set("RateLimit-Limit", String(policy.limit));
    res.set("RateLimit-Remaining", String(remaining));
    if (!bucket || bucket.count > policy.limit) {
      res.set("Retry-After", String(Math.max(1, Math.ceil(((bucket?.resetAt || nextSweep) - at) / 1000))));
      return res.status(429).json({ code: "AUTH_RATE_LIMITED", message: "Bạn đã thử quá nhiều lần. Vui lòng chờ rồi thử lại." });
    }
    next();
  };
}
module.exports = { createAuthRateLimit, policies, clientKey };
