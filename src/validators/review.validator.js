const Joi = require("joi");
const objectId = Joi.string().hex().length(24);
const rating = Joi.number().integer().min(1).max(5);
const comment = Joi.string().allow("").max(2000);
module.exports = {
  create: Joi.object({ body: Joi.object({ idOrderItem: objectId.required(), rating: rating.required(), comment }) }),
  update: Joi.object({ params: Joi.object({ id: objectId.required() }), body: Joi.object({ rating, comment }).min(1) }),
  status: Joi.object({ params: Joi.object({ id: objectId.required() }),
    body: Joi.object({ status: Joi.string().valid("VISIBLE", "HIDDEN").required() }) }),
  list: Joi.object({ params: Joi.object({ idVariant: objectId.required() }) })
};
