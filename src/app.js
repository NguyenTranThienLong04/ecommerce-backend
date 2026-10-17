const express=require("express");
const cors=require("cors");

const authRoutes=require("./routes/auth.route");
const categoryRoutes=require("./routes/category.route");
const productRoutes=require("./routes/product.route");
const productVariantRoutes=require("./routes/productVariant.route");
const cartRoutes=require("./routes/cart.route");
const orderRoutes=require("./routes/order.route");
const reviewRoutes=require("./routes/review.route");
const userAddressRoutes = require("./routes/userAddress.route");
const userRoutes = require("./routes/user.route");
const chatRoutes = require("./routes/chat.routes");
const bannerRoutes=require("./routes/banner.route");
const vnpayRoutes=require("./routes/vnpay.route");
const adminRoutes = require("./routes/admin.route");
const path = require("path");
module.exports = function createApp(config) {
const app=express();
app.locals.paymentMethods = Object.freeze(config.vnpayEnabled ? ["COD", "VNPAY"] : ["COD"]);
app.set("trust proxy", config.trustProxy || false);

app.use(cors({ origin: config.frontendOrigin }));
// Run before body parsing/bcrypt; other endpoints (including IPN) have no auth quota.
app.use("/api/auth", require("./middlewares/authRateLimit").createAuthRateLimit());
app.get("/health/live", (req, res) => res.json({ status: "live" }));
app.get("/health/ready", async (req, res) => {
  try {
    const connection = require("mongoose").connection;
    if (connection.readyState !== 1) throw new Error();
    const hello = await connection.db.admin().command({ hello: 1 }, { timeoutMS: 2000 });
    if ((!hello.isWritablePrimary && hello.msg !== "isdbgrid") || (!hello.setName && hello.msg !== "isdbgrid")) throw new Error();
    res.json({ status: "ready" });
  } catch { res.status(503).json({ status: "not_ready" }); }
});
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({extended:true, limit: "20mb"}));
app.use("/uploads", express.static(path.join(__dirname,"uploads")));


app.use("/api/auth",authRoutes);
app.use("/api/categories",categoryRoutes);
app.use("/api/variants",productVariantRoutes);
app.use("/api/cart",cartRoutes);
app.use("/api/orders",orderRoutes);
app.use("/api/reviews",reviewRoutes);
app.use("/api/products",productRoutes);
app.use("/api/addresses", userAddressRoutes);
app.use("/api/users", userRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/notifications", require("./routes/notification.route"));
app.use("/api/banners",bannerRoutes);
app.use("/api/vnpay", (req, res, next) => config.vnpayEnabled ? next()
  : res.status(503).json({ message: "VNPay is disabled in this environment" }), vnpayRoutes);
app.use("/api/admin", adminRoutes);
app.get("/",(req,res)=>{
    res.send("API is running...");
});
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status === 503 ? 503 : error.code === "LIMIT_FILE_SIZE" ? 400 : 500;
  res.status(status).json({ message: status === 503 ? "Image uploads are unavailable" : status === 400 ? "File too large" : "Request failed" });
});
return app;
};
