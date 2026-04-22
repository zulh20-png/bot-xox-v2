import { Client } from 'ssh2';
import SFTPClient from 'ssh2-sftp-client';
import fs from 'fs';
import path from 'path';

const sshConfig = {
  host: '72.60.198.106',
  port: 22,
  username: 'root',
  password: "Kx'1vTg@zNuOZRm@R?zR",
  readyTimeout: 20000,
};

async function main() {
  const sftp = new SFTPClient();
  await sftp.connect(sshConfig);
  const files = [
    '/opt/bot-onexox/after_submit.png',
    '/opt/bot-onexox/after_submit_full.png',
    '/opt/bot-onexox/after_submit.html',
  ];
  for (const file of files) {
    try {
      const stat = await sftp.stat(file);
      console.log(`${file} size=${stat.size}`);
      if (file.endsWith('.html')) {
        const buf = await sftp.get(file);
        const content = buf.toString('utf8');
        console.log('---- after_submit.html (first 400 chars) ----');
        console.log(content.slice(0, 400));
        const lower = content.toLowerCase();
        const keywords = ['success', 'submitted', 'transfer', 'request'];
        for (const kw of keywords) {
          const idx = lower.indexOf(kw);
          if (idx !== -1) {
            const start = Math.max(0, idx - 200);
            const end = Math.min(content.length, idx + 400);
            console.log(`---- snippet around "${kw}" ----`);
            console.log(content.slice(start, end));
          } else {
            console.log(`No "${kw}" word found in html.`);
          }
        }
        fs.writeFileSync('./after_submit.html', content, 'utf8');
        console.log('Saved after_submit.html locally.');
      } else if (file.endsWith('.png')) {
        const buf = await sftp.get(file);
        const localName = path.basename(file);
        fs.writeFileSync(localName, buf);
        console.log(`Saved ${localName} locally.`);
      }
    } catch (err) {
      console.log(`${file} missing: ${err.message}`);
    }
  }
  await sftp.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
