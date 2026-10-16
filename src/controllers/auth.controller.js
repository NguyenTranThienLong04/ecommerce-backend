const User = require("../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// ================= REGISTER =================
async function register(req, res) {
  try {
    let { name, email, phone, password } = req.body;

    // fallback tránh crash
    name = name?.trim();
    email = email?.toLowerCase().trim();
    phone = phone?.trim();

    // check email tồn tại
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email đã tồn tại" });
    }

    // hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      phone: phone || "",
      password: hashedPassword
    });

    res.status(201).json({
      message: "Đăng ký thành công",
      user: {
        id: user._id,
        email: user.email
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ================= LOGIN =================
async function login(req, res) {
  try {
    let { email, password } = req.body;

    email = email?.toLowerCase().trim();

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: "Sai email hoặc mật khẩu" });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ message: "Sai email hoặc mật khẩu" });
    }

    const token = jwt.sign(
      {
        userId: user._id,
        authVersion: user.authVersion ?? 0,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Đăng nhập thành công",
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ================= GET ME =================
async function getMe(req, res) {
  res.json(req.user);
}

module.exports = {
  register,
  login,
  getMe
};
