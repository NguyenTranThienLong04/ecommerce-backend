const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
let count = 0;
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".cache", "coverage", "playwright-report", "test-results"].includes(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) { walk(file); continue; }
    if (file.endsWith(".js")) { new vm.Script(fs.readFileSync(file, "utf8"), { filename: file }); count++; }
    if (file.endsWith(".html") && file.startsWith("public")) {
      for (const match of fs.readFileSync(file, "utf8").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (match[1].trim()) { new vm.Script(match[1], { filename: file }); count++; }
      }
    }
  }
}
walk(".");
console.log("Syntax PASS: " + count + " scripts");
