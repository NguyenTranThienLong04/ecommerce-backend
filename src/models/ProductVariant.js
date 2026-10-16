const mongoose=require("mongoose");
const { normalizeSize, normalizeColor } = require("../utils/catalog");

const productVariantSchema=new mongoose.Schema({
    idProduct:{
         type:mongoose.Schema.Types.ObjectId,
         ref:"Product",
         required:true,
    },
    size: { type: String, default: "", set: normalizeSize, maxlength: 10 },
    color: { type: String, default: "", set: normalizeColor, maxlength: 20 },
    price: { type: Number, min: 0, validate: Number.isSafeInteger },
    stock: { type: Number, min: 0, validate: Number.isSafeInteger },
    inventoryVersion: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    archivedAt: Date,
    catalogRevision: Number,
},{timestamps:true});

// Archived combinations remain reserved so references never change identity.
productVariantSchema.index({ idProduct: 1, size: 1, color: 1 }, {
    unique: true, name: "variant_combination_unique"
});

module.exports=mongoose.model("ProductVariant",productVariantSchema);
