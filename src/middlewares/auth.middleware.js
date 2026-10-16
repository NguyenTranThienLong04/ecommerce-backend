const jwt=require("jsonwebtoken");
const User=require("../models/User");
const validSession = require("../utils/sessionVersion");

module.exports= async(req,res,next)=>{
try{
const authHeader=req.headers.authorization;
if(!authHeader){
    return res.status(400).json({message:"Chưa đăng nhập"});
}
const token=authHeader.split(" ")[1];
const decoded=jwt.verify(token,process.env.JWT_SECRET, { algorithms: ["HS256"] });
const user= await User.findById(decoded.userId).select("-password");
if(!validSession(decoded, user)){
    return res.status(401).json({message:"User không tồn tại!"});
}
req.user=user;
next();
}
catch(error){
res.status(401).json({message:"Token không hợp lệ"});
}
};
