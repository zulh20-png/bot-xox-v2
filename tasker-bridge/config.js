const path = require("path");

module.exports = {
  bind: process.env.BRIDGE_BIND || "0.0.0.0",
  port: process.env.BRIDGE_PORT ? Number(process.env.BRIDGE_PORT) : 3005,
  apiKey: process.env.BRIDGE_API_KEY || "change-me",
  rateLimit: {
    windowMs: 60_000,
    max: 60
  },
  inFlightTtlMs: 120_000,
  logPath: path.join(__dirname, "logs", "bridge.log")
};
