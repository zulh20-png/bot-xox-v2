// validateSlipOCR.js
// Versi stabil (20 Apr 2025) + gabung semua nombor rujukan
// Permintaan baharu:
// - Jika label "Ref" tiada, gabungkan semua jujukan digit (>=4) yang bukan nombor terlarang.
// - Masih tolak slip jika tiada digit selepas tapisan.
// - Reset harian, JSON auto-recover, semak amaun/tarikh/masa/ref, duplikasi hash + Levenshtein.

import moment from 'moment';
import crypto from 'crypto';
import fs from 'fs';

// Konfigurasi
const EXCLUDED_NUMBERS = new Set([
  '8605524398',     // nombor akaun penerima
  '196001000142',   // MBB registration 1
  '200701029411'    // MBB registration 2
]);
const EXCLUDED_REF_PATTERNS = [
  /^MBBQR\d{4,}$/i // nombor akaun QR merchant (bukan reference transaksi)
];

const SLIPS_FILE = 'used_slips.json';
const REFS_FILE = 'used_references.json';
const MALAYSIA_UTC_OFFSET_MINUTES = 8 * 60;
const MONTH_TOKEN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_PATTERNS = [
  /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g,
  /\b\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}\b/g,
  new RegExp(`\\b\\d{1,2}\\s+${MONTH_TOKEN}\\s+\\d{2,4}\\b`, 'gi')
];
const DATE_FORMATS = [
  'DD/MM/YYYY','D/M/YYYY','DD/MM/YY','D/M/YY',
  'DD-MM-YYYY','D-M-YYYY','DD-MM-YY','D-M-YY',
  'DD.MM.YYYY','D.M.YYYY','DD.MM.YY','D.M.YY',
  'YYYY-MM-DD','YYYY/MM/DD',
  'DD MMM YYYY','D MMM YYYY','DD MMM YY','D MMM YY',
  'DD MMMM YYYY','D MMMM YYYY','DD MMMM YY','D MMMM YY'
];

// Utiliti storan - reset harian & auto-recover JSON
function loadJsonDaily(path) {
  const today = moment().format('YYYY-MM-DD');
  if (!fs.existsSync(path)) fs.writeFileSync(path, JSON.stringify({ date: today, items: [] }, null, 2));
  let data;
  try { data = JSON.parse(fs.readFileSync(path, 'utf8').trim() || '{}'); } catch { data = {}; }
  if (data.date !== today || !Array.isArray(data.items)) data = { date: today, items: [] };
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
  return data.items;
}
function saveJsonDaily(path, item) {
  const today = moment().format('YYYY-MM-DD');
  let data;
  try { data = JSON.parse(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '{}'); } catch { data = {}; }
  if (data.date !== today || !Array.isArray(data.items)) data = { date: today, items: [] };
  data.items.push(item);
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}
const loadUsedSlips      = () => loadJsonDaily(SLIPS_FILE);
const saveUsedSlip       = h  => saveJsonDaily(SLIPS_FILE, h);
const loadUsedReferences = () => loadJsonDaily(REFS_FILE);
const saveUsedReference  = r  => saveJsonDaily(REFS_FILE, r);

// Hash & OCR helpers
const getReceiptHash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const getCompositeHash = (p, extra = '') => crypto.createHash('sha256').update(getReceiptHash(p) + extra).digest('hex');

