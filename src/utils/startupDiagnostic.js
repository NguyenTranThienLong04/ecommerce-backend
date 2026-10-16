// Temporary, opt-in startup logging. Never serialize a raw error, stack, or URI.
const disabled = Object.freeze({
  enabled: false,
  log() {},
  run: (_stage, operation) => operation(),
  withCause: wrapped => wrapped
});

function createDiagnostic(uri, env = process.env, write = line => console.error(line)) {
  if (env.DB_STARTUP_DIAGNOSTICS !== "true") return disabled;
  const secrets = new Set();
  function addSecret(value) {
    if (typeof value !== "string" || !value.length) return;
    secrets.add(value);
    try { secrets.add(decodeURIComponent(value)); } catch { /* malformed encoding */ }
    try { secrets.add(encodeURIComponent(value)); } catch { /* invalid Unicode */ }
    secrets.add(JSON.stringify(value).slice(1, -1));
  }
  function addUri(value) {
    addSecret(value);
    // URL() rejects valid MongoDB multi-host authorities. Extract userinfo without
    // resolving hosts, including percent-encoded and malformed credential input.
    const address = typeof value === "string" && value.match(/^mongodb(?:\+srv)?:\/\/([^?#]*)/i)?.[1];
    if (!address || !address.includes("@")) return;
    const userinfo = address.slice(0, address.lastIndexOf("@"));
    const separator = userinfo.indexOf(":");
    addSecret(separator < 0 ? userinfo : userinfo.slice(0, separator));
    if (separator >= 0) addSecret(userinfo.slice(separator + 1));
  }
  for (const [key, value] of Object.entries(env)) {
    if (/SECRET|PASSWORD|TOKEN|API_?KEY|CREDENTIAL|MONGO_URI|CLOUD_NAME|VNP_TMN_CODE|(?:^|_)(?:USER(?:NAME)?|PWD)(?:$|_)/i.test(key)) addSecret(value);
    if (/MONGO_URI/i.test(key)) addUri(value);
  }
  addUri(uri);
  const redactions = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  function redact(value) {
    if (value === undefined || value === null) return null;
    let result = String(value ?? "").replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[REDACTED_URI]")
      .replace(/dup key:\s*[\s\S]*/i, "dup key: [REDACTED]");
    for (const secret of redactions) result = result.split(secret).join("[REDACTED]");
    return result;
  }
  function fields(error) {
    return { name: redact(error.name),
      code: typeof error.code === "number" ? error.code : redact(error.code),
      message: redact(error.message) };
  }
  function log(stage, status, error) {
    // Logging must never alter startup success/failure, even if its sink fails.
    try {
      write("[db] " + JSON.stringify({ stage: redact(stage), status, ...(error ? {
        ...fields(error), cause: error.cause ? fields(error.cause) : null
      } : {}) }));
    } catch { /* preserve the original application behavior */ }
  }
  function run(stage, operation) {
    log(stage, "START");
    try {
      return Promise.resolve(operation()).then(result => {
        log(stage, "PASS");
        return result;
      }, error => {
        log(stage, "FAIL", error);
        throw error;
      });
    } catch (error) {
      log(stage, "FAIL", error);
      throw error;
    }
  }
  function withCause(wrapped, cause) {
    // Match Error's non-enumerable cause property; API error payloads stay unchanged.
    Object.defineProperty(wrapped, "cause", { value: cause, writable: true, configurable: true });
    return wrapped;
  }
  return { enabled: true, run, log, withCause };
}
module.exports = { createDiagnostic };
