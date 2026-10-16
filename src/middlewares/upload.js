const multer = require("multer");
const cloudinary = require("../config/cloudinary");

// Keep the Multer contract while using the maintained SDK directly.
const storage = {
  _handleFile(req, file, done) {
    if (process.env.CLOUDINARY_ENABLED !== "true") {
      return done(Object.assign(new Error("Image uploads are disabled in this environment"), { status: 503 }));
    }
    const stream = cloudinary.uploader.upload_stream({ folder: "products", allowed_formats: ["jpg", "png", "jpeg", "webp"] }, (error, result) => {
      if (error) return done(new Error("Image upload unavailable"));
      done(null, { path: result.secure_url, filename: result.public_id, size: result.bytes });
    });
    file.stream.on("error", done);
    file.stream.pipe(stream);
  },
  _removeFile(req, file, done) {
    cloudinary.uploader.destroy(file.filename, done);
  }
};

const upload = multer({ storage ,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

module.exports = upload;
