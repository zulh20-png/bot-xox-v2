import fs from 'fs';
import path from 'path';

const root = process.cwd();
const filePath = path.join(root, 'pending_review_qrpay.json');

function main() {
  if (!fs.existsSync(filePath)) {
    console.log('Tiada fail pending review:', filePath);
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error('Gagal parse JSON:', err.message);
    process.exit(1);
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  console.log(`Fail: ${filePath}`);
  console.log(`Tarikh: ${data?.date || '-'}`);
  console.log(`Jumlah pending: ${items.length}`);

  const byReason = new Map();
  for (const item of items) {
    const k = item?.reason_code || 'UNKNOWN';
    byReason.set(k, (byReason.get(k) || 0) + 1);
  }
  if (byReason.size) {
    console.log('\nRingkasan reason_code:');
    for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`- ${k}: ${v}`);
    }
  }

  const recent = items.slice(-10).reverse();
  if (recent.length) {
    console.log('\n10 rekod terbaru:');
    for (const item of recent) {
      console.log(`- ${item.created_at || '-'} | ${item.reason_code || '-'} | from=${item.from || '-'} | amount=${item.amount ?? '-'} | ref=${item.ocr_reference || '-'}`);
    }
  }
}

main();

