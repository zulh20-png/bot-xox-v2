const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Ajv = require("ajv");
const multer = require("multer");
const config = require("./config");

const app = express();
const ajv = new Ajv({ allErrors: true, removeAdditional: "failing" });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});
const rawImage = express.raw({
  type: ["image/*", "application/octet-stream"],
  limit: "8mb"
});

const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || process.env.GEMINI_API_KEY || "";

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

function validationError(res, errors) {
  return res.status(400).json({ ok: false, error: "invalid_payload", details: errors });
}

async function runVisionOcrBuffer(buffer) {
  if (!VISION_API_KEY) throw new Error("GOOGLE_VISION_API_KEY tidak ditetapkan");
  const body = {
    requests: [{
      image: { content: buffer.toString("base64") },
      features: [{ type: "DOCUMENT_TEXT_DETECTION" }]
    }]
  };
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vision API gagal: ${res.status} ${errText}`);
  }
  const json = await res.json();
  return json?.responses?.[0]?.fullTextAnnotation?.text || "";
}

function parseAmount(line) {
  const m = line.match(/(?:RM|MYR)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i)
    || line.match(/\b([0-9]+(?:[.,][0-9]{1,2})?)\b/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

function parseTimeMinutes(line) {
  const m = line.match(/\b([0-9]{1,2}):([0-9]{2})(?:\s*(AM|PM))?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const mer = m[3] ? m[3].toUpperCase() : null;
  if (mer === "PM" && h < 12) h += 12;
  if (mer === "AM" && h === 12) h = 0;
  return h * 60 + mi;
}

function extractRefCandidatesFromText(text) {
  const upper = String(text || "").toUpperCase();
  const out = [];
  const seen = new Set();
  const push = (token) => {
    if (!token) return;
    if (!/\d/.test(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };

  const bounded = upper.match(/\b[A-Z0-9]{6,40}\b/g) || [];
  for (const t of bounded) push(t);

  const longSeqs = upper.match(/[A-Z0-9]{41,}/g) || [];
  for (const seq of longSeqs) {
    for (let len = 40; len >= 6; len--) {
      for (let i = 0; i + len <= seq.length; i++) {
        push(seq.slice(i, i + len));
      }
    }
  }

  return out;
}

function extractRef(line) {
  return extractRefCandidatesFromText(line)[0] || null;
}

function parseQrPayText(text, expectedAmount, expectedTimeMin) {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim().replace(/\s+/g, " ").toUpperCase())
    .filter(Boolean);

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let ref = extractRef(line);
    let amt = parseAmount(line);
    let tim = parseTimeMinutes(line);

    if (!ref) {
      for (const j of [i - 1, i + 1, i - 2, i + 2]) {
        if (j >= 0 && j < lines.length) {
          ref = extractRef(lines[j]);
          if (ref) break;
        }
      }
    }

    if (ref) {
      for (const j of [i, i - 1, i + 1, i - 2, i + 2]) {
        if (j >= 0 && j < lines.length) {
          if (amt === null) amt = parseAmount(lines[j]);
          if (tim === null) tim = parseTimeMinutes(lines[j]);
        }
      }
      rows.push({ line: i, ref, amount: amt, time: tim });
    }
  }

  let candidates = rows.slice();
  if (Number.isFinite(expectedAmount)) {
    const byAmt = candidates.filter(r => r.amount !== null && Math.abs(r.amount - expectedAmount) <= 0.01);
    if (byAmt.length) candidates = byAmt;
  }
  if (Number.isFinite(expectedTimeMin)) {
    candidates.sort((a, b) => {
      const da = Math.abs((a.time ?? 0) - expectedTimeMin);
      const db = Math.abs((b.time ?? 0) - expectedTimeMin);
      return da - db;
    });
  }

  return {
    best_row: candidates[0] || null,
    rows
  };
}

function isLikelyQrpayNotification(text) {
  const raw = String(text || "");
  if (!raw.trim()) return { ok: false, reason: "empty_text" };
  const parsed = parseQrPayText(raw, null, null);
  const hasRow = Array.isArray(parsed.rows) && parsed.rows.length > 0;
  const hasRef = hasRow && parsed.rows.some(r => !!normalizeRef(r.ref || ""));
  const hasAmt = hasRow && parsed.rows.some(r => Number.isFinite(Number(r.amount)) && Number(r.amount) > 0);
  if (hasRef && hasAmt) return { ok: true, parsed };
  return {
    ok: false,
    reason: !hasRef ? "ref_not_found" : "amount_not_found",
    parsed
  };
}

const submitSchema = {
  type: "object",
  additionalProperties: false,
  required: ["job_id", "ref", "amount", "date", "time"],
  properties: {
    job_id: { type: "string", minLength: 1 },
    ref: { type: "string", minLength: 1 },
    amount: { type: ["number", "string"], minLength: 1 },
    date: { type: "string", minLength: 1 },
    time: { type: "string", minLength: 1 }
  }
};

const resultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["job_id", "stage", "match"],
  properties: {
    job_id: { type: "string", minLength: 1 },
    stage: { type: "string", minLength: 1 },
    match: { type: ["boolean", "string", "number"] },
    reason: { type: "string", minLength: 1 },
    best_row: { type: ["object", "string", "number", "array", "null"] }
  }
};

const nextSchema = {
  type: "object",
  additionalProperties: true,
  required: ["device"],
  properties: {
    device: { type: "string", minLength: 1 }
  }
};

const validateSubmit = ajv.compile(submitSchema);
const validateResult = ajv.compile(resultSchema);
const validateNext = ajv.compile(nextSchema);

const queue = [];
const inFlight = new Map();
const results = new Map();
const status = new Map();
const jobs = new Map();
const notifStorePath = path.join(__dirname, "data", "qrpaybiz_notifications.json");

function normalizeRef(val) {
  return String(val || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function malaysiaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(date);
}

function ensureNotifStoreDir() {
  fs.mkdirSync(path.dirname(notifStorePath), { recursive: true });
}

function loadNotifStore() {
  ensureNotifStoreDir();
  const today = malaysiaDateKey();
  if (!fs.existsSync(notifStorePath)) {
    const init = { date: today, items: [] };
    fs.writeFileSync(notifStorePath, JSON.stringify(init, null, 2));
    return init;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(notifStorePath, "utf8"));
  } catch {
    data = { date: today, items: [] };
  }
  if (!data || typeof data !== "object") data = { date: today, items: [] };
  if (data.date !== today || !Array.isArray(data.items)) {
    data = { date: today, items: [] };
    fs.writeFileSync(notifStorePath, JSON.stringify(data, null, 2));
  }
  return data;
}

function saveNotifStore(data) {
  ensureNotifStoreDir();
  fs.writeFileSync(notifStorePath, JSON.stringify(data, null, 2));
}

function buildNotifRecord(rawText, extra = {}) {
  const parsed = parseQrPayText(rawText, null, null);
  const refCandidates = new Set(extractRefCandidatesFromText(rawText));
  for (const row of parsed.rows) {
    if (row?.ref) refCandidates.add(String(row.ref).toUpperCase());
  }

  const bestRow = parsed.best_row
    ? { ...parsed.best_row, ref_qrpay: parsed.best_row.ref || null }
    : null;

  return {
    id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    received_at: new Date().toISOString(),
    source_app: String(extra.source_app || "qrpaybiz"),
    raw_text: rawText,
    raw_hash: crypto.createHash("sha256").update(rawText).digest("hex"),
    rows: parsed.rows,
    refs: Array.from(refCandidates),
    best_row: bestRow,
    used: false,
    used_at: null,
    used_by_job_id: null,
    duplicate_seen_count: 1
  };
}

function upsertIncomingNotification(rawText, extra = {}) {
  const store = loadNotifStore();
  const hash = crypto.createHash("sha256").update(rawText).digest("hex");
  const existing = store.items.find(i => i.raw_hash === hash);
  if (existing) {
    existing.duplicate_seen_count = Number(existing.duplicate_seen_count || 1) + 1;
    existing.last_seen_at = new Date().toISOString();
    saveNotifStore(store);
    return { item: existing, isDuplicate: true };
  }

  const item = buildNotifRecord(rawText, extra);
  store.items.push(item);
  if (store.items.length > 2000) {
    store.items = store.items.slice(-2000);
  }
  saveNotifStore(store);
  return { item, isDuplicate: false };
}

function markNotificationUsed(notificationId, jobId) {
  const store = loadNotifStore();
  const item = store.items.find(i => i.id === notificationId);
  if (!item) return false;
  item.used = true;
  item.used_at = new Date().toISOString();
  item.used_by_job_id = jobId;
  saveNotifStore(store);
  return true;
}

function rowsForNotificationItem(item) {
  if (Array.isArray(item?.rows) && item.rows.length) return item.rows;
  const row = item?.best_row ? item.best_row : null;
  if (row) return [row];
  const refs = Array.isArray(item?.refs) ? item.refs : [];
  return refs.map(ref => ({ ref, amount: null, time: null }));
}

function matchJobAgainstNotifItem(job, item) {
  if (!job || !item || item.used) return null;
  const refExpected = normalizeRef(job.ref);
  const expectedAmount = Number(job.amount);
  const expectedTimeMin = parseTimeMinutes(String(job.time || ""));
  if (!refExpected || !Number.isFinite(expectedAmount)) return null;

  let best = null;
  for (const row of rowsForNotificationItem(item)) {
    const rowRef = normalizeRef(row.ref || row.ref_qrpay || "");
    if (!rowRef || rowRef !== refExpected) continue;

    const amountFound = Number(row.amount);
    const amountMatch = Number.isFinite(amountFound) && Math.abs(amountFound - expectedAmount) <= 0.01;
    if (!amountMatch) continue;

    const rowTime = Number(row.time);
    const timeMatch = Number.isFinite(expectedTimeMin) && Number.isFinite(rowTime)
      ? Math.abs(rowTime - expectedTimeMin) <= 20
      : true;
    if (!timeMatch) continue;

    const score = (Number.isFinite(rowTime) && Number.isFinite(expectedTimeMin))
      ? Math.abs(rowTime - expectedTimeMin)
      : 999;
    if (!best || score < best.score) {
      best = {
        score,
        row: {
          ...row,
          ref_qrpay: row.ref_qrpay || row.ref || null,
          notification_id: item.id
        }
      };
    }
  }

  return best ? best.row : null;
}

function tryAutoCompleteJobFromStoredNotifications(jobId, source = "unknown") {
  const job = jobs.get(jobId);
  if (!job || status.get(jobId) === "done") return null;

  const store = loadNotifStore();
  for (let i = store.items.length - 1; i >= 0; i--) {
    const item = store.items[i];
    const matchedRow = matchJobAgainstNotifItem(job, item);
    if (!matchedRow) continue;

    const done = completeJob(jobId, {
      stage: "done",
      match: true,
      reason: "matched_from_notification_store",
      best_row: matchedRow
    });
    if (done.ok) {
      markNotificationUsed(item.id, jobId);
      log(`auto_match job_id=${jobId} notification_id=${item.id} source=${source}`);
      return { jobId, notificationId: item.id };
    }
    return null;
  }
  return null;
}

function tryAutoCompletePendingJobs(source = "notify") {
  const matched = [];
  for (const [jobId, st] of status.entries()) {
    if (st === "done") continue;
    const hit = tryAutoCompleteJobFromStoredNotifications(jobId, source);
    if (hit) matched.push(hit);
  }
  return matched;
}

function completeJob(jobId, body) {
  if (!status.has(jobId)) {
    return { ok: false, code: 404, payload: { ok: false, error: "job_not_found" } };
  }

  const result = {
    job_id: jobId,
    stage: body.stage,
    match: body.match,
    reason: body.reason ?? null,
    best_row: body.best_row ?? null,
    received_at: new Date().toISOString()
  };

  results.set(jobId, result);
  status.set(jobId, "done");
  inFlight.delete(jobId);

  if (queue.length > 0) {
    const remaining = queue.filter((item) => item.job_id !== jobId);
    if (remaining.length !== queue.length) {
      queue.length = 0;
      queue.push(...remaining);
    }
  }

  log(`result job_id=${jobId} stage=${result.stage}`);
  return { ok: true, code: 200, payload: { ok: true } };
}

function requeueExpired() {
  const now = Date.now();
  for (const [jobId, item] of inFlight.entries()) {
    if (now - item.ts > config.inFlightTtlMs) {
      inFlight.delete(jobId);
      if (status.get(jobId) !== "done") {
        queue.push(item.job);
        status.set(jobId, "queued");
        log(`requeue job_id=${jobId} device=${item.device}`);
      }
    }
  }
}

setInterval(requeueExpired, 10_000).unref();

// Increase JSON limit to allow base64 screenshots from Tasker.
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }
  return next(err);
});

// Tasker HTTP Request uses multipart/related; rewrite so multer/busboy can parse it.
app.use((req, res, next) => {
  const ct = req.headers["content-type"];
  if (ct && ct.startsWith("multipart/related")) {
    req.headers["content-type"] = ct.replace("multipart/related", "multipart/form-data");
  }
  next();
});

app.use(rateLimit);
app.use(requireApiKey);

app.post("/job/submit", (req, res) => {
  if (!validateSubmit(req.body)) {
    return validationError(res, validateSubmit.errors);
  }

  const jobId = String(req.body.job_id);
  if (status.has(jobId)) {
    return res.status(409).json({ ok: false, error: "job_id_exists" });
  }

  const job = {
    job_id: jobId,
    ref: req.body.ref,
    amount: req.body.amount,
    date: req.body.date,
    time: req.body.time,
    created_at: new Date().toISOString()
  };

  queue.push(job);
  jobs.set(jobId, job);
  status.set(jobId, "queued");
  log(`submit job_id=${jobId} ref=${job.ref}`);
  const auto = tryAutoCompleteJobFromStoredNotifications(jobId, "job_submit");
  return res.json({ ok: true, matched_from_store: !!auto, notification_id: auto?.notificationId || null });
});

app.get("/job/next", (req, res) => {
  if (!validateNext(req.query)) {
    return validationError(res, validateNext.errors);
  }

  requeueExpired();

  if (queue.length === 0) {
    return res.json({ ok: true, has_job: false });
  }

  const job = queue.shift();
  const device = String(req.query.device);
  inFlight.set(job.job_id, { job, device, ts: Date.now() });
  status.set(job.job_id, "in_flight");
  log(`dispatch job_id=${job.job_id} device=${device}`);
  return res.json({ ok: true, has_job: true, job });
});

// Versi khas Tasker: pulangkan teks sahaja supaya tak perlu parse JSON dalam Tasker.
app.get("/tasker/job/next_id", (req, res) => {
  if (!validateNext(req.query)) {
    return res.status(400).type("text/plain").send("ERROR");
  }

  requeueExpired();

  if (queue.length === 0) {
    return res.type("text/plain").send("NOJOB");
  }

  const job = queue.shift();
  const device = String(req.query.device);
  inFlight.set(job.job_id, { job, device, ts: Date.now() });
  status.set(job.job_id, "in_flight");
  log(`dispatch job_id=${job.job_id} device=${device} (tasker_next_id)`);
  return res.type("text/plain").send(job.job_id);
});

app.post("/job/result", (req, res) => {
  if (!validateResult(req.body)) {
    return validationError(res, validateResult.errors);
  }

  const jobId = String(req.body.job_id);
  const done = completeJob(jobId, req.body);
  return res.status(done.code).json(done.payload);
});

app.post("/job/result_from_notification", (req, res) => {
  const jobId = String(req.body?.job_id || "");
  const text = String(req.body?.notification_text || "");
  const textB64 = String(req.body?.notification_text_b64 || "");
  const notifText = text || (textB64 ? Buffer.from(textB64, "base64").toString("utf8") : "");
  if (!jobId || !notifText) {
    return res.status(400).json({ ok: false, error: "job_id_and_notification_text_required" });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: "job_not_found" });
  }

  const expectedAmount = Number(job.amount);
  const expectedTimeMin = parseTimeMinutes(String(job.time || ""));
  const parsed = parseQrPayText(notifText, expectedAmount, expectedTimeMin);

  const refExpected = normalizeRef(job.ref);
  const refFound = normalizeRef(parsed.best_row?.ref || "");
  const amountFound = parsed.best_row?.amount;
  const timeFound = parsed.best_row?.time;

  const refMatch = !!refExpected && !!refFound && refExpected === refFound;
  const amountMatch = Number.isFinite(expectedAmount) && Number.isFinite(amountFound)
    ? Math.abs(amountFound - expectedAmount) <= 0.01
    : false;
  const timeMatch = Number.isFinite(expectedTimeMin) && Number.isFinite(timeFound)
    ? Math.abs(timeFound - expectedTimeMin) <= 20
    : true;
  const isMatch = refMatch && amountMatch && timeMatch;

  const bestRow = parsed.best_row
    ? { ...parsed.best_row, ref_qrpay: parsed.best_row.ref || null }
    : null;
  const reason = isMatch
    ? "match"
    : !refMatch
      ? "ref_mismatch"
      : !amountMatch
        ? "amount_mismatch"
        : "time_mismatch";

  const done = completeJob(jobId, {
    stage: "done",
    match: isMatch,
    reason,
    best_row: bestRow
  });
  return res.status(done.code).json({
    ...done.payload,
    parsed: {
      best_row: bestRow,
      rows_count: parsed.rows.length
    }
  });
});

app.post("/qrpaybiz/notify", (req, res) => {
  const text = String(req.body?.notification_text || "");
  const textB64 = String(req.body?.notification_text_b64 || "");
  const notifText = text || (textB64 ? Buffer.from(textB64, "base64").toString("utf8") : "");
  if (!notifText) {
    return res.status(400).json({ ok: false, error: "notification_text_required" });
  }
  if (/^%[a-z0-9_]+$/i.test(notifText.trim())) {
    log(`notify_rejected placeholder_text=${notifText.trim()}`);
    return res.status(400).json({ ok: false, error: "notification_text_placeholder_not_expanded" });
  }

  const sanity = isLikelyQrpayNotification(notifText);
  if (!sanity.ok) {
    log(`notify_rejected reason=${sanity.reason}`);
    return res.status(400).json({
      ok: false,
      error: "notification_not_qrpay_like",
      reason: sanity.reason
    });
  }

  const saved = upsertIncomingNotification(notifText, {
    source_app: req.body?.source_app || "qrpaybiz"
  });
  log(`notify_saved notification_id=${saved.item.id} duplicate=${saved.isDuplicate ? 1 : 0}`);

  return res.json({
    ok: true,
    notification_id: saved.item.id,
    duplicate: saved.isDuplicate,
    refs_found: saved.item.refs || [],
    rows_count: Array.isArray(saved.item.rows) ? saved.item.rows.length : 0
  });
});

app.post("/ocr/qrpay_base64", express.json({ limit: "12mb" }), async (req, res) => {
  try {
    const b64 = req.body?.image_base64;
    if (!b64) {
      return res.status(400).json({ ok: false, error: "image_base64_required" });
    }
    const amountVal = req.body?.amount ?? null;
    const timeVal = req.body?.time ?? null;
    const amount = amountVal !== null ? Number(amountVal) : null;
    const timeMin = timeVal ? parseTimeMinutes(String(timeVal)) : null;

    const buffer = Buffer.from(String(b64), "base64");
    const text = await runVisionOcrBuffer(buffer);
    const parsed = parseQrPayText(text, amount, timeMin);

    const refsFound = parsed.rows.map(r => r.ref).filter(Boolean);
    return res.json({
      ok: true,
      best_row: parsed.best_row,
      rows_count: parsed.rows.length,
      refs_found: refsFound,
      text_len: text.length,
      text_sample: text.slice(0, 500)
    });
  } catch (err) {
    log(`ocr_error ${err.message}`);
    return res.status(500).json({ ok: false, error: "ocr_failed", message: err.message });
  }
});

app.post("/ocr/qrpay", rawImage, upload.any(), async (req, res) => {
  try {
    const file = Array.isArray(req.files) ? req.files[0] : null;
    const buffer = file?.buffer
      || (Buffer.isBuffer(req.body) && req.body.length ? req.body : null);
    if (!buffer) {
      return res.status(400).json({ ok: false, error: "file_required" });
    }
    const amountVal = req.body?.amount ?? req.query?.amount ?? null;
    const timeVal = req.body?.time ?? req.query?.time ?? null;
    const amount = amountVal !== null ? Number(amountVal) : null;
    const timeMin = timeVal ? parseTimeMinutes(String(timeVal)) : null;

    const text = await runVisionOcrBuffer(buffer);
    const parsed = parseQrPayText(text, amount, timeMin);

    const refsFound = parsed.rows.map(r => r.ref).filter(Boolean);
    return res.json({
      ok: true,
      best_row: parsed.best_row,
      rows_count: parsed.rows.length,
      refs_found: refsFound,
      text_len: text.length,
      text_sample: text.slice(0, 500)
    });
  } catch (err) {
    log(`ocr_error ${err.message}`);
    return res.status(500).json({ ok: false, error: "ocr_failed", message: err.message });
  }
});

app.get("/job/status/:jobid", (req, res) => {
  requeueExpired();
  const jobId = String(req.params.jobid);
  if (!status.has(jobId)) {
    return res.status(404).json({ ok: false, error: "job_not_found" });
  }

  const state = status.get(jobId);
  const payload = { ok: true, job_id: jobId, status: state };
  if (state === "done") {
    payload.result = results.get(jobId) || null;
  }
  return res.json(payload);
});

app.get("/health", (req, res) => {
  return res.json({ ok: true });
});

app.listen(config.port, config.bind, () => {
  log(`listening http://${config.bind}:${config.port}`);
});