// Vision API OCR
const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || process.env.GEMINI_API_KEY;
async function runVisionOcr(imagePath) {
  if (!VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY tidak ditetapkan');
  console.log(`[OCR] Hantar ke Google Vision: ${imagePath}`);
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const body = {
    requests: [{
      image: { content: b64 },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
    }]
  };
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vision API gagal: ${res.status} ${errText}`);
  }
  const json = await res.json();
  const text = json?.responses?.[0]?.fullTextAnnotation?.text || '';
  console.log(`[OCR] Vision balas panjang teks: ${text.length}`);
  return text;
}

// Levenshtein & fuzzy
function levenshtein(a, b) {
  const m = [];
  for (let i = 0; i <= a.length; i++) {
    m[i] = [i];
    for (let j = 1; j <= b.length; j++) m[i][j] = i === 0 ? j : 0;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = a[i - 1] === b[j - 1]
        ? m[i - 1][j - 1]
        : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    }
  }
  return m[a.length][b.length];
}
const isSimilar = (x, y, t = 0.76) => 1 - levenshtein(x, y) / Math.max(x.length, y.length) >= t;

const normalizeRefToken = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function isExcludedRefToken(token) {
  const t = normalizeRefToken(token);
  if (!t) return true;
  if (EXCLUDED_NUMBERS.has(t)) return true;
  return EXCLUDED_REF_PATTERNS.some((re) => re.test(t));
}

function extractLabeledToken(text, labelRegex) {
  const m = text.match(new RegExp(`${labelRegex.source}\\s*[:#-]?\\s*([a-z0-9._\\-/]{4,80})`, 'i'));
  if (!m || !m[1]) return null;
  const token = m[1].toUpperCase().replace(/[^A-Z0-9]/g, '');
  return token || null;
}

function extractShopeeMeta(text) {
  const merchantQrAccount = (text.match(/\bMBBQR[0-9]{4,}\b/i) || [null])[0];
  const transactionSn =
    extractLabeledToken(text, /transaction\s*(?:sn|id|no|number)?/) ||
    extractLabeledToken(text, /trx\s*(?:sn|id|no|number)?/);
  const orderSn =
    extractLabeledToken(text, /order\s*(?:sn|id|no|number)?/) ||
    extractLabeledToken(text, /order\s*#/);

  const isShopeeLike = Boolean(merchantQrAccount) && (Boolean(transactionSn) || Boolean(orderSn));
  const receiptMarker = isShopeeLike
    ? `SHP${transactionSn || 'NA'}${orderSn || 'NA'}`
    : null;

  return {
    isShopeeLike,
    merchantQrAccount: merchantQrAccount ? merchantQrAccount.toUpperCase() : null,
    transactionSn: transactionSn || null,
    orderSn: orderSn || null,
    receiptMarker: receiptMarker || null
  };
}
function isDuplicateReference(existingRef, incomingRef) {
  const a = normalizeRefToken(existingRef);
  const b = normalizeRefToken(incomingRef);
  if (!a || !b) return false;
  if (a === b) return true;

  // Ref pendek (contoh 6-10 digit/aksara) terlalu berisiko untuk fuzzy duplicate.
  if (a.length < 12 || b.length < 12) return false;
  if (Math.abs(a.length - b.length) > 2) return false;

  // Minta anchor supaya tak mudah bertembung untuk transaksi berbeza.
  const prefixAnchor = a.slice(0, 4) === b.slice(0, 4);
  const suffixAnchor = a.slice(-4) === b.slice(-4);
  if (!prefixAnchor && !suffixAnchor) return false;

  return isSimilar(a, b, 0.92);
}

// Rujukan (mesra DuitNow, terima alfanumerik dan fallback gabungan digit)
function extractReferenceNumber(text) {
  // Keutamaan penting:
  // 1) DuitNow/QR reference (biasanya dipakai untuk padanan notifikasi QR)
  // 2) Label reference umum
  // 3) Octo/internal reference (fallback terakhir)
  const patterns = [
    'external merchant id',
    'external merchantid',
    'external information',
    'external info',
    'merchant id',
    'duitnow reference',
    'duitnow ref',
    'recipient reference',
    'reference id',
    'reference no',
    'reference number',
    'reference #',
    'ref no',
    'ref\\. no',
    'ref number',
    'ref id',
    'no reference',
    'no\\. reference',
    'no ref',
    'transaction ref',
    'transaction reference',
    'trx ref',
    'trx reference',
    'payment ref',
    'payment reference',
    'seq no',
    'sequence no',
    'reference',
    'octo reference',
    'octo ref'
  ];

  const getRefTokens = (src) => {
    const tokens = src.toUpperCase().match(/\b[A-Z0-9]{6,40}\b/g) || [];
    return tokens.filter(token => /\d/.test(token) && !isExcludedRefToken(token));
  };

  // 1) Cuba cari token alfanumerik 6-40 aksara selepas label
  for (const p of patterns) {
    const m = text.match(new RegExp(p + '\\s*[:#-]?\\s*([a-z0-9._\\-\\/]{6,64})', 'i'));
    if (m && m[1]) {
      const ref = m[1].toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (/\d/.test(ref) && !isExcludedRefToken(ref)) return ref;
    }
  }

  // 1b) Fallback generik: mana-mana frasa yang ada "ref"/"reference" diikuti token 6-40 aksara
  const genericRefPatterns = [
    /\b(?:reference|ref)\b[^\r\n]{0,60}?([a-z0-9._\-\/]{6,64})\b/i,
    /\b(?:duitnow|octo|transaction|trx|external)\s+(?:reference|ref|information|info|merchant(?:\s+id)?)\b[^\r\n]{0,60}?([a-z0-9._\-\/]{6,64})\b/i
  ];
  for (const re of genericRefPatterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const ref = m[1].toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (/\d/.test(ref) && !isExcludedRefToken(ref)) return ref;
    }
  }

  // 2) Jika tiada label, utamakan token 10 aksara (sering QR), kemudian panjang lain 6-40
  const refs = getRefTokens(text);
  return refs.find(r => r.length === 10) || refs[0] || null;
}

function extractRefCandidates(text) {
  const candidates = new Set();
  const upper = text.toUpperCase();

  // Keutamaan ShopeePay/QRPay: ambil nilai selepas label external info/merchant id.
  const labeled = [
    /\bEXTERNAL\s+MERCHANT\s*ID\b[^\r\n]{0,80}?([A-Z0-9._\-\/]{6,64})/gi,
    /\bEXTERNAL\s+INFORMATION\b[^\r\n]{0,80}?([A-Z0-9._\-\/]{6,64})/gi,
    /\bEXTERNAL\s+INFO\b[^\r\n]{0,80}?([A-Z0-9._\-\/]{6,64})/gi
  ];
  for (const re of labeled) {
    let m;
    while ((m = re.exec(upper)) !== null) {
      const token = (m[1] || '').replace(/[^A-Z0-9]/g, '');
      if (token.length >= 6 && /\d/.test(token) && !isExcludedRefToken(token)) {
        candidates.add(token);
      }
    }
  }

  // Ambil semua token alfanumerik 6-40 aksara yang bersempadan.
  const alphaNum = upper.match(/\b[A-Z0-9]{6,40}\b/g) || [];
  for (const token of alphaNum) {
    if (/\d/.test(token) && !isExcludedRefToken(token)) candidates.add(token);
  }

  // Jika OCR lekatkan aksara terlalu panjang, pecahkan ikut window 10 aksara.
  const longSeqs = upper.match(/[A-Z0-9]{11,}/g) || [];
  for (const seq of longSeqs) {
    for (let i = 0; i + 10 <= seq.length; i++) {
      const token = seq.slice(i, i + 10);
      if (!isExcludedRefToken(token)) candidates.add(token);
    }
  }

  return Array.from(candidates);
}

const extractTime = (txt) => {
  const m = txt.match(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(AM|PM)?\b/i);
  return m ? m[0].trim() : '';
};

function alignTwoDigitYear(momentObj, today) {
  if (momentObj.year() < 100) {
    const century = Math.floor(today.year() / 100) * 100;
    let candidate = century + momentObj.year();
    if (candidate - today.year() > 50) candidate -= 100;
    if (today.year() - candidate > 50) candidate += 100;
    momentObj.year(candidate);
  }
  return momentObj;
}

function collectDateCandidates(text) {
  const matches = new Set();
  for (const pattern of DATE_PATTERNS) {
    const found = text.match(pattern);
    if (found) found.forEach(item => matches.add(item.trim()));
  }
  return Array.from(matches);
}

function validateSlipDate(text, today) {
  const candidates = collectDateCandidates(text);
  if (!candidates.length) {
    return { ok: false, reason: 'Tarikh slip tidak ditemui' };
  }
  let firstParsed = null;
  for (const raw of candidates) {
    for (const format of DATE_FORMATS) {
      let parsed = moment(raw, format, true);
      if (!parsed.isValid()) continue;
      if (format.includes('YY') && !format.includes('YYYY')) {
        parsed = alignTwoDigitYear(parsed, today);
      }
      parsed = parsed.utcOffset(today.utcOffset(), true).startOf('day');
      if (!firstParsed) firstParsed = parsed.clone();
      if (parsed.isSame(today, 'day')) {
        return { ok: true };
      }
    }
  }
  const readable = firstParsed ? firstParsed.format('DD/MM/YYYY') : candidates[0];
  return { ok: false, reason: `Tarikh slip (${readable}) bukan pada hari ini.` };
}

// Main function
export default async function validateSlipOCR(imagePath, expectedAmount) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return { success: false, reason: 'Fail slip tidak ditemui atau gagal disimpan' };
  }
  if (!VISION_API_KEY) {
    return { success: false, reason: 'GOOGLE_VISION_API_KEY tidak ditetapkan' };
  }
  console.log('OCR bermula untuk fail:', imagePath);
  const today = moment().utcOffset(MALAYSIA_UTC_OFFSET_MINUTES).startOf('day');
  const OCR_TIMEOUT_MS = 15000;

  // Helper untuk pastikan OCR tidak menggantung terlalu lama
  const ocrWithTimeout = async (procPath) => {
    let timer;
    try {
      const res = await Promise.race([
        runVisionOcr(procPath),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('OCR timeout')), OCR_TIMEOUT_MS);
        })
      ]);
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  let text = '';
  try {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      try {
        text = await ocrWithTimeout(imagePath);
        console.log(`[OCR] Vision selesai (cubaan ${attempt}), panjang teks: ${text.length}, masa ${(Date.now()-t0)/1000}s`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[OCR] Cubaan ${attempt} gagal: ${err.message}`);
        const timeoutOnly = /timeout/i.test(String(err.message || ''));
        if (!timeoutOnly || attempt === 2) throw err;
        await new Promise(r => setTimeout(r, 1200));
      }
    }
  } catch (err) {
    console.warn(`OCR gagal: ${err.message}`);
    return { success: false, reason: 'OCR timeout/gagal' };
  }

  text = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (text.length < 20) {
    return { success: false, reason: 'Teks terlalu pendek' };
  }

  // Cari amaun: pilih angka paling hampir dengan expectedAmount, utamakan yang bertanda "rm"/"amount"/"payment"
  const extractAmount = (rawText, expected) => {
    const candidates = [];
    const pushVal = v => {
      const val = parseFloat(v.replace(/,/g, '.'));
      if (!isNaN(val) && val > 0 && val < expected * 50 + 1000) candidates.push(val);
    };
    const regexes = [
      /(?:amount|total amount|payment|bayaran|jumlah)\s*[:\-]?\s*(?:rm\s*)?(\d+(?:[\.,]\d+)?)/gi,
      /\brm\s*(\d+(?:[\.,]\d+)?)/gi,
      /\b(\d+(?:[\.,]\d+)?)/g
    ];
    for (const re of regexes) {
      let m;
      while ((m = re.exec(rawText)) !== null) pushVal(m[1]);
    }
    if (!candidates.length) return null;
    let best = candidates[0];
    let bestDiff = Math.abs(best - expected);
    for (const c of candidates) {
      const diff = Math.abs(c - expected);
      if (diff < bestDiff) {
        best = c;
        bestDiff = diff;
      }
    }
    return { value: best, diff: bestDiff };
  };

  const amtRes = extractAmount(text, expectedAmount);
  if (!amtRes || amtRes.diff > 1) {
    return { success: false, reason: 'Jumlah tidak sepadan' };
  }
  const amt = amtRes.value;

  const dateCheck = validateSlipDate(text, today);
  if (!dateCheck.ok) return { success: false, reason: dateCheck.reason };
  const ocrTxt = text;

  const timeText = extractTime(ocrTxt);
  if (!timeText) {
    return { success: false, reason: 'Masa transaksi tidak ditemui' };
  }

  const refCandidates = extractRefCandidates(ocrTxt);
  const shopeeMeta = extractShopeeMeta(ocrTxt);
  const orderedRefCandidates = Array.from(
    new Set(
      [extractReferenceNumber(ocrTxt), ...refCandidates, shopeeMeta.receiptMarker]
        .filter(Boolean)
        .map(r => String(r).toUpperCase())
    )
  );
  let ref = orderedRefCandidates[0] || null;
  if (!ref) return { success: false, reason: 'Nombor rujukan tidak ditemui' };
  const compHash = getCompositeHash(imagePath, timeText + ref);
  if (loadUsedSlips().includes(compHash)) return { success: false, reason: 'Resit telah digunakan' };
  const usedRefs = loadUsedReferences();
  const nonDuplicateCandidate = orderedRefCandidates.find(candidate => !usedRefs.some(r => isDuplicateReference(r, candidate)));
  if (nonDuplicateCandidate) {
    ref = nonDuplicateCandidate;
  } else if (usedRefs.some(r => isDuplicateReference(r, ref))) {
    return { success: false, reason: 'Nombor rujukan duplikat' };
  }
  // Jangan simpan di sini; biar pemanggil simpan selepas transaksi berjaya
  return {
    success: true,
    reference: ref,
    refCandidates: orderedRefCandidates,
    timeText,
    compHash,
    shopeeMeta
  };
}

export { getReceiptHash, saveUsedSlip, saveUsedReference };
