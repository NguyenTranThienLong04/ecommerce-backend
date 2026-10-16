const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDiagnostic } = require("../src/utils/startupDiagnostic");
const mongoose = require("mongoose");

// Fault injection only: never load .env, open a socket, or initialize a real DB.
mongoose.connection.config.autoCreate = false;
mongoose.connection.config.autoIndex = false;
require("../src/app"); // Register exactly the models imported by server.js.
const connectDB = require("../src/config/database");
const catalogReady = require("../src/utils/catalogReady");
const paymentReady = require("../src/utils/paymentReady");
const messageReady = require("../src/utils/messageReady");
const uri = "mongodb://fixture.invalid/test";
const decode = lines => lines.map(line => JSON.parse(line.slice("[db] ".length)));

test("diagnostic logs whitelist error/cause fields and redact credentials, secrets and duplicate values", async () => {
  for (const connectionUri of [
    "mongodb+srv://sample_user:sample%40password@fixture.invalid/test",
    "mongodb://sample_user:sample%40password@first.invalid:27017,second.invalid:27017/test"
  ]) {
    const env = { DB_STARTUP_DIAGNOSTICS: "true", MONGO_URI: connectionUri,
      JWT_SECRET: "fixture-jwt-secret", VNP_HASH_SECRET: "fixture-vnp-secret",
      CLOUD_API_KEY: "fixture-cloud-key", CLOUD_API_SECRET: "fixture-cloud-secret",
      MONGO_USERNAME: "separate_username", MONGO_PASSWORD: "separate_password" };
    const privateValues = [connectionUri, "sample_user", "sample@password", "sample%40password",
      ...Object.entries(env).filter(([key]) => key !== "DB_STARTUP_DIAGNOSTICS").map(([, value]) => value)];
    const cause = Object.assign(new Error(privateValues.join(" ")), {
      name: "MongoServerError", code: 18, stack: "NEVER_LOG_STACK", extra: "NEVER_LOG_EXTRA"
    });
    const failure = Object.assign(new Error(privateValues.join(" ")), {
      name: "MongoServerSelectionError", code: "AUTH_FAILED", cause, extra: "NEVER_LOG_EXTRA"
    });
    const lines = [], diagnostic = createDiagnostic(connectionUri, env, line => lines.push(line));
    await assert.rejects(diagnostic.run("Mongo connect", async () => { throw failure; }), error => error === failure);
    const log = decode(lines).at(-1);
    assert.deepEqual(Object.keys(log).sort(), ["cause", "code", "message", "name", "stage", "status"]);
    assert.deepEqual(Object.keys(log.cause).sort(), ["code", "message", "name"]);
    assert.equal(log.name, failure.name);
    assert.equal(log.code, "AUTH_FAILED");
    assert.equal(log.cause.name, "MongoServerError");
    assert.equal(log.cause.code, 18);
    diagnostic.log("catalog createIndexes:CartItem/cartitems", "FAIL", Object.assign(new Error(
      "E11000 collection: test.cartitems index: cart_variant_unique dup key: { private: sensitive_duplicate }"
    ), { code: 11000 }));
    const output = lines.join("\n");
    for (const value of [...privateValues, "NEVER_LOG_STACK", "NEVER_LOG_EXTRA", "sensitive_duplicate"])
      assert.ok(!output.includes(value), "diagnostic output must not contain a private value");
    assert.ok(output.includes("cart_variant_unique"));
    assert.equal(decode(lines).at(-1).cause, null);
  }
});

test("disabled logging returns the original promise, synchronous result/error and wrapper unchanged", () => {
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    const lines = [], diagnostic = createDiagnostic(uri, { DB_STARTUP_DIAGNOSTICS: flag }, line => lines.push(line));
    const promise = Promise.resolve(7), error = new Error("original"), wrapper = new Error("wrapper");
    assert.equal(diagnostic.enabled, false);
    assert.equal(diagnostic.run("stage", () => promise), promise);
    assert.equal(diagnostic.run("stage", () => 7), 7);
    assert.throws(() => diagnostic.run("stage", () => { throw error; }), candidate => candidate === error);
    assert.equal(diagnostic.withCause(wrapper, error), wrapper);
    assert.equal(Object.hasOwn(wrapper, "cause"), false);
    diagnostic.log("stage", "FAIL", error);
    assert.deepEqual(lines, []);
  }
});

