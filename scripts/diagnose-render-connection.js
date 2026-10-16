// Read-only Render connection probe. No app/models, HTTP listener, or index writes.
const { MongoClient } = require("mongoose").mongo;
const uri = process.env.MONGO_URI;
const secrets = Object.entries(process.env)
  .filter(([key]) => /SECRET|PASSWORD|TOKEN|API_KEY|MONGO_URI|CLOUD_NAME|VNP_TMN_CODE/i.test(key))
  .map(([, value]) => value).filter(Boolean);
try {
  const parsed = new URL(uri);
  for (const value of [parsed.username, parsed.password]) if (value) {
    secrets.push(value);
    try { secrets.push(decodeURIComponent(value)); } catch {}
  }
} catch {}
function redact(value) {
  let message = String(value ?? "").replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[REDACTED_URI]");
  for (const secret of secrets.sort((a, b) => b.length - a.length)) message = message.split(secret).join("[REDACTED]");
  return message;
}
function errorLog(stage, error) {
  console.log(JSON.stringify({ stage, name: redact(error.name), code: redact(error.code), message: redact(error.message) }));
}
async function probe() {
  let client, stage = "connect";
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
    await client.connect();
    console.log(JSON.stringify({ stage, status: "PASS", database: client.db().databaseName }));
    stage = "topology";
    const hello = await client.db().admin().command({ hello: 1 });
    console.log(JSON.stringify({ stage, status: hello.setName || hello.msg === "isdbgrid" ? "PASS" : "FAIL",
      setName: hello.setName, msg: hello.msg, isWritablePrimary: hello.isWritablePrimary }));
  } catch (error) {
    errorLog(stage, error);
    for (const server of error.reason?.servers?.values?.() || []) if (server.error) errorLog(stage + "/server", server.error);
    if (error.cause) errorLog(stage + "/cause", error.cause);
  } finally { await client?.close(); }
  // This probe intentionally does not start the service or claim readiness.
  console.log("READ_ONLY_PROBE_COMPLETE; restore the original Start Command after capturing logs");
}
probe().catch(error => { errorLog("probe", error); process.exitCode = 1; });
