const mongoose = require("mongoose");
module.exports = async function connectDB(uri = process.env.MONGO_URI) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
    await require("../utils/checkoutReady")();
    await require("../utils/catalogReady")();
    await require("../utils/paymentReady")();
    await require("../utils/messageReady")();
    for (const name of mongoose.modelNames()) await mongoose.model(name).createIndexes();
    return mongoose.connection;
  } catch (error) {
    await mongoose.disconnect();
    throw new Error(error.code === "CHECKOUT_UNAVAILABLE"
      ? "MongoDB replica set/mongos and checkout indexes are required; standalone is unsupported"
      : "Database startup failed: connection or required indexes unavailable", { cause: error });
  }
};