test("a failing log sink cannot replace an operation's return value or original error", async () => {
  const diagnostic = createDiagnostic(uri, { DB_STARTUP_DIAGNOSTICS: "true" }, () => { throw new Error("sink failure"); });
  const error = new Error("original");
  assert.equal(await diagnostic.run("stage", async () => 42), 42);
  await assert.rejects(diagnostic.run("stage", async () => { throw error; }), candidate => candidate === error);
  assert.throws(() => diagnostic.run("stage", () => { throw error; }), candidate => candidate === error);
});

function fixture(t, flag, failAt, failure, topology = { setName: "fixture-rs" }) {
  const events = [], lines = [], client = {};
  const previousFlag = process.env.DB_STARTUP_DIAGNOSTICS;
  if (flag === undefined) delete process.env.DB_STARTUP_DIAGNOSTICS;
  else process.env.DB_STARTUP_DIAGNOSTICS = flag;
  t.after(() => {
    if (previousFlag === undefined) delete process.env.DB_STARTUP_DIAGNOSTICS;
    else process.env.DB_STARTUP_DIAGNOSTICS = previousFlag;
  });
  function shadow(key, value) {
    const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, key);
    Object.defineProperty(mongoose.connection, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(mongoose.connection, key, descriptor);
      else delete mongoose.connection[key];
    });
  }
  async function operation(name) {
    events.push(name);
    if (name === failAt) throw failure;
  }
  shadow("readyState", 1);
  shadow("db", { admin: () => ({ command: async command => {
    assert.deepEqual(command, { hello: 1 });
    await operation("hello"); return topology;
  } }) });
  t.mock.method(console, "error", line => lines.push(line));
  t.mock.method(mongoose.connection, "getClient", () => client);
  t.mock.method(mongoose, "connect", async (actualUri, options) => {
    assert.equal(actualUri, uri);
    assert.deepEqual(options, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
    await operation("connect"); return mongoose;
  });
  t.mock.method(mongoose, "disconnect", async () => { events.push("disconnect"); });
  for (const name of mongoose.modelNames()) t.mock.method(mongoose.model(name), "createIndexes", () => operation("index:" + name));
  return { events, lines };
}

const pipeline = ["connect", "hello", "index:Order", "index:Cart", "index:CartItem",
  "index:ProductVariant", "index:Review", "index:PaymentAttempt", "index:Message",
  ...mongoose.modelNames().map(name => "index:" + name)];

for (const flag of [undefined, "false", "true"]) {
  test(`startup preserves operation order, cache and every model index with diagnostic=${flag}`, async t => {
    const { events, lines } = fixture(t, flag);
    assert.equal(await connectDB(uri), mongoose.connection);
    assert.deepEqual(events, pipeline);
    if (flag !== "true") return assert.deepEqual(lines, []);
    const logs = decode(lines);
    for (const stage of ["Mongo connect", "hello/topology", "checkout readiness", "catalog readiness",
      "payment readiness", "message readiness", ...mongoose.modelNames().map(name =>
        `createIndexes:${name}/${mongoose.model(name).collection.name}`)]) {
      assert.deepEqual(logs.filter(entry => entry.stage === stage).map(entry => entry.status), ["START", "PASS"]);
    }
    assert.ok(!logs.some(entry => entry.status === "FAIL"));
  });
}

