const path = require("path");

module.exports = {
  bind: "127.0.0.1",
  port: process.env.ADB_HELPER_PORT ? Number(process.env.ADB_HELPER_PORT) : 3010,
  apiKey: process.env.API_KEY || "change-me",
  androidTarget: process.env.ANDROID_TARGET || "",
  outputDir: process.env.OUTPUT_DIR || "C:\\qrpay\\screens",
  adbPath: process.env.ADB_PATH || "adb",
  fixedRemotePath: "/sdcard/adb_helper_screencap.png",
  rateLimit: {
    windowMs: 60_000,
    max: 30
  },
  logPath: path.join(__dirname, "logs", "adb-helper.log")
};
