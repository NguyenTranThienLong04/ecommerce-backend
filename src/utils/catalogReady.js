const mongoose = require("mongoose");
const models = [require("../models/Cart"), require("../models/CartItem"),
  require("../models/ProductVariant"), require("../models/Review")];
const { createDiagnostic } = require("./startupDiagnostic");
const ready = new WeakMap();

module.exports = function ensureCatalogReady(diagnostic = createDiagnostic(process.env.MONGO_URI)) {
  const client = mongoose.connection.getClient();
  if (!client || mongoose.connection.readyState !== 1) throw new Error("Database not connected");
  if (!ready.has(client)) {
    const check = (async () => {
      try {
        for (const model of models) await diagnostic.run(`catalog createIndexes:${model.modelName}/${model.collection.name}`, () => model.createIndexes());
      } catch (error) {
        throw diagnostic.withCause(Object.assign(new Error("Catalog cần unique indexes; kiểm tra dữ liệu trùng trước khi khởi động"),
          { status: 503, code: "CATALOG_UNAVAILABLE" }), error);
      }
    })();
    ready.set(client, check);
    check.catch(() => ready.delete(client));
  }
  return ready.get(client);
};
