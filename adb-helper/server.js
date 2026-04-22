const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("./config");

const app = express();

const logDir = path.dirname(config.logPath);
fs.mkdirSync(logDir, { recursive: true });
const logStream = fs.createWriteStream(config.logPath, { flags: "a" });

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  logStream.write(msg + "\n");
  console.log(msg);
}

const rateState = new Map();
function rateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let state = rateState.get(ip);
  if (!state || now >= state.resetAt) {
    state = { count: 0, resetAt: now + config.rateLimit.windowMs };
    rateState.set(ip, state);
  }
  state.count += 1;
  if (state.count > config.rateLimit.max) {
    log(`rate_limit ip=${ip} count=${state.count}`);
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }
  return next();
}

function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== config.apiKey) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

function safeJobId(value) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function execAdb(args, label) {
  return new Promise((resolve, reject) => {
    execFile(config.adbPath, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const error = new Error(`${label} failed`);
        error.details = { stdout, stderr, code: err.code };
        return reject(error);
      }
      return resolve({ stdout, stderr });
    });
  });
}

let busy = false;
async function withLock(fn) {
  if (busy) {
    const err = new Error("busy");
    err.code = "busy";
    throw err;
  }
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

app.use(express.json({ limit: "64kb" }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }
  return next(err);
});

app.use(rateLimit);
app.use(requireApiKey);

app.post("/adb/screenshot", async (req, res) => {
  const jobId = req?.body?.job_id ? String(req.body.job_id) : "";
  if (!jobId || !safeJobId(jobId)) {
    return res.status(400).json({ ok: false, error: "invalid_job_id" });
  }

  if (!config.androidTarget) {
    return res.status(500).json({ ok: false, error: "missing_android_target" });
  }

  const outputDir = path.resolve(config.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const fileName = `qrpay_${jobId}_p1.png`;
  const localPath = path.join(outputDir, fileName);

  try {
    await withLock(async () => {
      log(`job_start job_id=${jobId} target=${config.androidTarget}`);

      await execAdb(["connect", config.androidTarget], "adb connect");
      await execAdb(["shell", "screencap", "-p", config.fixedRemotePath], "adb screencap");
      await execAdb(["pull", config.fixedRemotePath, localPath], "adb pull");
      await execAdb(["shell", "rm", config.fixedRemotePath], "adb rm");

      log(`job_done job_id=${jobId} file=${localPath}`);
    });

    return res.json({ ok: true, file: localPath });
  } catch (err) {
    if (err.code === "busy") {
      return res.status(429).json({ ok: false, error: "busy" });
    }
    log(`job_error job_id=${jobId} err=${err.message}`);
    return res.status(500).json({ ok: false, error: "adb_failed", details: err.details || null });
  }
});

app.get("/health", (req, res) => {
  return res.json({ ok: true });
});

app.listen(config.port, config.bind, () => {
  log(`listening http://${config.bind}:${config.port}`);
});
