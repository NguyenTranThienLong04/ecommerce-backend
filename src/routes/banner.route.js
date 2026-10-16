const express = require("express");
const router = express.Router();
const Banner = require("../models/banner");
const upload = require("../middlewares/upload");
const cloudinary = require("../config/cloudinary");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware=require("../middlewares/admin.middleware");
// ======================
// GET ALL BANNERS
// ======================
router.get("/", async (req, res) => {
  try {

    const banners = await Banner.find()
      .sort({ order: 1 });

    res.json(banners);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// ======================
// CREATE BANNER
// ======================
router.post("/", authMiddleware,adminMiddleware,upload.single("image"), async (req, res) => {

  try {

    let imageUrl = "";

    if (req.file) {
      imageUrl = req.file.path;   // link cloudinary
    }

    const banner = new Banner({
      image: imageUrl,
      title: req.body.title,
      link: req.body.link,
      order: req.body.order || 0,
      status: true
    });

    const savedBanner = await banner.save();

    res.json(savedBanner);

  } catch (error) {

    res.status(500).json({ message: error.message });

  }

});


// ======================
// UPDATE BANNER
// ======================
router.put("/:id",authMiddleware,adminMiddleware, async (req, res) => {
  try {

    const banner = await Banner.findByIdAndUpdate(
      req.params.id,
      {
        image: req.body.image,
        title: req.body.title,
        link: req.body.link,
        order: req.body.order,
        status: req.body.status
      },
      { returnDocument: "after" }
    );

    res.json(banner);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// ======================
// DELETE BANNER
// ======================
router.delete("/:id",authMiddleware,adminMiddleware, async (req, res) => {
  try {

    await Banner.findByIdAndDelete(req.params.id);

    res.json({ message: "Banner deleted" });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


module.exports = router;