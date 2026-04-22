import { spawn } from 'child_process';

function runBalanceCheck() {
  return new Promise((resolve) => {
    const child = spawn('node', ['./onesys-check-balance.js'], { shell: true });
    let output = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, reason: `exit_${code}` });
      const line = (key) => {
        const m = output.match(new RegExp(`^${key}=(.+)$`, 'mi'));
        return m ? m[1].trim() : null;
      };

      const prepaidRaw = line('BALANCE_PREPAID');
      const postpayRaw = line('BALANCE_POSTPAY');
      const prepaid = Number(line('BALANCE_PREPAID_NUM'));
      const postpay = Number(line('BALANCE_POSTPAY_NUM'));

      if (!Number.isFinite(prepaid) && !Number.isFinite(postpay)) {
        return resolve({ ok: false, reason: 'parse_failed', raw: output });
      }

      return resolve({
        ok: true,
        prepaid: Number.isFinite(prepaid) ? prepaid : null,
        postpay: Number.isFinite(postpay) ? postpay : null,
        prepaidRaw: prepaidRaw || null,
        postpayRaw: postpayRaw || null
      });
    });
  });
}

function runAutoProcess(mode) {
  return new Promise((resolve) => {
    let scriptName;
    if (mode === 'topup') {
      scriptName = 'onesys-autotopup.js';
    } else if (mode === 'erecharge_prepaid') {
      scriptName = 'onesys-autorecharge.js';
    } else if (mode === 'erecharge_postpay') {
      scriptName = 'onesys-autorecharge-postpay.js';
    } else {
      return resolve({ success: false, message: 'Mod tidak sah' });
    }

    console.log(`dYs? Menjalankan ${scriptName} dalam mod: ${mode}`);

    const child = spawn('node', [`./${scriptName}`], { shell: true });
    let output = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      const lowerOutput = output.toLowerCase();

      if (code !== 0) {
        console.error(`Т'?O Ralat semasa proses: exit code ${code}`);
        return resolve({ success: false, message: `Exit code ${code}` });
      }

      // Jika "no such dealer" muncul, anggap gagal walaupun ada success flag
      if (lowerOutput.includes('no such dealer')) {
        console.warn('Output mengandungi indikator kegagalan:', lowerOutput);
        return resolve({ success: false, message: 'No such dealer' });
      }

      // Utamakan indikator kejayaan
      const hasSuccess =
        lowerOutput.includes('auto_recharge_success') ||
        lowerOutput.includes('auto_recharge_postpay_success') ||
        lowerOutput.includes('auto_topup_success') ||
        lowerOutput.includes('successfully submitted') ||
        lowerOutput.includes('success message detected') ||
        lowerOutput.includes('submit step marked complete') ||
        lowerOutput.includes('button_submit_clicked') ||
        lowerOutput.includes('berjaya');

      if (hasSuccess) {
        console.log('Proses automasi selesai dengan jayanya.');
        return runBalanceCheck().then((balanceResult) => {
          if (!balanceResult.ok) {
            return resolve({ success: true, balanceCheck: { ok: false, reason: balanceResult.reason || 'unknown' } });
          }
          return resolve({
            success: true,
            balanceCheck: {
              ok: true,
              prepaid: balanceResult.prepaid,
              postpay: balanceResult.postpay,
              prepaidRaw: balanceResult.prepaidRaw,
              postpayRaw: balanceResult.postpayRaw
            }
          });
        });
      }

      // Semak indikator kegagalan yang jelas
      if (
        lowerOutput.includes('validation_error') ||
        lowerOutput.includes('auto_recharge_failed') ||
        lowerOutput.includes('auto_recharge_postpay_failed') ||
        lowerOutput.includes('auto_topup_failed') ||
        lowerOutput.includes('submit_failed') ||
        lowerOutput.includes('login_failed') ||
        lowerOutput.includes('no such dealer') ||
        lowerOutput.includes('field errors:')
      ) {
        console.warn('Output mengandungi indikator kegagalan:', lowerOutput);
        return resolve({ success: false, message: 'Proses automasi gagal berdasarkan output.' });
      }

      console.warn('Tiada mesej kejayaan dijumpai dalam output.');
      return resolve({ success: false, message: 'Tiada mesej kejayaan dalam output.' });
    });
  });
}

export default runAutoProcess;
