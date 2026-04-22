import puppeteer from 'puppeteer';

const loginURL =
  'https://idp.onexox.my/auth/realms/onesys/protocol/openid-connect/auth' +
  '?client_id=webapp&redirect_uri=https%3A%2F%2Fonesys.onexox.my%2F&response_mode=fragment' +
  '&response_type=code&scope=openid&nonce=abc123';

const PUPPETEER_OPTS = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox']
};

function parseRmAmount(text) {
  if (!text) return null;
  const m = String(text).match(/RM\s*([0-9,]+(?:\.[0-9]{2})?)/i);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ''));
}

function formatRm(amount) {
  if (!Number.isFinite(amount)) return 'N/A';
  return `RM ${amount.toFixed(2)}`;
}

async function closePopupIfAny(page) {
  try {
    await page.waitForSelector('.v-btn__content', { timeout: 6000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.v-btn__content')]
        .find((b) => (b.textContent || '').trim().toLowerCase() === 'close');
      if (btn) btn.click();
    });
  } catch {}
}

async function collectHtml(page) {
  let html = '';
  try {
    html += await page.content();
  } catch {}
  for (const frame of page.frames()) {
    try {
      html += '\n' + (await frame.content());
    } catch {}
  }
  return html;
}

function extractHighestRmAmount(html) {
  const allValues = (html.match(/RM\s*[0-9,]+(?:\.[0-9]{2})?/gi) || [])
    .map((v) => parseRmAmount(v))
    .filter((v) => Number.isFinite(v));
  if (!allValues.length) return null;
  return Math.max(...allValues);
}

async function main() {
  let browser;
  try {
    browser = await puppeteer.launch(PUPPETEER_OPTS);
    const page = await browser.newPage();
    await page.goto(loginURL, { waitUntil: 'networkidle2' });
    await page.waitForSelector('input#username', { timeout: 15000 });
    await page.type('input#username', 'dysd410');
    await page.type('input#password', 'makL978');
    await page.click('input[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    await closePopupIfAny(page);

    await page.goto('https://onesys.onexox.my/ecash_transfer', { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 2000));
    const prepaidHtml = await collectHtml(page);
    const prepaid = extractHighestRmAmount(prepaidHtml);

    await page.goto('https://onesys.onexox.my/ecash_transfer_postpay', { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 2000));
    const postpayHtml = await collectHtml(page);
    const postpay = extractHighestRmAmount(postpayHtml);

    console.log('BALANCE_CHECK_SUCCESS=1');
    console.log(`BALANCE_PREPAID=${formatRm(prepaid)}`);
    console.log(`BALANCE_POSTPAY=${formatRm(postpay)}`);
    console.log(`BALANCE_PREPAID_NUM=${Number.isFinite(prepaid) ? prepaid.toFixed(2) : ''}`);
    console.log(`BALANCE_POSTPAY_NUM=${Number.isFinite(postpay) ? postpay.toFixed(2) : ''}`);
  } catch (err) {
    console.log(`BALANCE_CHECK_FAILED=${err.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

main();