const failures = [
  { at: "connect", stage: "Mongo connect" },
  { at: "hello", stage: "hello/topology", helper: "CHECKOUT_UNAVAILABLE" },
  { at: "index:Order", stage: "checkout createIndexes:Order/orders", helper: "CHECKOUT_UNAVAILABLE" },
  { at: "index:CartItem", stage: "catalog createIndexes:CartItem/cartitems", helper: "CATALOG_UNAVAILABLE" },
  { at: "index:PaymentAttempt", stage: "payment createIndexes:PaymentAttempt/paymentattempts", helper: "PAYMENT_UNAVAILABLE" },
  { at: "index:Message", stage: "message createIndexes:Message/messages" },
  { at: "index:User", stage: "createIndexes:User/users" }
];
for (const flag of ["false", "true"]) for (const scenario of failures) {
  test(`failure at ${scenario.at}, diagnostic=${flag}: preserve fail-fast behavior and error contract`, async t => {
    const failure = new mongoose.mongo.MongoServerError({ errmsg: "Injected Mongo failure", code: 85 });
    const { events, lines } = fixture(t, flag, scenario.at, failure);
    await assert.rejects(connectDB(uri), error => {
      assert.equal(error.message, scenario.helper === "CHECKOUT_UNAVAILABLE"
        ? "MongoDB replica set/mongos and checkout indexes are required; standalone is unsupported"
        : "Database startup failed: connection or required indexes unavailable");
      if (scenario.helper) {
        assert.equal(error.cause.status, 503);
        assert.equal(error.cause.code, scenario.helper);
        if (flag === "true") {
          assert.equal(error.cause.cause, failure);
          assert.equal(Object.getOwnPropertyDescriptor(error.cause, "cause").enumerable, false);
        } else assert.equal(Object.hasOwn(error.cause, "cause"), false);
      } else assert.equal(error.cause, failure);
      return true;
    });
    assert.deepEqual(events, [...pipeline.slice(0, pipeline.indexOf(scenario.at) + 1), "disconnect"]);
    if (flag === "false") return assert.deepEqual(lines, []);
    const logs = decode(lines);
    const original = logs.find(entry => entry.stage === scenario.stage && entry.status === "FAIL");
    assert.equal(original.name, "MongoServerError");
    assert.equal(original.code, 85);
    assert.equal(original.message, failure.message);
    if (scenario.helper) {
      const wrapped = logs.find(entry => entry.code === scenario.helper && entry.status === "FAIL");
      assert.deepEqual(wrapped.cause, { name: failure.name, code: failure.code, message: failure.message });
    }
  });
}

test("diagnostics do not accept standalone topology or reach indexes after rejection", async t => {
  const { events, lines } = fixture(t, "true", undefined, undefined, {});
  await assert.rejects(connectDB(uri), error => {
    assert.equal(error.cause.code, "CHECKOUT_UNAVAILABLE");
    assert.equal(error.cause.cause.message, "Transactions required");
    return true;
  });
  assert.deepEqual(events, ["connect", "hello", "disconnect"]);
  assert.ok(decode(lines).some(entry => entry.stage === "hello/topology" && entry.status === "FAIL"));
});

for (const flag of ["false", "true"]) {
  test(`readiness helpers honor diagnostic env without an injected logger and retain the nested payment cause, mode=${flag}`, async t => {
    const failure = new mongoose.mongo.MongoServerError({ errmsg: "Injected hello failure", code: 13 });
    fixture(t, flag, "hello", failure);
    await assert.rejects(paymentReady(), error => {
      assert.equal(error.code, "PAYMENT_UNAVAILABLE");
      if (flag === "true") {
        assert.equal(error.cause.code, "CHECKOUT_UNAVAILABLE");
        assert.equal(error.cause.cause, failure);
      } else assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    });
  });
  for (const [ready, modelName] of [[catalogReady, "Cart"], [messageReady, "Message"]]) {
    test(`${modelName} readiness still shares pending work and retries a rejected check, mode=${flag}`, async t => {
      const { events } = fixture(t, flag);
      const failure = new mongoose.mongo.MongoServerError({ errmsg: "Injected index failure", code: 11000 });
      let fail = true;
      t.mock.method(mongoose.model(modelName), "createIndexes", async () => {
        events.push("retry:" + modelName);
        if (fail) throw failure;
      });
      const first = ready(), second = ready();
      assert.equal(first, second);
      await assert.rejects(first, error => {
        if (modelName === "Message") assert.equal(error, failure);
        else if (flag === "true") assert.equal(error.cause, failure);
        else assert.equal(Object.hasOwn(error, "cause"), false);
        return true;
      });
      fail = false;
      const retry = ready();
      assert.notEqual(retry, first);
      await retry;
      const afterSuccess = events.length;
      await ready();
      assert.equal(events.length, afterSuccess);
      assert.equal(events.filter(event => event === "retry:" + modelName).length, 2);
    });
  }
}
