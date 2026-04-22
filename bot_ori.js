import fs from 'fs';
import path from 'path';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { addAttempt, isExceeded, resetAttempt } from './attempt-handler.js';
import writeAutoData from './autodata-writer.js';
import runAutoProcess from './runAutoProcess.js';
import validateSlipOCR, { getReceiptHash, saveUsedSlip } from './validateSlipOCR.js';
import convertPdfToImage from './pdfToImage.js';

const userSessions = {};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: true });

  sock.ev.on('creds.update', saveCreds);

  async function sendMsg(to, text) {
    await sock.sendMessage(to, { text });
  }

  function resetSession(from) {
    userSessions[from] = { flow: '', step: 0, dealerId: '', phone: '', amount: 0 };
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
      resetSession(from);
      return sendMsg(
        from,
        `✅ **Pembetulan diterima. Sila pilih semula:**
1️⃣ **eRecharge (Dealer ➝ Dealer)**
2️⃣ **Topup (Pelanggan)**
3️⃣ **Customer Service (Percubaan)**`
      );
    }
    return false;
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const textUser = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

    // Jika pelanggan menghantar "terima kasih menggunakan khidmat kami"
    if (textUser.toLowerCase() === 'terima kasih menggunakan khidmat kami') {
      return sendMsg(from, 'Terima kasih kerana menggunakan khidmat kami.');
    }

    if (!userSessions[from]) resetSession(from);
    const session = userSessions[from];

    // --------------------- ALIRAN UTAMA (Pilihan Menu) ---------------------
    if (session.step === 0) {
      if (textUser === '1') {
        session.flow = 'erecharge';
        session.step = 1;
        return sendMsg(
          from,
          `**Langkah 1/3:**
Sila masukkan **ID Dealer** sahaja (contoh: dysd123).
Tekan 0 jika mahu buat pembetulan.`
        );
      }
            if (textUser === '2') {
        session.flow = 'topup';
        session.step = 'manual';
        return sendMsg(
          from,
          `🧾 **Anda memilih Topup.**
**Transaksi akan dijalankan secara manual oleh staf, mohon maaf atas kesulitan.**
Jika anda setuju, balas **ya**.
Tekan 0 jika mahu buat pembetulan.`
        );
      }
      if (textUser === '3') {
        session.flow = 'cs';
        session.step = 'cs';
        return sendMsg(
          from,
          `✅ **Customer Service dipilih.**
Sila tunggu sebentar, staf kami akan membantu anda secepat mungkin.`
        );
      }
      // Mesej permulaan dikemaskini
      return sendMsg(
        from,
        `🤖 Bot Almarbawi OneXOX: 📲 Assalamualaikum! Saya akan bantu anda untuk menjalankan transaksi erecharge dan topup secara automatik.

❗ Peringatan:
• Pastikan maklumat yang diberikan betul. Jika berlaku kesilapan, tiada refund. 

📌 Pastikan pembayaran dibuat ke akaun:
ALMARBAWI PLT
8605524398 (CIMB ISLAMIC BANK)

1️⃣ eRecharge (Dealer ➝ Dealer)
2️⃣ Topup (Pelanggan)
3️⃣ Customer Service (Percubaan)

Sila taip nombor pilihan anda.`
      );
    }

    // Periksa jika pengguna nak buat pembetulan
    if (await checkCorrection(from, textUser)) return;

    // --------------------- ERECHARGE FLOW ---------------------
    if (session.flow === 'erecharge') {
      // Tahap pengesahan maklumat sebelum bukti pembayaran
      if (session.step === 'confirm') {
        if (textUser.toLowerCase() === 'ya') {
          session.step = 3;
          return sendMsg(
            from,
            `**Langkah 3/3:**
Sila hantarkan **bukti pembayaran** (.jpg/.png/pdf/screenshot).
Bukti hendaklah mempunyai butiran:
- Akaun penerima
- Tarikh
- Jumlah

📌 Pastikan pembayaran dibuat ke:
ALMARBAWI PLT
8605524398 (CIMB ISLAMIC BANK)
Tekan 0 jika mahu buat pembetulan.`
          );
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
            `❌ **Format ID Dealer salah.**
Sila pastikan ID Dealer hanya mengandungi teks tanpa ruang (contoh: dysd123).
Tekan 0 jika mahu buat pembetulan dan cuba masukkan semula.`
          );
        }
        session.dealerId = textUser;
        session.step = 2;
        return sendMsg(
          from,
          `✅ **ID Dealer diterima:** ${textUser}.
**Langkah 2/3:**
Sila masukkan **jumlah eRecharge** (contoh: 50).
Tekan 0 jika mahu buat pembetulan.`
        );
      }
      if (session.step === 2) {
        const amt = parseFloat(textUser);
        if (isNaN(amt) || amt <= 0) {
          return sendMsg(
            from,
            `❌ **Jumlah tidak sah.** Sila taip semula.
Tekan 0 jika mahu buat pembetulan.`
          );
        }
        session.amount = amt;

        // Kira bonus
        let bonus = 0;
        if (amt >= 1000) bonus = 5.5;
        else if (amt >= 400) bonus = 5;
        else if (amt >= 200) bonus = 4;
        else if (amt >= 1) bonus = 2;
        const totalWithBonus = amt + (amt * bonus) / 100;

        session.step = 'confirm';
        return sendMsg(
          from,
          `✅ **Jumlah eRecharge diterima:** RM${amt.toFixed(2)}.
Ini adalah maklumat yang anda beri:
• **ID Dealer:** ${session.dealerId}
• **Jumlah:** RM${amt.toFixed(2)} (Dealer akan terima: RM${totalWithBonus.toFixed(2)} dengan bonus ${bonus}%)

Jika maklumat adalah betul, balas 'ya'. Tekan 0 untuk pembetulan.`
        );
      }
      if (session.step === 3) {
        try {
          // Selepas slip diterima, terus bagi mesej "Harap bersabar, sedang disemak"
          // sebelum kita jalankan OCR.
          await sendMsg(from, `✅ **Slip diterima.** Harap bersabar, pembayaran anda sedang disemak...`);

          const slip = await processSlip(msg, session, from);
          const result = await validateSlipOCR(slip, session.amount);
          if (!result.success) {
            addAttempt(from);
            if (isExceeded(from)) {
              resetSession(from);
              return sendMsg(
                from,
                `❌ **Gagal sahkan slip selepas 3 kali cubaan.** Akan disemak staf.`
              );
            }
            return sendMsg(
              from,
              `⚠️ **Slip tidak sah:** ${result.reason}. Sila cuba semula. Jika anda hantar PDF, cuba hantar gambar atau jika anda hantar gambar, cuba hantar PDF.`
            );
          }

          // Slip disahkan, tulis data & runAutoProcess
          writeAutoData({ mode: 'erecharge', dealerId: session.dealerId, amount: session.amount });
          const onesysResult = await runAutoProcess('erecharge');
          if (onesysResult.success) {
            // Simpan hash resit hanya jika transaksi berjaya
            const slipHash = getReceiptHash(slip);
            saveUsedSlip(slipHash);

            resetSession(from);
            return sendMsg(
              from,
              `✅ **eRecharge berjaya. Terima kasih kerana menggunakan khidmat kami.**`
            );
          } else {
            resetSession(from);
            return sendMsg(
              from,
              `❌ **eRecharge gagal kerana ada ralat pada maklumat.**
Sila cuba semula atau hubungi admin melalui WhatsApp: [Klik sini](https://wa.me/60106000456)`
            );
          }
        } catch (err) {
          console.error(err);
          return sendMsg(from, `❌ **Gagal proses slip.** Sila cuba semula.`);
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
          return sendMsg(
            from,
            `**Langkah 3/3:**
Sila hantarkan **slip bukti pembayaran** (.jpg/.png/pdf/screenshot).
Bukti hendaklah mempunyai butiran:
- Akaun penerima
- Tarikh
- Jumlah

📌 Akaun untuk pembayaran:
ALMARBAWI PLT
8605524398 (CIMB ISLAMIC BANK)
Tekan 0 jika mahu buat pembetulan.`
          );
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
          `✅ **No telefon diterima:** ${textUser}.
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
            `❌ **Jumlah tidak sah.** Sila taip semula.
Tekan 0 jika mahu buat pembetulan.`
          );
        }
        session.amount = amt;

        // Masuk ke tahap pengesahan
        session.step = 'confirm';
        return sendMsg(
          from,
          `✅ **Jumlah Topup diterima:** RM${amt.toFixed(2)}.
Ini adalah maklumat yang anda beri:
• **No Telefon:** ${session.phone}
• **Jumlah Topup:** RM${amt.toFixed(2)}

Jika maklumat adalah betul, balas 'ya'. Tekan 0 untuk pembetulan.`
        );
      }
      if (session.step === 3) {
        try {
          // Selepas slip diterima, beri mesej "Harap bersabar, sedang disemak"
          await sendMsg(from, `✅ **Slip diterima.** Harap bersabar, pembayaran anda sedang disemak...`);

          const slip = await processSlip(msg, session, from);
          const result = await validateSlipOCR(slip, session.amount);
          if (!result.success) {
            addAttempt(from);
            if (isExceeded(from)) {
              resetSession(from);
              return sendMsg(
                from,
                `❌ **Gagal sahkan slip selepas 3 cubaan.** Akan disemak staf.`
              );
            }
            return sendMsg(
              from,
              `⚠️ **Slip tidak sah:** ${result.reason}. Sila cuba lagi. Jika anda hantar PDF, cuba hantar gambar atau jika anda hantar gambar, cuba hantar PDF.`
            );
          }

          // Slip disahkan, tulis data & runAutoProcess
          writeAutoData({ mode: 'topup', phone: session.phone, amount: session.amount });
          const onesysResult = await runAutoProcess('topup');
          if (onesysResult.success) {
            // Simpan hash resit hanya jika transaksi berjaya
            const slipHash = getReceiptHash(slip);
            saveUsedSlip(slipHash);

            resetSession(from);
            return sendMsg(
              from,
              `✅ **Topup berjaya. Terima kasih kerana menggunakan khidmat kami.**`
            );
          } else {
            resetSession(from);
            return sendMsg(
              from,
              `❌ **Topup gagal kerana ada ralat pada maklumat.**
Sila cuba semula atau hubungi admin melalui WhatsApp: [Klik sini](https://wa.me/60106000456)`
            );
          }
        } catch (err) {
          console.error(err);
          return sendMsg(from, `❌ **Gagal proses slip.** Sila cuba semula.`);
        }
      }
    }
  });

  // Auto-reconnect
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`❗ Sambungan terputus. Status kod: ${statusCode}`);
      if (statusCode !== 401 && statusCode !== 410) {
        console.log('🔄 Mencuba reconnect secara automatik...');
        startBot();
      } else {
        console.log('⚠️ Sesi telah tamat atau invalid. Sila padam folder auth untuk mendapatkan QR baru.');
      }
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp telah disambung.');
    }
  });
}

startBot().catch(err => console.error('❗ Gagal mula bot:', err));
