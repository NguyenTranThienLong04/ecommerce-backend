// Standalone investigation only. Does not import/start the app or connect Mongoose.
// Usage: node scripts/diagnose-db-readonly.js [--env-file=.env] [--dns-server=1.1.1.1]
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const { normalizeSize, normalizeColor } = require("../src/utils/catalog");

const envFile = process.argv.find(arg => arg.startsWith("--env-file="))?.slice(11);
const env = envFile ? dotenv.parse(fs.readFileSync(envFile)) : process.env;
const uri = env.MONGO_URI;
const dnsServer = process.argv.find(arg => arg.startsWith("--dns-server="))?.slice(13);
if (dnsServer) require("node:dns").promises.setServers([dnsServer]);
const secrets = Object.entries(env).filter(([key]) => /SECRET|PASSWORD|TOKEN|API_KEY|MONGO_URI|CLOUD_NAME|VNP_TMN_CODE/i.test(key))
  .map(([, value]) => value).filter(Boolean);
try {
  const parsed = new URL(uri);
  for (const value of [parsed.username, parsed.password]) if (value) {
    secrets.push(value);
    try { secrets.push(decodeURIComponent(value)); } catch { /* invalid encoding */ }
  }
} catch { /* driver reports invalid URI safely below */ }
function safeError(error) {
  let message = String(error.message || "Unknown error").replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[REDACTED_URI]");
  for (const secret of secrets.sort((a, b) => b.length - a.length)) message = message.split(secret).join("[REDACTED]");
  return { name: error.name, code: error.code, message };
}
function emit(stage, details) { console.log(JSON.stringify({ stage, ...details })); }
function options(index) {
  return { unique: !!index.unique, sparse: !!index.sparse,
    partialFilterExpression: index.partialFilterExpression || null, collation: index.collation || null };
}
function displayKey(collection, key) {
  if (["users", "paymentattempts", "messages", "orders"].includes(collection)) {
    return Object.fromEntries(Object.entries(key).map(([field, value]) => [field,
      typeof value === "string" ? "[REDACTED_STRING]" : value]));
  }
  return key;
}
const stageFor = name => ({ Order: "checkout", Cart: "catalog", CartItem: "catalog",
  ProductVariant: "catalog", Review: "catalog", PaymentAttempt: "payment", Message: "message" }[name] || "remaining-models");

