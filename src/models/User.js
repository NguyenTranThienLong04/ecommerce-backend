const mongoose=require("mongoose");

const userSchema = new mongoose.Schema({
name:String,
email:{ type:String, unique: true, required: true },
password:{ type:String,required: true },
authVersion: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
phone:String,
role: {
    type:String,
    enum:["ADMIN","USER"],
    default:"USER"
},
loyaltyPoints :{
    type:Number,
    default:0,
}
},{ timestamps : true});

module.exports=mongoose.model("User",userSchema);
