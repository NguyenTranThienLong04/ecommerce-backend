const mongoose = require("mongoose");
const productSchema=new mongoose.Schema({
    nameProduct:{type:String,required:true,trim:true,minlength:3,maxlength:200},
    archivedAt: Date,
    catalogRevision: Number,
    description:String,
    images:[String], 
    idCategory:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Category"
    },
    slug: {
  type: String,
  unique: true
},
selectedTags:[String],
  customTags:[String]
},{timestamps:true});

module.exports=mongoose.model("Product",productSchema);
