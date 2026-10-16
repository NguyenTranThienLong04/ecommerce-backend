const mongoose = require("mongoose");
module.exports = async function connectDB(uri = process.env.MONGO_URI) {
  const diagnostic = require("../utils/startupDiagnostic").createDiagnostic(uri);
  try {
    await diagnostic.run("Mongo connect", () => mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 }));
    await diagnostic.run("checkout readiness", () => require("../utils/checkoutReady")(diagnostic));
    await diagnostic.run("catalog readiness", () => require("../utils/catalogReady")(diagnostic));
    await diagnostic.run("payment readiness", () => require("../utils/paymentReady")(diagnostic));
    await diagnostic.run("message readiness", () => require("../utils/messageReady")(diagnostic));
    for (const name of mongoose.modelNames()) {
      const model = mongoose.model(name);
      await diagnostic.run(`createIndexes:${name}/${model.collection.name}`, () => model.createIndexes());
    }
    return mongoose.connection;
  } catch (error) {
    diagnostic.log("database startup", "FAIL", error);
    await mongoose.disconnect();
    throw new Error(error.code === "CHECKOUT_UNAVAILABLE"
      ? "MongoDB replica set/mongos and checkout indexes are required; standalone is unsupported"
      : "Database startup failed: connection or required indexes unavailable", { cause: error });
  }
};
