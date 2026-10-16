const fs = require("node:fs"), crypto = require("node:crypto");
const filename = ".env.local";
if (fs.existsSync(filename)) { console.log(filename + " already exists; kept unchanged."); }
else {
  const example = fs.readFileSync(".env.example", "utf8").replace(/^JWT_SECRET=$/m, "JWT_SECRET=" + crypto.randomBytes(32).toString("base64url"));
  fs.writeFileSync(filename, example, { flag: "wx", mode: 0o600 });
  console.log("Created " + filename + "; existing .env was not read or changed.");
}
