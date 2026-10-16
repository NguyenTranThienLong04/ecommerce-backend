const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");
const cloudinary = require("../src/config/cloudinary");
const { storage } = require("../src/middlewares/upload");

test("disabled image upload fails before any provider request", async t => {
  const original = process.env.CLOUDINARY_ENABLED;
  process.env.CLOUDINARY_ENABLED = "false";
  t.after(() => { if (original === undefined) delete process.env.CLOUDINARY_ENABLED; else process.env.CLOUDINARY_ENABLED = original; });
  const provider = t.mock.method(cloudinary.uploader, "upload_stream", () => { throw new Error("Unexpected provider call"); });
  const error = await new Promise(resolve => storage._handleFile({}, { stream: Readable.from("image") }, resolve));
  assert.equal(error.status, 503);
  assert.equal(provider.mock.callCount(), 0);
});

test("maintained Cloudinary adapter preserves Multer file fields and cleanup contract", async t => {
  const original = process.env.CLOUDINARY_ENABLED;
  process.env.CLOUDINARY_ENABLED = "true";
  t.after(() => { if (original === undefined) delete process.env.CLOUDINARY_ENABLED; else process.env.CLOUDINARY_ENABLED = original; });
  let content = "";
  t.mock.method(cloudinary.uploader, "upload_stream", (options, callback) => {
    assert.equal(options.folder, "products");
    return new Writable({ write(chunk, encoding, done) { content += chunk; done(); }, final(done) {
      callback(null, { secure_url: "https://images.example.com/demo.png", public_id: "products/demo", bytes: 5 }); done();
    } });
  });
  const file = await new Promise((resolve, reject) => storage._handleFile({}, { stream: Readable.from("image") }, (error, result) => error ? reject(error) : resolve(result)));
  assert.equal(content, "image");
  assert.deepEqual(file, { path: "https://images.example.com/demo.png", filename: "products/demo", size: 5 });
  t.mock.method(cloudinary.uploader, "destroy", (id, done) => { assert.equal(id, file.filename); done(null); });
  await new Promise((resolve, reject) => storage._removeFile({}, file, error => error ? reject(error) : resolve()));
});

test("Cloudinary errors do not expose provider credentials or raw responses", async t => {
  const original = process.env.CLOUDINARY_ENABLED;
  process.env.CLOUDINARY_ENABLED = "true";
  t.after(() => { if (original === undefined) delete process.env.CLOUDINARY_ENABLED; else process.env.CLOUDINARY_ENABLED = original; });
  t.mock.method(cloudinary.uploader, "upload_stream", (options, callback) => new Writable({ write(chunk, encoding, done) { done(); },
    final(done) { callback(new Error("private provider response")); done(); } }));
  const error = await new Promise(resolve => storage._handleFile({}, { stream: Readable.from("image") }, resolve));
  assert.equal(error.message, "Image upload unavailable");
});
