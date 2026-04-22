import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { addAttempt, isExceeded, resetAttempt } from './attempt-handler.js';
import writeAutoData from './autodata-writer.js';
import runAutoProcess from './runAutoProcess.js';
import validateSlipOCR, { getReceiptHash, saveUsedSlip, saveUsedReference } from './validateSlipOCR.js';
import convertPdfToImage from './pdfToImage.js';

// Elak process mati akibat EPIPE (stdout ditutup)
process.stdout.on('error', err => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', err => { if (err.code !== 'EPIPE') throw err; });

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:3005';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'change-me';
const BRIDGE_POLL_MS = Number(process.env.BRIDGE_POLL_MS || 3000);
const BRIDGE_TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 120000);
const QRPAY_NOTIF_STORE_PATH = path.join(process.cwd(), 'tasker-bridge', 'data', 'qrpaybiz_notifications.json');
const PENDING_REVIEW_PATH = path.join(process.cwd(), 'pending_review_qrpay.json');
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS || 15 * 60 * 1000);
const BALANCE_ALERT_THRESHOLD = Number(process.env.BALANCE_ALERT_THRESHOLD || 150);
const ADMIN_NOTIFY_NUMBER = (process.env.ADMIN_NOTIFY_NUMBER || '60106000456').replace(/[^\d]/g, '');
const RESET_KEYWORDS = new Set(['0', 'reset', 'mula', 'menu']);

const userSessions = {};
const PAYMENT_QR_BASENAME = 'QR ALMARBAWI VENTURE';
const PAYMENT_QR_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

