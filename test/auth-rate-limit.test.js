const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const createApp = require("../src/app");
const configuration = require("../src/config/env");
const { createAuthRateLimit, policies, clientKey } = require("../src/middlewares/authRateLimit");

async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once("listening", resolve));
  return "http://127.0.0.1:" + server.address().port;
}
const post = (base, route, headers = {}) => fetch(base + route, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}"
});
test("M05: actual app limits only auth writes, includes CORS/Retry-After, ignores untrusted XFF and isolates apps", async t => {
  const settings = { frontendOrigin: "https://shop.test", vnpayEnabled: false };
  const first = await serve(t, createApp(settings));
  for (const route of ["/login", "/register"]) {
    for (let i = 0; i < policies[route].limit; i++) {
      // Joi rejects the intentionally incomplete form before any DB access/bcrypt.
      assert.equal((await post(first, "/api/auth" + route)).status, 400);
    }
    const blocked = await post(first, "/api/auth" + route, { Origin: "https://shop.test", "X-Forwarded-For": "203.0.113.99" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("access-control-allow-origin"), "https://shop.test");
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal((await blocked.json()).code, "AUTH_RATE_LIMITED");
    assert.equal((await post(first, "/api/auth" + route.toUpperCase() + "/")).status, 429);
  }
  assert.equal((await fetch(first + "/health/live")).status, 200);
  assert.equal((await fetch(first + "/api/auth/me")).status, 400);
  const second = await serve(t, createApp(settings));
  assert.equal((await post(second, "/api/auth/login")).status, 400);
});
test("M05: trusted proxy selects the client, quotas are separate and expired windows recover", async t => {
  let time = 1000;
  const app = express();
  app.set("trust proxy", ["127.0.0.1/32"]);
  app.use(createAuthRateLimit({ now: () => time }));
  app.post(["/login", "/register", "/other"], (req, res) => res.json({ ip: req.ip }));
  const base = await serve(t, app), proxy = { "X-Forwarded-For": "203.0.113.7" };
  for (let i = 0; i < policies["/login"].limit; i++) assert.equal((await post(base, "/login", proxy)).status, 200);
  assert.equal((await post(base, "/login", proxy)).status, 429);
  assert.equal((await post(base, "/register", proxy)).status, 200);
  assert.equal((await post(base, "/other", proxy)).status, 200);
  assert.equal((await post(base, "/login", { "X-Forwarded-For": "203.0.113.8" })).status, 200);
  // An extra forged address to the left of the untrusted client cannot change its identity.
  assert.equal((await post(base, "/login", { "X-Forwarded-For": "198.51.100.5, 203.0.113.7" })).status, 429);
  time += policies["/login"].windowMs;
  assert.equal((await post(base, "/login", proxy)).status, 200);
});
test("M05: proxy trust is explicit IP/CIDR configuration, and IPv6 interface rotation shares a /64 budget", () => {
  const env = { MONGO_URI: "mongodb://127.0.0.1/test", JWT_SECRET: "test-only-configuration-secret-123456", FRONTEND_URL: "http://localhost:3000" };
  assert.equal(configuration(env).trustProxy, false);
  assert.deepEqual(configuration({ ...env, TRUST_PROXY: "127.0.0.1/32, ::1/128" }).trustProxy, ["127.0.0.1/32", "::1/128"]);
  for (const TRUST_PROXY of ["true", "1", "0.0.0.0/0", "127.0.0.1/99", "::/0", "example.com", "127.0.0.1,"]) {
    assert.throws(() => configuration({ ...env, TRUST_PROXY }), /TRUST_PROXY/);
  }
  assert.equal(clientKey("::ffff:192.0.2.1"), clientKey("192.0.2.1"));
  assert.equal(clientKey("2001:db8:1:2::1"), clientKey("2001:0db8:0001:0002:1234:5678:9abc:def0"));
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
});
test("M05: bounded storage does not evict live quotas to allow a bypass", async t => {
  let time = 1000;
  const app = express(); app.set("trust proxy", ["127.0.0.1"]);
  app.use(createAuthRateLimit({ now: () => time, maxEntries: 1 }));
  app.post("/login", (req, res) => res.json({ ok: true }));
  const base = await serve(t, app);
  assert.equal((await post(base, "/login", { "X-Forwarded-For": "192.0.2.1" })).status, 200);
  assert.equal((await post(base, "/login", { "X-Forwarded-For": "192.0.2.2" })).status, 429);
  time += policies["/login"].windowMs;
  assert.equal((await post(base, "/login", { "X-Forwarded-For": "192.0.2.2" })).status, 200);
});
