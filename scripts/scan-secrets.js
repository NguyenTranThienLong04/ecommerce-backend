const fs = require("node:fs"), { execFileSync } = require("node:child_process");
const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /mongodb(?:\+srv)?:\/\/[^\s/:@]+:[^\s@]+@/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/];
const findings = [];
const files = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))];
const tracked = git(["ls-files", "-z"]).split("\0");
for (const file of tracked) if (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith(".env.example")) findings.push(file + ": tracked environment file");
for (const file of files) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  const data = fs.readFileSync(file);
  if (data.includes(0)) continue;
  data.toString("utf8").split(/\r?\n/).forEach((line, i) => {
    if (patterns.some(pattern => pattern.test(line))) findings.push(file + ":" + (i + 1) + ": possible credential (value withheld)");
  });
}
if (process.argv.includes("--history")) {
  let commit = "", file = "";
  for (const line of git(["log", "--all", "--format=COMMIT %h", "-p", "--", ".", ":(exclude)package-lock.json"]).split(/\r?\n/)) {
    if (line.startsWith("COMMIT ")) commit = line.slice(7);
    if (line.startsWith("+++ b/")) file = line.slice(6);
    if (line.startsWith("+") && !line.startsWith("+++ ") && patterns.some(pattern => pattern.test(line))) findings.push(commit + ":" + file + ": possible historical credential (value withheld)");
  }
  const historyEnv = git(["log", "--all", "--format=", "--name-only", "--", ".env", ".env.local", "*.pem", "*.key"]).trim();
  if (historyEnv) findings.push("Sensitive file paths exist in history; inspect and rotate before publishing");
}
if (findings.length) { console.error([...new Set(findings)].join("\n")); process.exitCode = 1; }
else console.log("Secret-pattern scan PASS: " + files.length + " files" + (process.argv.includes("--history") ? " and available git history" : "") + ". Best-effort detection; values are never printed.");
