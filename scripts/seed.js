const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const User = require("../src/models/User");
const Category = require("../src/models/Category");
const Product = require("../src/models/Product");
const Variant = require("../src/models/ProductVariant");
const Address = require("../src/models/UserAddress");

async function seedDemo(env = process.env) {
  if (!["development", "test"].includes(env.NODE_ENV) || !/^mongodb:\/\/(localhost|127\.0\.0\.1|mongo):\d+\/(clothing_demo|clothing_e2e)(?:\?|$)/.test(env.MONGO_URI || "")) {
    throw new Error("Demo seed only accepts a local clothing_demo/clothing_e2e database in development/test");
  }
  const password = env.DEMO_PASSWORD;
  if (typeof password !== "string" || password.length < 12) throw new Error("DEMO_PASSWORD must contain at least 12 characters (local/demo only)");
  const hash = await bcrypt.hash(password, 10);
  const users = [];
  for (const role of ["ADMIN", "USER"]) {
    const email = role === "ADMIN" ? "admin@demo.example.com" : "user@demo.example.com";
    users.push(await User.findOneAndUpdate({ email }, { $setOnInsert: { name: role === "ADMIN" ? "Demo Admin" : "Demo Customer",
      email, role, password: hash, phone: "0901234567" } }, { upsert: true, returnDocument: "after" }));
  }
  const category = await Category.findOneAndUpdate({ nameCategory: "Demo Clothing" }, { $setOnInsert: { nameCategory: "Demo Clothing" } }, { upsert: true, returnDocument: "after" });
  for (const [index, name] of ["Everyday Shirt", "Cotton Jacket", "Classic Trousers"].entries()) {
    const slug = "demo-" + name.toLowerCase().replaceAll(" ", "-");
    const product = await Product.findOneAndUpdate({ slug }, { $setOnInsert: { slug, nameProduct: name, idCategory: category._id,
      description: "<p>Local demo catalog item.</p>", images: ["/demo-product.svg"], selectedTags: [], customTags: [] } }, { upsert: true, returnDocument: "after" });
    for (const size of ["M", "L"]) await Variant.updateOne({ idProduct: product._id, size, color: "black" },
      { $setOnInsert: { price: 150000 + index * 50000, stock: 30 } }, { upsert: true });
  }
  await Address.updateOne({ idUser: users[1]._id, addressLine: "1 Demo Street" }, { $setOnInsert: {
    receiverName: "Demo Customer", phone: "0901234567", addressLine: "1 Demo Street", ward: "Demo Ward", district: "Demo District", city: "Ho Chi Minh", isDefault: true
  } }, { upsert: true });
  return { admin: users[0], user: users[1] };
}
module.exports = seedDemo;
if (require.main === module) {
  (async () => {
    // Validate the destination before connecting; never seed a production URI.
    if (process.env.NODE_ENV !== "development" || !/^mongodb:\/\/(localhost|127\.0\.0\.1|mongo):\d+\/clothing_demo(?:\?|$)/.test(process.env.MONGO_URI || "")) throw new Error("Use the local demo environment for seeding");
    await require("../src/config/database")(process.env.MONGO_URI);
    await seedDemo();
    console.log("Demo ready: admin@demo.example.com / user@demo.example.com. Password comes from DEMO_PASSWORD; existing accounts are unchanged.");
  })().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
}
