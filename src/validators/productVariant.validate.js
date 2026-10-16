const Joi = require("joi");

// ObjectId regex
const objectId = /^[0-9a-fA-F]{24}$/;

const createVariantSchema = Joi.object({
  body: Joi.object({
    idProduct: Joi.string().pattern(objectId).required(),

    size: Joi.string().max(10).allow("", null),

    color: Joi.string().max(20).allow("", null),

    price: Joi.number().integer().min(0).required(),

    stock: Joi.number().integer().min(0).required(),
  }).unknown(true),

  params: Joi.object().unknown(true),

  query: Joi.object().unknown(true),
});

const updateVariantSchema = Joi.object({
  body: Joi.object({
    size: Joi.string().max(10).allow("", null),

    color: Joi.string().max(20).allow("", null),

    price: Joi.number().integer().min(0),

    stock: Joi.forbidden(),
  }).unknown(true),

  params: Joi.object({
    id: Joi.string().pattern(objectId).required(),
  }),

  query: Joi.object().unknown(true),
});

const adjustStockSchema = Joi.object({
  body: Joi.object({
    stock: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required(),
    expectedStock: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required(),
    expectedVersion: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER - 1).required()
  }).required(),
  params: Joi.object({ id: Joi.string().pattern(objectId).required() })
});

module.exports = {
  createVariantSchema,
  updateVariantSchema,
  adjustStockSchema,
};
