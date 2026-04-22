import fs from 'fs';
import path from 'path';

const root = process.cwd();
const notifPath = path.join(root, 'tasker-bridge', 'data', 'qrpaybiz_notifications.json');
const usedRefsPath = path.join(root, 'used_references.json');
const pendingPath = path.join(root, 'pending_review_qrpay.json');

function normalize(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function aliases(v) {
  const n = normalize(v);
  const s = new Set();
  if (!n) return s;
  s.add(n);
  if (n.startsWith('QR') && n.length > 2) s.add(n.slice(2));
  if (/^[A-Z0-9]{6,40}$/.test(n) && !n.startsWith('QR')) s.add(`QR${n}`);
  return s;
}

function loadJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function refMatches(candidate, query) {
  const qAliases = aliases(query);
  const cAliases = aliases(candidate);
  for (const a of qAliases) {
    for (const b of cAliases) {
      if (a === b) return true;
      if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return true;
    }
  }
  return false;
}

function main() {
  const rawQuery = process.argv[2];
  if (!rawQuery) {
    console.log('Guna: node scripts/find-ref.js <REF>');
    process.exit(1);
  }
  const query = normalize(rawQuery);
  console.log(`Cari ref: ${query}`);

  const notif = loadJsonSafe(notifPath);
  const usedRefs = loadJsonSafe(usedRefsPath);
  const pending = loadJsonSafe(pendingPath);

  console.log('\n[1] Notifikasi QRPay');
  const notifItems = Array.isArray(notif?.items) ? notif.items : [];
  const notifHits = [];
  for (const item of notifItems) {
    const candidates = new Set([
      ...(Array.isArray(item?.refs) ? item.refs : []),
      item?.best_row?.ref,
      item?.best_row?.ref_qrpay
    ].filter(Boolean));
    if ([...candidates].some(c => refMatches(c, query))) {
      notifHits.push(item);
    }
  }
  if (!notifHits.length) {
    console.log('- Tiada padanan');
  } else {
    for (const item of notifHits.slice().reverse()) {
      const refShow = item?.best_row?.ref_qrpay || item?.best_row?.ref || item?.refs?.[0] || '-';
      console.log(`- ${item.id} | ref=${refShow} | amount=${item?.best_row?.amount ?? '-'} | used=${item.used ? 'true' : 'false'} | used_by=${item.used_by_job_id || '-'} | at=${item.received_at}`);
    }
  }

  console.log('\n[2] Used References');
  const usedItems = Array.isArray(usedRefs?.items) ? usedRefs.items : [];
  const usedHits = usedItems.filter(r => refMatches(r, query));
  if (!usedHits.length) {
    console.log('- Tiada padanan');
  } else {
    for (const r of usedHits) console.log(`- ${r}`);
  }

  console.log('\n[3] Pending Review QRPay');
  const pendingItems = Array.isArray(pending?.items) ? pending.items : [];
  const pendingHits = pendingItems.filter(item =>
    refMatches(item?.ocr_reference, query) ||
    (Array.isArray(item?.ocr_ref_candidates) && item.ocr_ref_candidates.some(c => refMatches(c, query)))
  );
  if (!pendingHits.length) {
    console.log('- Tiada padanan');
  } else {
    for (const item of pendingHits.slice().reverse()) {
      console.log(`- ${item.created_at || '-'} | reason=${item.reason_code || '-'} | ref=${item.ocr_reference || '-'} | from=${item.from || '-'} | amount=${item.amount ?? '-'}`);
    }
  }
}

main();

