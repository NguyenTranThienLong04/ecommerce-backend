const User = require("../models/User");
const bcrypt = require("bcrypt");
// GET ALL USERS (admin)
async function getUsers(req, res) {
  try {
    const users = await User.find().select("-password");
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// GET USER BY ID
async function getUserById(req, res) {
  try {
    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User không tồn tại" });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// UPDATE USER
async function updateUser(req,res){
  try{

    const { name, phone, role, password } = req.body;

    const updateData = {
      name,
      phone,
      role
    };

    if(password){
      const hashedPassword = await bcrypt.hash(password,10);
      updateData.password = hashedPassword;
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: updateData, ...(password ? { $inc: { authVersion: 1 } } : {}) },
      { returnDocument: "after" }
    ).select("-password");

    res.json(user);

  }catch(error){
    res.status(500).json({message:error.message});
  }
}

// DELETE USER
async function deleteUser(req, res) {
  try {
    await User.findByIdAndDelete(req.params.id);

    res.json({ message: "Xóa user thành công" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports = {
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
};
