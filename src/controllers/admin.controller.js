const Product = require("../models/Product");
const Order = require("../models/Order");
const User = require("../models/User");
const OrderItem = require("../models/OrderItem");
const ProductVariant = require("../models/ProductVariant");

// Revenue is collected order total (including shipping), only for completed paid orders.
const revenueOrders = { status: "DONE", paymentStatus: "PAID", paymentReviewRequired: { $ne: true } };

// ================= DASHBOARD =================
exports.getDashboard = async (req, res) => {
  try {
    const [
      totalProducts,
      totalUsers,
      totalOrders,
      revenueResult,
      statusStats
    ] = await Promise.all([
      Product.countDocuments(),
      User.countDocuments(),
      Order.countDocuments(),

      Order.aggregate([
        { $match: revenueOrders },
        {
          $group: {
            _id: null,
            totalRevenue: {
              $sum: "$total"
            }
          }
        }
      ]),

      Order.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    const revenue = revenueResult[0]?.totalRevenue || 0;

    const statusMap = {
      PENDING: 0,
      CONFIRMED: 0,
      SHIPPING: 0,
      DONE: 0,
      CANCEL: 0
    };

    statusStats.forEach(item => {
      statusMap[item._id] = item.count;
    });

    res.json({
      totalProducts,
      totalUsers,
      totalOrders,
      revenue,
      statusStats: statusMap
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ================= REVENUE BY DATE =================
exports.getRevenueByDate = async (req, res) => {
  try {
    const { month, year } = req.query;

    let match = { ...revenueOrders };

    if (month && year) {
      match.createdAt = {
        $gte: new Date(year, month - 1, 1),
        $lt: new Date(year, month, 1)
      };
    }

    const data = await Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            day: { $dayOfMonth: "$createdAt" }
          },
          revenue: {
            $sum: "$total"
          }
        }
      },
      { $sort: { "_id.day": 1 } }
    ]);

    const result = data.map(item => ({
      date: `Day ${item._id.day}`,
      revenue: item.revenue
    }));

    res.json(result);

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ================= TOP PRODUCTS =================
exports.getTopProducts = async (req, res) => {
  try {
    const data = await OrderItem.aggregate([
      { $lookup: { from: Order.collection.name, localField: "idOrder", foreignField: "_id", as: "order" } },
      { $unwind: "$order" },
      { $match: { "order.status": revenueOrders.status, "order.paymentStatus": revenueOrders.paymentStatus,
        "order.paymentReviewRequired": { $ne: true } } },
      { $lookup: { from: ProductVariant.collection.name, localField: "idProductVariant", foreignField: "_id", as: "variant" } },
      { $unwind: "$variant" },
      {
        $group: {
          _id: "$variant.idProduct",
          totalSold: { $sum: "$quantity" },
          revenue: { $sum: { $multiply: ["$price", "$quantity"] } }
        }
      },
      { $sort: { totalSold: -1, _id: 1 } },
      { $limit: 5 },
      { $lookup: { from: Product.collection.name, localField: "_id", foreignField: "_id", as: "product" } },
      { $project: { totalSold: 1, revenue: 1, nameProduct: { $arrayElemAt: ["$product.nameProduct", 0] } } }
    ]);

    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ================= TOP USERS =================
exports.getTopUsers = async (req, res) => {
  try {
    const data = await Order.aggregate([
      { $match: revenueOrders },
      {
        $group: {
          _id: "$idUser",
          totalSpent: { $sum: "$total" }
        }
      },
      { $sort: { totalSpent: -1 } },
      { $limit: 5 }
    ]);

    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
