const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema({
  idOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order"
  },
  idProductVariant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProductVariant"
  },
  quantity: Number,
  price: Number,
  // Display-only purchase facts; price and quantity above are already snapshots.
  productSnapshot: {
    type: new mongoose.Schema({ nameProduct: String, size: String, color: String, image: String }, { _id: false }),
    default: undefined,
    immutable: true
  }
}, { timestamps: true });

module.exports = mongoose.model("OrderItem", orderItemSchema);
