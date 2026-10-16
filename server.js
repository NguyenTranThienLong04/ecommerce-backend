const http = require("node:http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const configuration = require("./src/config/env");
async function start({ env = process.env, scheduler = true } = {}) {
  const config = configuration(env);
  const app = require("./src/app")(config);
  await require("./src/config/database")(config.mongoUri);
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: config.frontendOrigin, methods: ["GET", "POST"] } });
  app.set("io", io);
  require("./src/socket/chat.socket")(io);
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
  } catch (error) { io.close(); await mongoose.disconnect(); throw error; }
  let running = false;
  const timer = scheduler && setInterval(async () => {
    if (running) return;
    running = true;
    try { await require("./src/utils/autoCancelOrders")(15); } finally { running = false; }
  }, 60000);
  timer?.unref?.();
  let closing;
  const close = () => closing ||= (async () => {
    clearInterval(timer);
    await new Promise(resolve => io.close(resolve));
    await mongoose.disconnect();
  })();
  return { app, server, io, config, close };
}
module.exports = { start };
if (require.main === module) {
  if (!process.env.MONGO_URI) require("dotenv").config({ quiet: true });
  start().then(runtime => {
    console.log("Backend ready on port " + runtime.server.address().port);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => runtime.close().then(() => process.exit(0)));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
