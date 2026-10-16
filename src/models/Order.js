const mongoose=require('mongoose');
const { ORDER_STATUSES } = require("../utils/orderState");

const orderSchema=new mongoose.Schema({
    idUser:{
        type: mongoose.Schema.Types.ObjectId,
        ref:"User",
    },
    receiverName:String,
    phone:String,
    addressLine:String,
    ward:String,
    district:String,
    city:String,
    shippingMethod:String,
    shippingFee:Number,
    subtotal:Number,
    total:Number,
    idCart: { type: mongoose.Schema.Types.ObjectId, ref: "Cart" },
    idempotencyKey: String,
    checkoutSnapshot: String,
    checkoutRequestHash: String,
    inventoryRestoredAt: Date,
    paymentRevision: Number,
    settledPaymentAttempt: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentAttempt" },
    paymentReference: String,
    providerTransactionNo: String,
    paidAt: Date,
    paymentReviewRequired: Boolean,
    statusHistory: [{
      _id: false,
      from: { type: String, enum: ORDER_STATUSES },
      to: { type: String, enum: ORDER_STATUSES },
      actorType: { type: String, enum: ["USER", "ADMIN", "AUTO", "PAYMENT"] },
      actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: Date
    }],
    status:{
    type: String,
    enum: ORDER_STATUSES,
    default: "PENDING"
  },
paymentStatus: {
  type: String,
  enum: ["UNPAID", "PAID"],
  default: "UNPAID"
}

},{timestamps:true});

// Legacy orders without a key are not part of this constraint.
orderSchema.index({ idUser: 1, idempotencyKey: 1 }, {
  unique: true, name: "checkout_user_key_unique",
  partialFilterExpression: { idempotencyKey: { $type: "string" } }
});

module.exports=mongoose.model("Order",orderSchema);
