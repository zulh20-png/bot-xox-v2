import fs from 'fs';
import path from 'path';

const root = process.cwd();
const filePath = path.join(root, 'used_references.json');

function normalizeRef(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isLikelyRef(v) {
  const n = normalizeRef(v);
  if (!n) return false;
  if (!/\d/.test(n)) return false;
  if (n.length < 6) return false;
  if (n.length > 64) return false;
  return true;
}

function loadJsonSafe(p) {
  if (!fs.existsSync(p)) throw new Error(`Fail tidak wujud: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function summarizeChanges(originalItems, cleanedItems, removed) {
  return {
    original_count: originalItems.length,
    cleaned_count: cleanedItems.length,
    removed_count: removed.length,
    removed_examples: removed.slice(0, 20)
  };
}

function main() {
  const apply = process.argv.includes('--apply');
  const data = loadJsonSafe(filePath);
  const items = Array.isArray(data?.items) ? data.items : [];

  const cleaned = [];
  const seen = new Set();
  const removed = [];

  for (const raw of items) {
    const normalized = normalizeRef(raw);
    if (!isLikelyRef(normalized)) {
      removed.push({ value: raw, reason: 'not_ref_like' });
      continue;
    }
    if (seen.has(normalized)) {
      removed.push({ value: raw, reason: 'duplicate_after_normalize' });
      continue;
    }
    seen.add(normalized);
    cleaned.push(normalized);
  }

  const summary = summarizeChanges(items, cleaned, removed);
  console.log('Audit used_references.json');
  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    console.log('\nDry-run sahaja. Untuk apply + backup: node scripts/cleanup-used-references.js --apply');
    return;
  }

  const backupPath = path.join(root, `used_references.backup.${Date.now()}.json`);
  fs.copyFileSync(filePath, backupPath);
  const out = {
    date: typeof data?.date === 'string' ? data.date : null,
    items: cleaned
  };
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2));
  console.log(`\nBackup disimpan: ${backupPath}`);
  console.log(`Fail dikemas kini: ${filePath}`);
}

main();