async function main() {
  if (!uri) throw new Error("MONGO_URI is missing; supply process env or --env-file=.env");
  // These settings affect only disconnected schema inspection in this process.
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  for (const file of fs.readdirSync(path.join(__dirname, "../src/models"))) {
    if (file.endsWith(".js")) require(path.join(__dirname, "../src/models", file));
  }
  const client = new mongoose.mongo.MongoClient(uri, {
    serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, monitorCommands: true
  });
  const commands = new Set();
  client.on("commandStarted", event => commands.add(event.commandName));
  let stage = "connect";
  try {
    await client.connect();
    const db = client.db(); // Same URI-selected database; no dbName override.
    emit(stage, { status: "PASS", database: db.databaseName, mongoose: mongoose.version,
      observedAt: new Date().toISOString(), dnsOverride: dnsServer || null });
    stage = "topology";
    const hello = await db.admin().command({ hello: 1 });
    emit(stage, { status: hello.setName || hello.msg === "isdbgrid" ? "PASS" : "FAIL",
      response: { setName: hello.setName, msg: hello.msg, isWritablePrimary: hello.isWritablePrimary,
        logicalSessionTimeoutMinutes: hello.logicalSessionTimeoutMinutes, maxWireVersion: hello.maxWireVersion } });
    stage = "permissions";
    try {
      const result = await db.command({ connectionStatus: 1, showPrivileges: true });
      const privileges = result.authInfo?.authenticatedUserPrivileges || [];
      emit(stage, { status: "PASS", roles: result.authInfo?.authenticatedUserRoles,
        databaseActions: [...new Set(privileges.filter(item => item.resource &&
          (item.resource.db === "" || item.resource.db === db.databaseName) && item.resource.collection === "")
          .flatMap(item => item.actions))].filter(action =>
          ["find", "listCollections", "listIndexes", "createCollection", "createIndex"].includes(action)).sort() });
    } catch (error) { emit(stage, { status: "UNAVAILABLE", error: safeError(error) }); }
    stage = "index-inventory";
    const collections = await db.listCollections({}, { nameOnly: false }).toArray();
    emit("database-collections", { count: collections.length, names: collections.map(item => item.name).sort() });
    for (const name of mongoose.modelNames()) {
      const model = mongoose.model(name), collection = model.collection.name;
      const info = collections.find(item => item.name === collection);
      const actual = info ? await db.collection(collection).listIndexes().toArray() : [];
      const expected = model.schema.indexes().map(([key, opts]) => ({ key, ...opts,
        name: opts.name || Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join("_") }));
      emit(stage, { model: name, collection, helper: stageFor(name), exists: !!info,
        defaultCollation: info?.options?.collation, expected, actual,
        comparison: expected.map(index => {
          const sameName = actual.find(candidate => candidate.name === index.name);
          const sameKeys = actual.filter(candidate => isDeepStrictEqual(Object.entries(candidate.key), Object.entries(index.key)));
          const exact = sameName && isDeepStrictEqual(Object.entries(sameName.key), Object.entries(index.key)) &&
            isDeepStrictEqual(options(sameName), options(index));
          return { index: index.name, status: exact ? "MATCH" : sameName || sameKeys.length ? "REVIEW_CONFLICT" : "MISSING",
            related: [...new Set([sameName?.name, ...sameKeys.map(candidate => candidate.name)].filter(Boolean))] };
        }) });
      for (const index of expected.filter(item => item.unique)) {
        // Null/missing share an index key. Partial filters are copied from the schema.
        const pipeline = [
          ...(index.partialFilterExpression ? [{ $match: index.partialFilterExpression }] : []),
          { $group: { _id: Object.fromEntries(Object.keys(index.key).map(field => [field, { $ifNull: [`$${field}`, null] }])), count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $facet: { summary: [{ $group: { _id: null, groups: { $sum: 1 }, documents: { $sum: "$count" } } }],
            samples: [{ $limit: 10 }] } }
        ];
        const [duplicates] = await db.collection(collection).aggregate(pipeline, {
          maxTimeMS: 20000, allowDiskUse: false, ...(index.collation ? { collation: index.collation } : {})
        }).toArray();
        emit("duplicate-check", { model: name, collection, helper: stageFor(name), index: index.name,
          summary: duplicates?.summary?.[0] || { groups: 0, documents: 0 },
          samples: (duplicates?.samples || []).map(row => ({ key: displayKey(collection, row._id), count: row.count })) });
      }
    }
    stage = "normalized-variant-check";
    const groups = new Map();
    let total = 0, nonCanonical = 0;
    for await (const variant of db.collection("productvariants").find({}, {
      projection: { idProduct: 1, size: 1, color: 1 }, maxTimeMS: 20000
    })) {
      total++;
      const size = normalizeSize(variant.size), color = normalizeColor(variant.color);
      if (size !== variant.size || color !== variant.color) nonCanonical++;
      const key = JSON.stringify({ idProduct: variant.idProduct ?? null, size, color });
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const duplicates = [...groups].filter(([, count]) => count > 1);
    emit(stage, { total, nonCanonical, duplicateGroups: duplicates.length,
      samples: duplicates.slice(0, 10).map(([key, count]) => ({ key: JSON.parse(key), count })) });
  } catch (error) {
    emit(stage, { status: "FAIL", error: safeError(error) });
    process.exitCode = 1;
  } finally {
    await client.close();
    emit("command-audit", { commands: [...commands].sort() });
  }
}
main().catch(error => { emit("diagnostic", { status: "FAIL", error: safeError(error) }); process.exitCode = 1; });
