const assert = require("node:assert/strict");
(async () => {
  const api = "http://127.0.0.1:5000", frontend = "http://127.0.0.1:3000";
  if (process.argv.includes("--database-down")) {
    assert.equal((await fetch(api + "/health/live", { signal: AbortSignal.timeout(5000) })).status, 200);
    assert.equal((await fetch(api + "/health/ready", { signal: AbortSignal.timeout(5000) })).status, 503);
    console.log("Local Docker outage smoke PASS: live=200, ready=503 with Mongo stopped");
    return;
  }
  // After a real outage the driver's topology monitor needs time to reconnect.
  // Retry only readiness, with a deadline; all business/asset checks still fail fast.
  if (process.argv.includes("--wait")) {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      try { ready = (await fetch(api + "/health/ready", { signal: AbortSignal.timeout(3000) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, "Backend did not recover within 30 seconds of Mongo restart");
  }
  for (const url of [api + "/health/live", api + "/health/ready", frontend + "/health/live", frontend + "/shop", frontend + "/vendor/socket.io.min.js"]) {
    assert.equal((await fetch(url, { signal: AbortSignal.timeout(5000) })).status, 200, url);
  }
  const catalog = await (await fetch(api + "/api/products")).json();
  assert.equal(catalog.total, 3, "Seed must produce exactly three demo products even after rerun/restart");
  const login = await fetch(api + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user@demo.example.com", password: process.env.DEMO_PASSWORD || "LocalDemo123!" }) });
  assert.equal(login.status, 200);
  console.log("Local Docker smoke PASS: readiness, catalog, login and frontend assets");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
