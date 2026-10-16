const mongoose=require('mongoose');

const cartItemSchema=new mongoose.Schema({
    quantity:{type:Number, default:1, min:1, validate:Number.isSafeInteger},
    idCart:{type:mongoose.Schema.Types.ObjectId,
    ref:"Cart",
},
    idProductVariant:{type:mongoose.Schema.Types.ObjectId,
        ref:"ProductVariant",
    }
}, { timestamps: true });

cartItemSchema.index({ idCart: 1, idProductVariant: 1 }, { unique: true, name: "cart_variant_unique" });

module.exports=mongoose.model('CartItem',cartItemSchema);
