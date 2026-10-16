const Joi = require("joi");
const { ORDER_STATUSES } = require("../utils/orderState");

// 🧾 Tạo đơn hàng
const objectId = Joi.string().hex().length(24).lowercase();
const addressField = rule => rule.trim().when("addressId", {
  is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required()
});
const createOrderSchema = Joi.object({
  body: Joi.object({
    idempotencyKey: Joi.string().pattern(/^[A-Za-z0-9_-]{16,128}$/).required(),
    cartId: objectId.required(),
    cartSnapshot: Joi.string().hex().length(64).lowercase().required(),
    addressId: objectId.optional(),
    receiverName: addressField(Joi.string().min(2).max(100)),
    phone: addressField(Joi.string().pattern(/^[0-9]{9,11}$/)),
    addressLine: addressField(Joi.string().min(5)),
    ward: addressField(Joi.string()),
    district: addressField(Joi.string()),
    city: addressField(Joi.string()),
    shippingMethod: Joi.string().valid("COD", "VNPAY").required()
    // Client price/quantity/subtotal/total/shippingFee are discarded by validation.
  }).required()
});

const updateStatusSchema = Joi.object({
  body: Joi.object({
    status: Joi.string()
      .valid(...ORDER_STATUSES)
      .required(),
  }),

  params: Joi.object({
    id: Joi.string().length(24).hex().required(),
  }),
});

// ❌ Cancel order
const cancelOrderSchema = Joi.object({
  params: Joi.object({
    id: Joi.string().length(24).hex().required(),
  }),
});

module.exports = {
  createOrderSchema,
  updateStatusSchema,
  cancelOrderSchema,
};
