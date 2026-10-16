const UserAddress = require("../models/UserAddress");
const mongoose = require("mongoose");

// Ownership and update operators must never come from the request body.
function addressFields(body) {
  const fields = ["receiverName", "phone", "addressLine", "ward", "district", "city", "isDefault"];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
}

function validAddressId(req, res) {
  if (typeof req.params.id !== "string" || !mongoose.isObjectIdOrHexString(req.params.id)) {
    res.status(400).json({ message: "ID địa chỉ không hợp lệ" });
    return false;
  }
  return true;
}

// GET ALL ADDRESSES OF USER
exports.getUserAddresses = async (req, res) => {
  try {
    const userId = req.user.id;
    const addresses = await UserAddress.find({ idUser: userId });
    res.json(addresses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// CREATE ADDRESS
exports.createAddress = async (req, res) => {
  try {
    const userId = req.user.id;

    if (req.body.isDefault) {
      await UserAddress.updateMany({ idUser: userId }, { isDefault: false });
    }

    const newAddress = new UserAddress({
      ...addressFields(req.body),
      idUser: userId
    });

    const saved = await newAddress.save();
    res.json(saved);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UPDATE ADDRESS
exports.updateAddress = async (req, res) => {
  try {
    if (!validAddressId(req, res)) return;
    const userId = req.user.id;
    const addressId = req.params.id;

    const filter = { _id: addressId, idUser: userId };
    if (!await UserAddress.exists(filter)) {
      return res.status(404).json({ message: "Address không tồn tại" });
    }

    if (req.body.isDefault) {
      await UserAddress.updateMany({ idUser: userId }, { isDefault: false });
    }

    const address = await UserAddress.findOneAndUpdate(
      filter,
      { $set: addressFields(req.body) },
      { returnDocument: "after" }
    );

    res.json(address);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE ADDRESS
exports.deleteAddress = async (req, res) => {
  try {
    if (!validAddressId(req, res)) return;
    const address = await UserAddress.findOneAndDelete({ _id: req.params.id, idUser: req.user.id });
    if (!address) return res.status(404).json({ message: "Address không tồn tại" });
    res.json({ message: "Address deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// SET DEFAULT ADDRESS
exports.setDefaultAddress = async (req, res) => {
  try {
    if (!validAddressId(req, res)) return;
    const userId = req.user.id;
    const addressId = req.params.id;

    const filter = { _id: addressId, idUser: userId };
    if (!await UserAddress.exists(filter)) {
      return res.status(404).json({ message: "Address không tồn tại" });
    }

    await UserAddress.updateMany({ idUser: userId }, { isDefault: false });
    const address = await UserAddress.findOneAndUpdate(
      filter,
      { isDefault: true },
      { returnDocument: "after" }
    );

    res.json(address);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