const isDummySlip = (text = '') => text.trim().toLowerCase() === 'dummy slip';
const mainMenuText = `Bot Almarbawi OneXOX
Assalamualaikum! Saya akan bantu anda untuk menjalankan transaksi eRecharge dan topup secara automatik.

Peringatan:
- Pastikan maklumat yang diberikan betul. Jika berlaku kesilapan, tiada refund.
- Pastikan pembayaran dibuat ke akaun:
ALMARBAWI PLT
8605524398 (CIMB ISLAMIC BANK)

1. eRecharge Prepaid (Dealer ke Dealer)
2. eRecharge Postpay (Dealer ke Dealer)
3. Topup (Pelanggan)
4. Customer Service (Percubaan)

Sila taip nombor pilihan anda. Tekan 0 untuk kembali ke menu.`;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    // WhatsApp stopped auto-printing QR; handled via connection.update below
    browser: ['Chrome (OneXOX Bot)', 'Chrome', '127']
  });

  sock.ev.on('creds.update', saveCreds);

  async function sendMsg(to, text) {
    await sock.sendMessage(to, { text });
  }

  function toJid(numberLike) {
    const digits = String(numberLike || '').replace(/[^\d]/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
  }

  function toRm(value) {
    if (!Number.isFinite(value)) return 'N/A';
    return `RM${value.toFixed(2)}`;
  }

  async function notifyAdminIfLowBalance(contextLabel, onesysResult, contextMeta = {}) {
    const balance = onesysResult?.balanceCheck;
    if (!balance?.ok) return;

    const lowTypes = [];
    if (Number.isFinite(balance.prepaid) && balance.prepaid < BALANCE_ALERT_THRESHOLD) {
      lowTypes.push({ type: 'Prepaid', value: balance.prepaid });
    }
    if (Number.isFinite(balance.postpay) && balance.postpay < BALANCE_ALERT_THRESHOLD) {
      lowTypes.push({ type: 'Postpay', value: balance.postpay });
    }
    if (!lowTypes.length) return;

    const adminJid = toJid(ADMIN_NOTIFY_NUMBER);
    if (!adminJid) return;

    const lines = [
      'PERINGATAN BAKI RENDAH ONESYS',
      `Transaksi: ${contextLabel}`,
      `Threshold: ${toRm(BALANCE_ALERT_THRESHOLD)}`,
      ...lowTypes.map((x) => `- ${x.type}: ${toRm(x.value)}`),
      `Baki semasa (Prepaid/Postpay): ${toRm(balance.prepaid)} / ${toRm(balance.postpay)}`
    ];
    if (contextMeta?.from) lines.push(`Pelanggan: ${contextMeta.from}`);
    if (contextMeta?.dealerId) lines.push(`Dealer ID: ${contextMeta.dealerId}`);
    if (contextMeta?.phone) lines.push(`No Telefon: ${contextMeta.phone}`);
    if (Number.isFinite(contextMeta?.amount)) lines.push(`Jumlah: ${toRm(contextMeta.amount)}`);

    try {
      await sendMsg(adminJid, lines.join('\n'));
      console.log('[BALANCE_ALERT] Notifikasi admin dihantar', { adminJid, lowTypes });
    } catch (err) {
      console.warn('[BALANCE_ALERT] Gagal hantar notifikasi admin:', err.message);
    }
  }

  async function notifyAdminOnesysFailure(contextLabel, contextMeta = {}, reason = null) {
    const adminJid = toJid(ADMIN_NOTIFY_NUMBER);
    if (!adminJid) return;

    const lines = [
      'ALERT KEGAGALAN ONESYS',
      `Transaksi: ${contextLabel}`,
      reason ? `Sebab: ${reason}` : 'Sebab: Ralat semasa proses OneSys'
    ];
    if (contextMeta?.from) lines.push(`Pelanggan: ${contextMeta.from}`);
    if (contextMeta?.dealerId) lines.push(`Dealer ID: ${contextMeta.dealerId}`);
    if (contextMeta?.phone) lines.push(`No Telefon: ${contextMeta.phone}`);
    if (Number.isFinite(contextMeta?.amount)) lines.push(`Jumlah: ${toRm(contextMeta.amount)}`);

    try {
      await sendMsg(adminJid, lines.join('\n'));
      console.log('[ONESYS_FAIL_ALERT] Notifikasi admin dihantar', { adminJid, contextLabel });
    } catch (err) {
      console.warn('[ONESYS_FAIL_ALERT] Gagal hantar notifikasi admin:', err.message);
    }
  }

  async function handleReceiptFailure(from, reasonText) {
    const count = addAttempt(from);
    if (isExceeded(from)) {
      return resetToMainMenu(from, `${reasonText}\nGagal berkaitan resit telah berlaku 3 kali. Sesi transaksi direset.`);
    }
    return sendMsg(
      from,
      `${reasonText}\nSila cuba semula. Percubaan resit: ${count}/3.`
    );
  }

  function resolvePaymentQrPath() {
    for (const ext of PAYMENT_QR_EXTENSIONS) {
      const p = path.join(process.cwd(), `${PAYMENT_QR_BASENAME}${ext}`);
      if (fs.existsSync(p)) return p;
    }
    if (fs.existsSync(path.join(process.cwd(), PAYMENT_QR_BASENAME))) {
      return path.join(process.cwd(), PAYMENT_QR_BASENAME);
    }
    const files = fs.readdirSync(process.cwd(), { withFileTypes: true });
    const hit = files.find(f =>
      f.isFile() && f.name.toUpperCase().startsWith(PAYMENT_QR_BASENAME.toUpperCase())
    );
    return hit ? path.join(process.cwd(), hit.name) : null;
  }

  const paymentQrPath = resolvePaymentQrPath();
  if (paymentQrPath) {
    console.log(`QR pembayaran ditemui: ${paymentQrPath}`);
  } else {
    console.warn(`QR pembayaran tidak ditemui. Letak fail bernama "${PAYMENT_QR_BASENAME}.jpg/.png/.jpeg/.webp"`);
  }

  async function sendPaymentQrAndPrompt(from) {
    if (paymentQrPath) {
      const imageBuffer = fs.readFileSync(paymentQrPath);
      await sock.sendMessage(from, {
        image: imageBuffer,
        caption: 'Sila buat pembayaran melalui QR berikut.'
      });
    } else {
      await sendMsg(
        from,
        'Sila buat pembayaran melalui QR. (Gambar QR tidak ditemui di server, sila maklumkan admin.)'
      );
    }

    await sendMsg(
      from,
      `**Langkah 3/3:**
Sila hantarkan **bukti pembayaran** (.jpg/.png/pdf/screenshot).
Bukti hendaklah mempunyai butiran:
- Tarikh
- Jumlah

Tekan 0 jika mahu buat pembetulan.`
    );
  }

  function resetSession(from) {
    userSessions[from] = {
      flow: '',
      step: 0,
      dealerId: '',
      phone: '',
      amount: 0,
      rechargeMode: '',
      updatedAt: Date.now()
    };
  }

  function touchSession(from) {
    if (!userSessions[from]) resetSession(from);
    userSessions[from].updatedAt = Date.now();
  }

  function isSessionExpired(from) {
    const s = userSessions[from];
    if (!s?.updatedAt) return false;
    return Date.now() - s.updatedAt > SESSION_TIMEOUT_MS;
  }

  function resetConversation(from) {
    resetAttempt(from);
    resetSession(from);
  }

  async function resetToMainMenu(from, reasonText = null) {
    resetConversation(from);
    const text = reasonText ? `${reasonText}\n\n${mainMenuText}` : mainMenuText;
    return sendMsg(from, text);
  }

  async function submitBridgeJob(payload) {
    console.log('[QRPAY] submitBridgeJob ->', payload);
    const res = await fetch(`${BRIDGE_URL}/job/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': BRIDGE_API_KEY
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bridge submit gagal: ${res.status} ${text}`);
    }
    const json = await res.json();
    console.log('[QRPAY] submitBridgeJob <-', json);
    return json;
  }

  async function getBridgeStatus(jobId) {
    const res = await fetch(`${BRIDGE_URL}/job/status/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: { 'X-API-KEY': BRIDGE_API_KEY }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bridge status gagal: ${res.status} ${text}`);
    }
    return res.json();
  }

  async function waitBridgeResult(jobId) {
    console.log(`[QRPAY] Menunggu keputusan bridge untuk ${jobId}`);
    const start = Date.now();
    while (Date.now() - start < BRIDGE_TIMEOUT_MS) {
      const status = await getBridgeStatus(jobId);
      console.log(`[QRPAY] status ${jobId}:`, status);
      if (status.status === 'done') return status.result || null;
      await new Promise(r => setTimeout(r, BRIDGE_POLL_MS));
    }
    throw new Error('Bridge timeout');
  }

  function normalizeRef(val) {
    return String(val || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function expandRefAliases(val) {
    const n = normalizeRef(val);
    const aliases = new Set();
    if (!n) return aliases;
    aliases.add(n);
    if (n.startsWith('QR') && n.length > 2) aliases.add(n.slice(2));
    if (/^[A-Z0-9]{8}$/.test(n)) aliases.add(`QR${n}`);
    return aliases;
  }

  function hasCommonContiguousSubstring(a, b, minLen = 6) {
    const x = normalizeRef(a);
    const y = normalizeRef(b);
    if (!x || !y) return false;
    if (x.length < minLen || y.length < minLen) return false;
    const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
    for (let len = Math.min(shorter.length, longer.length); len >= minLen; len--) {
      for (let i = 0; i + len <= shorter.length; i++) {
        const sub = shorter.slice(i, i + len);
        if (longer.includes(sub)) return true;
      }
    }
    return false;
  }

  function parseTimeToMinutes(text) {
    const m = String(text || '').match(/\b([0-9]{1,2}):([0-9]{2})(?:\s*(AM|PM))?\b/i);
    if (!m) return null;
    let h = Number(m[1]);
    const mi = Number(m[2]);
    const mer = m[3] ? m[3].toUpperCase() : null;
    if (mer === 'PM' && h < 12) h += 12;
    if (mer === 'AM' && h === 12) h = 0;
    return h * 60 + mi;
  }

  function malaysiaDateKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(date);
  }

  function loadQrpayNotifStore() {
    try {
      if (!fs.existsSync(QRPAY_NOTIF_STORE_PATH)) return null;
      return JSON.parse(fs.readFileSync(QRPAY_NOTIF_STORE_PATH, 'utf8'));
    } catch (err) {
      console.warn('[QRPAY] Gagal baca fail noti:', err.message);
      return null;
    }
  }

  function appendPendingReview(item) {
    try {
      const today = malaysiaDateKey();
      let data = { date: today, items: [] };
      if (fs.existsSync(PENDING_REVIEW_PATH)) {
        data = JSON.parse(fs.readFileSync(PENDING_REVIEW_PATH, 'utf8'));
      }
      if (!data || data.date !== today || !Array.isArray(data.items)) {
        data = { date: today, items: [] };
      }
      data.items.push({ id: `pr-${Date.now()}`, created_at: new Date().toISOString(), ...item });
      fs.writeFileSync(PENDING_REVIEW_PATH, JSON.stringify(data, null, 2));
      console.log('[QRPAY] pending_review ditambah', { reason_code: item.reason_code, from: item.from });
    } catch (err) {
      console.warn('[QRPAY] Gagal simpan pending_review:', err.message);
    }
  }

  function findStoredQrpayMatch({ ref, refCandidates, amount, timeText, shopeeMeta }) {
    const store = loadQrpayNotifStore();
    if (!store || store.date !== malaysiaDateKey() || !Array.isArray(store.items)) {
      return { kind: 'none', reasonCode: 'QRPAY_NOTIF_STORE_EMPTY_OR_STALE' };
    }

    const expectedRefs = new Set();
    for (const candidate of [ref, ...(refCandidates || [])]) {
      for (const alias of expandRefAliases(candidate)) expectedRefs.add(alias);
    }
    const expectedAmount = Number(amount);
    const expectedTimeMin = parseTimeToMinutes(timeText);
    let bestExact = null;
    const fuzzyCandidates = [];

    for (let i = store.items.length - 1; i >= 0; i--) {
      const item = store.items[i];
      if (!item || item.used) continue;
      const rows = Array.isArray(item.rows) && item.rows.length ? item.rows : (item.best_row ? [item.best_row] : []);
      for (const row of rows) {
        const rowRef = normalizeRef(row?.ref || row?.ref_qrpay || '');
        if (!rowRef) continue;
        const refExactOrAliasMatch = expectedRefs.has(rowRef);
        const refFuzzyMatch = !refExactOrAliasMatch && Array.from(expectedRefs).some(r => hasCommonContiguousSubstring(r, rowRef, 6));
        if (!refExactOrAliasMatch && !refFuzzyMatch) continue;
        const rowAmount = Number(row?.amount);
        if (!Number.isFinite(rowAmount) || Math.abs(rowAmount - expectedAmount) > 0.01) continue;

        const rowTime = (row?.time === null || row?.time === undefined || row?.time === '')
          ? null
          : Number(row?.time);
        const timeScore = (Number.isFinite(expectedTimeMin) && Number.isFinite(rowTime))
          ? Math.abs(rowTime - expectedTimeMin)
          : 999;
        const timeOk = !Number.isFinite(expectedTimeMin) || !Number.isFinite(rowTime) || timeScore <= 20;
        if (!timeOk) continue;

        const candidate = {
          notificationId: item.id,
          timeScore,
          row: {
            ...(row || {}),
            ref_qrpay: row?.ref_qrpay || row?.ref || null,
            notification_id: item.id,
            ref_match_mode: refExactOrAliasMatch ? 'exact_or_alias' : 'substring6'
          }
        };

        if (refExactOrAliasMatch) {
          if (!bestExact || timeScore < bestExact.timeScore) bestExact = candidate;
        } else {
          fuzzyCandidates.push(candidate);
        }
      }
    }

    if (bestExact) return { kind: 'match', candidate: bestExact };

    // Fallback substring6 hanya selamat jika calon unik.
    const uniqueFuzzyKeys = new Set(
      fuzzyCandidates.map(c => `${c.notificationId}|${normalizeRef(c.row?.ref_qrpay || c.row?.ref || '')}|${String(c.row?.amount ?? '')}`)
    );
    if (uniqueFuzzyKeys.size !== 1) {
      if (fuzzyCandidates.length > 1) {
        console.log('[QRPAY] Fuzzy ref ambiguous, abaikan auto-match', {
          fuzzyCandidates: fuzzyCandidates.length,
          uniqueKeys: uniqueFuzzyKeys.size
        });
        return { kind: 'ambiguous', reasonCode: 'QRPAY_AMBIGUOUS_MATCH', candidates: fuzzyCandidates.length };
      }
      return { kind: 'none', reasonCode: 'QRPAY_REF_NOT_MATCHED' };
    }

    fuzzyCandidates.sort((a, b) => a.timeScore - b.timeScore);
    if (fuzzyCandidates[0]) return { kind: 'match', candidate: fuzzyCandidates[0] };

    // Last-resort fallback for ShopeePay slips:
    // allow unique amount+time match when no usable transaction reference.
    if (shopeeMeta?.isShopeeLike && (shopeeMeta?.transactionSn || shopeeMeta?.orderSn)) {
      const fallbackCandidates = [];
      for (let i = store.items.length - 1; i >= 0; i--) {
        const item = store.items[i];
        if (!item || item.used) continue;
        const rows = Array.isArray(item.rows) && item.rows.length ? item.rows : (item.best_row ? [item.best_row] : []);
        for (const row of rows) {
          const rowAmount = Number(row?.amount);
          if (!Number.isFinite(rowAmount) || Math.abs(rowAmount - expectedAmount) > 0.01) continue;
          const rowTime = (row?.time === null || row?.time === undefined || row?.time === '')
            ? null
            : Number(row?.time);
          const timeScore = (Number.isFinite(expectedTimeMin) && Number.isFinite(rowTime))
            ? Math.abs(rowTime - expectedTimeMin)
            : 999;
          const timeOk = !Number.isFinite(expectedTimeMin) || !Number.isFinite(rowTime) || timeScore <= 10;
          if (!timeOk) continue;
          fallbackCandidates.push({
            notificationId: item.id,
            timeScore,
            row: {
              ...(row || {}),
              ref_qrpay: row?.ref_qrpay || row?.ref || null,
              notification_id: item.id,
              ref_match_mode: 'amount_time_fallback_shopeepay'
            }
          });
        }
      }
      const uniqueNotif = new Set(fallbackCandidates.map(c => c.notificationId));
      if (uniqueNotif.size === 1 && fallbackCandidates.length > 0) {
        fallbackCandidates.sort((a, b) => a.timeScore - b.timeScore);
        return { kind: 'match', candidate: fallbackCandidates[0] };
      }
      if (fallbackCandidates.length > 1) {
        return { kind: 'ambiguous', reasonCode: 'QRPAY_SHOPEE_FALLBACK_AMBIGUOUS', candidates: fallbackCandidates.length };
      }
    }

    return { kind: 'none', reasonCode: 'QRPAY_REF_NOT_MATCHED' };
  }

  function markQrpayNotificationUsed(notificationId, meta = {}) {
    try {
      if (!notificationId || !fs.existsSync(QRPAY_NOTIF_STORE_PATH)) return false;
      const store = JSON.parse(fs.readFileSync(QRPAY_NOTIF_STORE_PATH, 'utf8'));
      if (!store || !Array.isArray(store.items)) return false;
      const item = store.items.find(x => x.id === notificationId);
      if (!item) return false;
      item.used = true;
      item.used_at = new Date().toISOString();
      item.used_by_job_id = meta.jobId || item.used_by_job_id || null;
      item.used_by_whatsapp = meta.from || item.used_by_whatsapp || null;
      fs.writeFileSync(QRPAY_NOTIF_STORE_PATH, JSON.stringify(store, null, 2));
      console.log('[QRPAY] Noti ditanda used:', notificationId);
      return true;
    } catch (err) {
      console.warn('[QRPAY] Gagal tanda noti used:', err.message);
      return false;
    }
  }

  async function verifyQrPayMatchInternal({ from, ref, refCandidates, amount, timeText, shopeeMeta }) {
    const digits = String(from || "").replace(/\D/g, "");
    const last4 = digits.slice(-4) || "user";
    const jobId = `job-${last4}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    console.log('[QRPAY] verify start', { jobId, ref, refCandidates, amount, timeText, shopeeMeta });
    const start = Date.now();
    let lastReasonCode = 'QRPAY_NOTIF_TIMEOUT';
    let ambiguousCount = 0;
    while (Date.now() - start < BRIDGE_TIMEOUT_MS) {
      const result = findStoredQrpayMatch({ ref, refCandidates, amount, timeText, shopeeMeta });
      if (result?.kind === 'match' && result.candidate) {
        const hit = result.candidate;
        console.log('[QRPAY] padanan noti ditemui', { jobId, notificationId: hit.notificationId, row: hit.row });
        return {
          jobId,
          isMatch: true,
          refQr: hit.row?.ref_qrpay || hit.row?.ref || null,
          reason: 'match',
          notificationId: hit.notificationId,
          matchedRef: hit.row?.ref_qrpay || hit.row?.ref || null,
          refMatchMode: hit.row?.ref_match_mode || null
        };
      }
      if (result?.reasonCode) lastReasonCode = result.reasonCode;
      if (result?.kind === 'ambiguous') ambiguousCount = result.candidates || ambiguousCount;
      await new Promise(r => setTimeout(r, BRIDGE_POLL_MS));
    }
    const err = new Error('QRPay notification timeout');
    err.code = lastReasonCode;
    err.meta = { ambiguousCount };
    throw err;
  }

  let qrpayBusy = false;
  const qrpayQueue = [];
  function enqueueQrPayCheck(from, params) {
    return new Promise((resolve, reject) => {
      qrpayQueue.push({ from, params, resolve, reject });
      processQrPayQueue();
    });
  }
  async function processQrPayQueue() {
    if (qrpayBusy) return;
    const item = qrpayQueue.shift();
    if (!item) return;
    qrpayBusy = true;
    try {
      if (qrpayQueue.length > 0) {
        await sendMsg(item.from, "Sistem sedang proses transaksi lain. Sila tunggu sebentar...");
      }
      const res = await verifyQrPayMatchInternal({ from: item.from, ...item.params });
      item.resolve(res);
    } catch (err) {
      item.reject(err);
    } finally {
      qrpayBusy = false;
      processQrPayQueue();
    }
  }

  async function processSlip(msg, session, from) {
    const msgTypes = Object.keys(msg.message);
    let slipPath = '';

    if (msgTypes.includes('documentMessage') && msg.message.documentMessage.mimetype === 'application/pdf') {
      // Pengguna hantar PDF
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
      const pdfPath = path.join('slips', `${from}-${Date.now()}.pdf`);
      fs.writeFileSync(pdfPath, buffer);
      slipPath = await convertPdfToImage(pdfPath, 'slips', 1);
    } else if (msgTypes.includes('imageMessage')) {
      // Pengguna hantar imej
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
      slipPath = path.join('slips', `${from}-${Date.now()}.jpg`);
      fs.writeFileSync(slipPath, buffer);
    }

    return slipPath;
  }

  async function checkCorrection(from, textUser) {
    if (textUser === '0') {
      resetConversation(from);
      return sendMsg(from, `Pembetulan diterima. Sila pilih semula:
1. eRecharge Prepaid (Dealer ke Dealer)
2. eRecharge Postpay (Dealer ke Dealer)
3. Topup (Pelanggan)
4. Customer Service (Percubaan)`);
    }
    return false;
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const textUser = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    const lowerTextUser = textUser.toLowerCase();

    if (userSessions[from] && isSessionExpired(from)) {
      console.log(`[SESSION] Timeout reset untuk ${from}`);
      await resetToMainMenu(from, 'Sesi tamat kerana tiada aktiviti. Sila mulakan semula.');
      return;
    }

    // Global reset keywords - immediate reset to main menu
    if (RESET_KEYWORDS.has(lowerTextUser)) {
      resetConversation(from);
      return sendMsg(from, mainMenuText);
    }

    // Jika pelanggan menghantar "terima kasih menggunakan khidmat kami"
    if (lowerTextUser === 'terima kasih menggunakan khidmat kami') {
      return sendMsg(from, 'Terima kasih kerana menggunakan khidmat kami.');
    }

    if (!userSessions[from]) resetSession(from);
    touchSession(from);
    const session = userSessions[from];

    // --------------------- ALIRAN UTAMA (Pilihan Menu) ---------------------
    if (session.step === 0) {
      if (textUser === '1') {
        session.flow = 'erecharge';
        session.rechargeMode = 'erecharge_prepaid';
        session.step = 1;
        return sendMsg(
          from,
          `**Langkah 1/3 (eRecharge Prepaid):**
Sila masukkan **ID Dealer** sahaja (contoh: dysd123).
Tekan 0 jika mahu buat pembetulan.`
        );
      }
      if (textUser === '2') {
        session.flow = 'erecharge';
        session.rechargeMode = 'erecharge_postpay';
        session.step = 1;
        return sendMsg(
          from,
          `**Langkah 1/3 (eRecharge Postpay):**
Sila masukkan **ID Dealer** sahaja (contoh: dysd123).
Tekan 0 jika mahu buat pembetulan.`
        );
      }
      if (textUser === '3') {
        session.flow = 'topup';
        session.step = 'manual';
        return sendMsg(
          from,
          `Anda memilih Topup.
Transaksi akan dijalankan secara manual oleh staf, mohon maaf atas kesulitan.
Jika anda setuju, balas "ya".
Tekan 0 jika mahu buat pembetulan.`
        );
      }
      if (textUser === '4') {
        session.flow = 'cs';
        session.step = 'cs';
        return sendMsg(
          from,
          `Customer Service dipilih.
Sila tunggu sebentar, staf kami akan membantu anda secepat mungkin.`
        );
      }
      // Mesej permulaan dikemaskini
      return sendMsg(from, mainMenuText);
    }

    if (await checkCorrection(from, textUser)) return;

    // --------------------- ERECHARGE FLOW ---------------------
    if (session.flow === 'erecharge') {
      // Tahap pengesahan maklumat sebelum bukti pembayaran
      if (session.step === 'confirm') {
        if (textUser.toLowerCase() === 'ya') {
          session.step = 3;
          await sendPaymentQrAndPrompt(from);
          return;
        } else {
          return sendMsg(
            from,
            `Sila pastikan untuk mengesahkan maklumat dengan membalas 'ya' jika betul atau '0' untuk pembetulan.`
          );
        }
      }
      if (session.step === 1) {
        // Pastikan ID Dealer tidak mengandungi ruang atau karakter tambahan
        if (!/^\S+$/.test(textUser)) {
          return sendMsg(
            from,
            `Format ID Dealer salah.
Sila pastikan ID Dealer hanya mengandungi teks tanpa ruang (contoh: dysd123).
Tekan 0 jika mahu buat pembetulan dan cuba masukkan semula.`
          );
        }
        session.dealerId = textUser;
        session.step = 2;
        return sendMsg(
          from,
          `ID Dealer diterima: ${textUser}.
**Langkah 2/3 (${session.rechargeMode === 'erecharge_postpay' ? 'eRecharge Postpay' : 'eRecharge Prepaid'}):**
Sila masukkan **jumlah eRecharge** (contoh: 50).
Tekan 0 jika mahu buat pembetulan.`
        );
      }
      if (session.step === 2) {
        const amt = parseFloat(textUser);
        if (isNaN(amt) || amt <= 0) {
          return sendMsg(
            from,
            `Jumlah tidak sah. Sila taip semula.
Tekan 0 jika mahu buat pembetulan.`
          );
        }
        session.amount = amt;

        // Kira bonus: struktur baharu ikut mode & amaun
        let bonus = 0;
        if (session.rechargeMode === 'erecharge_prepaid') {
          // Prepaid: 2% for RM50 and below, 5% for RM51 and above
          bonus = amt > 50 ? 5 : 2;
        } else if (session.rechargeMode === 'erecharge_postpay') {
          // Postpay: 2% for RM50 and below, 2.5% for RM51 and above
          bonus = amt > 50 ? 2.5 : 2;
        }
        const totalWithBonus = amt + (amt * bonus) / 100;

        session.step = 'confirm';
        const label = session.rechargeMode === 'erecharge_postpay' ? 'eRecharge Postpay' : 'eRecharge Prepaid';
        return sendMsg(
          from,
          `Jumlah ${label} diterima: RM${amt.toFixed(2)}.
Ini adalah maklumat yang anda beri:
* ID Dealer: ${session.dealerId}
* Jumlah: RM${amt.toFixed(2)} (Dealer akan terima: RM${totalWithBonus.toFixed(2)} dengan bonus ${bonus}%)

Jika maklumat adalah betul, balas 'ya'. Tekan 0 untuk pembetulan.`
        );
      }
      if (session.step === 3) {
        try {
          // Selepas slip diterima, terus bagi mesej "Harap bersabar, sedang disemak"
          // sebelum kita jalankan OCR.
          await sendMsg(from, `Slip diterima. Harap bersabar, pembayaran anda sedang disemak...`);

          let slip;
          let skipSlipValidation = false;
          let ocrResult = null;

          if (isDummySlip(textUser)) {
            skipSlipValidation = true;
            await sendMsg(from, `Mod percubaan: "dummy slip" diterima, semakan slip dikeluarkan.`);
          } else {
            slip = await processSlip(msg, session, from);
            if (!slip) {
              return handleReceiptFailure(from, 'Gagal simpan slip. Pastikan hantar gambar/PDF yang sah.');
            }
            const result = await validateSlipOCR(slip, session.amount);
            if (!result.success) {
              return handleReceiptFailure(
                from,
                `Slip tidak sah: ${result.reason}. Jika anda hantar PDF, cuba hantar gambar atau jika anda hantar gambar, cuba hantar PDF.`
              );
            }
            resetAttempt(from);
            ocrResult = result; // simpan ref/compHash untuk digunakan jika berjaya
          }

          if (!skipSlipValidation && ocrResult?.reference) {
            await sendMsg(from, `Semakan QRPay sedang dijalankan...`);
            try {
              console.log('[QRPAY] enqueue check', {
                from,
                ref: ocrResult.reference,
                refCandidates: ocrResult.refCandidates,
                amount: session.amount,
                timeText: ocrResult.timeText
              });
              const qrCheck = await enqueueQrPayCheck(from, {
                ref: ocrResult.reference,
                refCandidates: ocrResult.refCandidates,
                amount: session.amount,
                timeText: ocrResult.timeText,
                shopeeMeta: ocrResult.shopeeMeta || null
              });
              if (!qrCheck.isMatch) {
                return handleReceiptFailure(from, 'Semakan QRPay tidak sepadan. Sila semak semula bukti pembayaran dan cuba lagi.');
              }
              if (qrCheck.matchedRef) {
                const matchedRef = String(qrCheck.matchedRef).toUpperCase();
                if (!ocrResult.refCandidates?.includes(matchedRef)) {
                  ocrResult.refCandidates = [matchedRef, ...(ocrResult.refCandidates || [])];
                }
                ocrResult.reference = matchedRef;
              }
              ocrResult.qrpayNotificationId = qrCheck.notificationId || null;
              ocrResult.qrpayJobId = qrCheck.jobId || null;
            } catch (err) {
              console.error(err);
              appendPendingReview({
                reason_code: err.code || 'QRPAY_VERIFY_ERROR',
                flow: session.flow || 'erecharge',
                from,
                amount: session.amount,
                ocr_reference: ocrResult?.reference || null,
                ocr_ref_candidates: ocrResult?.refCandidates || [],
                ocr_time: ocrResult?.timeText || null,
                shopee_meta: ocrResult?.shopeeMeta || null,
                error_message: err.message,
                error_meta: err.meta || null
              });
              return handleReceiptFailure(from, 'Gagal semak QRPay. Sila cuba semula sebentar lagi.');
            }
          }

          // Slip disahkan atau dilangkau, tulis data & runAutoProcess
          const rechargeMode = session.rechargeMode || 'erecharge_prepaid';
          writeAutoData({ mode: rechargeMode, dealerId: session.dealerId, amount: session.amount });
          const onesysResult = await runAutoProcess(rechargeMode);
          if (onesysResult.success) {
            // Simpan ref/hash hanya jika transaksi berjaya dan slip sebenar digunakan
            if (!skipSlipValidation && slip && ocrResult) {
              if (ocrResult.compHash) saveUsedSlip(ocrResult.compHash);
              if (ocrResult.reference) saveUsedReference(ocrResult.reference);
              if (ocrResult?.shopeeMeta?.receiptMarker) saveUsedReference(ocrResult.shopeeMeta.receiptMarker);
            }
            if (!skipSlipValidation && ocrResult?.qrpayNotificationId) {
              markQrpayNotificationUsed(ocrResult.qrpayNotificationId, { jobId: ocrResult.qrpayJobId, from });
            }
            await notifyAdminIfLowBalance(
              session.rechargeMode === 'erecharge_postpay' ? 'eRecharge Postpay' : 'eRecharge Prepaid',
              onesysResult,
              { from, dealerId: session.dealerId, amount: session.amount }
            );

            resetConversation(from);
            return sendMsg(
              from,
              `${session.rechargeMode === 'erecharge_postpay' ? 'eRecharge Postpay' : 'eRecharge Prepaid'} berjaya. Terima kasih kerana menggunakan khidmat kami.`
            );
          } else {
            await notifyAdminOnesysFailure(
              session.rechargeMode === 'erecharge_postpay' ? 'eRecharge Postpay' : 'eRecharge Prepaid',
              { from, dealerId: session.dealerId, amount: session.amount },
              onesysResult?.message || null
            );
            return resetToMainMenu(
              from,
              `${session.rechargeMode === 'erecharge_postpay' ? 'eRecharge Postpay' : 'eRecharge Prepaid'} gagal kerana ralat OneSys.
Admin telah dimaklumkan. Sila cuba semula atau hubungi admin melalui WhatsApp: [Klik sini](https://wa.me/60106000456)`
            );
          }
        } catch (err) {
          console.error(err);
          return resetToMainMenu(from, 'Gagal proses slip. Sila cuba semula.');
        }
      }
    }

    // --------------------- TOPUP FLOW ---------------------
    if (session.flow === 'topup') {
      // Tahap pengesahan maklumat sebelum bukti pembayaran
      if (session.step === 'manual') {
        if (textUser.toLowerCase() === 'ya') {
          session.step = 1;
          return sendMsg(
            from,
            `**Langkah 1/3:**
Sila masukkan **nombor telefon pelanggan** (contoh: 01112345678).
Tekan 0 jika mahu buat pembetulan.`
          );
        } else {
          return sendMsg(
            from,
            `Sila balas 'ya' untuk meneruskan topup atau '0' untuk pembetulan.`
          );
        }
      }
      if (session.step === 'confirm') {
        if (textUser.toLowerCase() === 'ya') {
          session.step = 3;
          await sendPaymentQrAndPrompt(from);
          return;
        } else {
          return sendMsg(
            from,
            `Sila pastikan untuk mengesahkan maklumat dengan membalas 'ya' jika betul atau '0' untuk pembetulan.`
          );
        }
      }
      if (session.step === 1) {
        session.phone = textUser;
        session.step = 2;
        return sendMsg(
          from,
          `No telefon diterima: ${textUser}.
**Langkah 2/3:**
Sila masukkan **jumlah Topup** (contoh: 10).
Tekan 0 jika mahu buat pembetulan.`
        );
      }
      if (session.step === 2) {
        const amt = parseFloat(textUser);
        if (isNaN(amt) || amt <= 0) {
          return sendMsg(
            from,
            `Jumlah tidak sah. Sila taip semula.
Tekan 0 jika mahu buat pembetulan.`
          );
        }
        session.amount = amt;

        // Masuk ke tahap pengesahan
        session.step = 'confirm';
        return sendMsg(
          from,
          `Jumlah Topup diterima: RM${amt.toFixed(2)}.
Ini adalah maklumat yang anda beri:
* No Telefon: ${session.phone}
* Jumlah Topup: RM${amt.toFixed(2)}

Jika maklumat adalah betul, balas 'ya'. Tekan 0 untuk pembetulan.`
        );
      }
      if (session.step === 3) {
        try {
          // Selepas slip diterima, beri mesej "Harap bersabar, sedang disemak"
          await sendMsg(from, `Slip diterima. Harap bersabar, pembayaran anda sedang disemak...`);

          let slip;
          let skipSlipValidation = false;
          let ocrResult = null;

          if (isDummySlip(textUser)) {
            skipSlipValidation = true;
            await sendMsg(from, `Mod percubaan: "dummy slip" diterima, semakan slip dikeluarkan.`);
          } else {
            slip = await processSlip(msg, session, from);
            if (!slip) {
              return handleReceiptFailure(from, 'Gagal simpan slip. Pastikan hantar gambar/PDF yang sah.');
            }
            const result = await validateSlipOCR(slip, session.amount);
            if (!result.success) {
              return handleReceiptFailure(
                from,
                `Slip tidak sah: ${result.reason}. Jika anda hantar PDF, cuba hantar gambar atau jika anda hantar gambar, cuba hantar PDF.`
              );
            }
            resetAttempt(from);
            ocrResult = result; // simpan ref/compHash untuk digunakan jika berjaya
          }

          if (!skipSlipValidation && ocrResult?.reference) {
            await sendMsg(from, `Semakan QRPay sedang dijalankan...`);
            try {
              const qrCheck = await enqueueQrPayCheck(from, {
                ref: ocrResult.reference,
                refCandidates: ocrResult.refCandidates,
                amount: session.amount,
                timeText: ocrResult.timeText,
                shopeeMeta: ocrResult.shopeeMeta || null
              });
              if (!qrCheck.isMatch) {
                return handleReceiptFailure(from, 'Semakan QRPay tidak sepadan. Sila semak semula bukti pembayaran dan cuba lagi.');
              }
              if (qrCheck.matchedRef) {
                const matchedRef = String(qrCheck.matchedRef).toUpperCase();
                if (!ocrResult.refCandidates?.includes(matchedRef)) {
                  ocrResult.refCandidates = [matchedRef, ...(ocrResult.refCandidates || [])];
                }
                ocrResult.reference = matchedRef;
              }
              ocrResult.qrpayNotificationId = qrCheck.notificationId || null;
              ocrResult.qrpayJobId = qrCheck.jobId || null;
            } catch (err) {
              console.error(err);
              appendPendingReview({
                reason_code: err.code || 'QRPAY_VERIFY_ERROR',
                flow: session.flow || 'topup',
                from,
                amount: session.amount,
                ocr_reference: ocrResult?.reference || null,
                ocr_ref_candidates: ocrResult?.refCandidates || [],
                ocr_time: ocrResult?.timeText || null,
                shopee_meta: ocrResult?.shopeeMeta || null,
                error_message: err.message,
                error_meta: err.meta || null
              });
              return handleReceiptFailure(from, 'Gagal semak QRPay. Sila cuba semula sebentar lagi.');
            }
          }

          // Slip disahkan atau dilangkau, tulis data & runAutoProcess
          writeAutoData({ mode: 'topup', phone: session.phone, amount: session.amount });
          const onesysResult = await runAutoProcess('topup');
          if (onesysResult.success) {
            // Simpan ref/hash hanya jika transaksi berjaya dan slip sebenar digunakan
            if (!skipSlipValidation && slip && ocrResult) {
              if (ocrResult.compHash) saveUsedSlip(ocrResult.compHash);
              if (ocrResult.reference) saveUsedReference(ocrResult.reference);
              if (ocrResult?.shopeeMeta?.receiptMarker) saveUsedReference(ocrResult.shopeeMeta.receiptMarker);
            }
            if (!skipSlipValidation && ocrResult?.qrpayNotificationId) {
              markQrpayNotificationUsed(ocrResult.qrpayNotificationId, { jobId: ocrResult.qrpayJobId, from });
            }
            await notifyAdminIfLowBalance(
              'Topup',
              onesysResult,
              { from, phone: session.phone, amount: session.amount }
            );

            resetConversation(from);
            return sendMsg(
              from,
              `Topup berjaya. Terima kasih kerana menggunakan khidmat kami.`
            );
          } else {
            await notifyAdminOnesysFailure(
              'Topup',
              { from, phone: session.phone, amount: session.amount },
              onesysResult?.message || null
            );
            return resetToMainMenu(
              from,
              `Topup gagal kerana ralat OneSys.
Admin telah dimaklumkan. Sila cuba semula atau hubungi admin melalui WhatsApp: [Klik sini](https://wa.me/60106000456)`
            );
          }
        } catch (err) {
          console.error(err);
          return resetToMainMenu(from, 'Gagal proses slip. Sila cuba semula.');
        }
      }
    }
  });

  // Auto-reconnect
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR baru diterima. Imbas kod di bawah untuk pautkan peranti:');
      qrcode.generate(qr, { small: true });
      fs.mkdirSync('auth', { recursive: true });
      fs.writeFileSync('auth/latest-qr.txt', qr);
      console.log('Salinan QR disimpan di auth/latest-qr.txt');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`Sambungan terputus. Status kod: ${statusCode}`);
      if (statusCode === 440) {
        console.log('Sesi diganti (conflict). Pastikan hanya satu instans bot berjalan atau logout sesi lain.');
        return;
      }
      if (statusCode !== 401 && statusCode !== 410) {
        console.log('Mencuba reconnect secara automatik...');
        startBot();
      } else {
        console.log('Sesi telah tamat atau tidak sah. Padam folder auth untuk mendapatkan QR baru.');
      }
    } else if (connection === 'open') {
      console.log('Bot WhatsApp telah disambung.');
    }
  });
}

startBot().catch(err => console.error('Gagal mula bot:', err));
