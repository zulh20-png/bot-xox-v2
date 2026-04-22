// onesys-autotopup.js (clean rewrite)
import puppeteer from 'puppeteer';
import fs from 'fs';

// Expected autodata.json: { "phone": "01112345678", "amount": 30 }
const autoData = JSON.parse(fs.readFileSync('autodata.json', 'utf8'));

const loginURL =
  'https://idp.onexox.my/auth/realms/onesys/protocol/openid-connect/auth' +
  '?client_id=webapp&redirect_uri=https%3A%2F%2Fonesys.onexox.my%2F&response_mode=fragment' +
  '&response_type=code&scope=openid&nonce=abc123';

const PUPPETEER_OPTS = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
};

const delay = ms => new Promise(res => setTimeout(res, ms));

async function typeInto(page, selector, value, delayMs = 60) {
  const el = await page.$(selector);
  if (!el) return false;
  await el.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value, { delay: delayMs });
  return true;
}

// 1) LOGIN
async function login() {
  const browser = await puppeteer.launch(PUPPETEER_OPTS);
  const page = await browser.newPage();
  await page.goto(loginURL, { waitUntil: 'networkidle2' });
  try {
    await page.waitForSelector('input#username', { timeout: 10000 });
    await page.type('input#username', 'dysd410');
    await page.type('input#password', 'makL978');
    await page.click('input[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('LOGIN_OK');
    return { browser, page };
  } catch (err) {
    console.log('LOGIN_FAILED', err.message);
    await browser.close();
    return null;
  }
}

async function closePopup(page) {
  try {
    await page.waitForSelector('.v-btn__content', { timeout: 8000, visible: true });
    await page.click('.v-btn__content');
    console.log('POPUP_CLOSED');
  } catch {
    console.log('POPUP_NONE');
  }
}

async function openMenu(page) {
  try {
    await page.waitForSelector('.v-btn .v-btn__content .v-icon', { timeout: 10000 });
    await page.click('.v-btn .v-btn__content .v-icon');
    console.log('MENU_OPENED');
  } catch (err) {
    throw new Error('Menu utama gagal dibuka: ' + err.message);
  }
}

async function clickMenuByText(page, text) {
  await delay(1000);
  const success = await page.evaluate(label => {
    const items = [...document.querySelectorAll('.v-list__tile__title')];
    const el = items.find(e => e.textContent.trim().toLowerCase().includes(label.toLowerCase()));
    if (el) {
      el.scrollIntoView();
      el.click();
      return true;
    }
    return false;
  }, text);
  if (!success) throw new Error(`Menu "${text}" tidak dijumpai`);
  console.log(`MENU_CLICK: ${text}`);
}

async function fillFieldByText(page, fieldIdentifier, textValue) {
  const isMobile = fieldIdentifier.toLowerCase().includes('mobile number');

  // Try placeholder first
  try {
    await page.waitForSelector(`input[placeholder*="${fieldIdentifier}"]`, { timeout: 4000 });
    if (isMobile) {
      const typed = await typeInto(page, `input[placeholder*="${fieldIdentifier}"]`, textValue, 80);
      if (!typed) throw new Error('typeInto failed');
    } else {
      await page.$eval(`input[placeholder*="${fieldIdentifier}"]`, (el, value) => {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, textValue);
    }
    console.log(`FIELD_FILL placeholder "${fieldIdentifier}" with "${textValue}"`);
    return;
  } catch {}

  // Fallback: label text
  const result = await page.evaluate((identifier, value) => {
    const labelNode = document.evaluate(
      "//*[contains(text(),'" + identifier + "')]",
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;
    if (!labelNode) return { error: `Label "${identifier}" tidak dijumpai.` };
    const container = labelNode.closest('.v-input');
    if (!container) return { error: `Tiada .v-input untuk label "${identifier}".` };
    const input = container.querySelector('input, textarea');
    if (!input) return { error: `Tiada input/textarea untuk label "${identifier}".` };
    const rect = input.getBoundingClientRect();
    return { success: true, selector: 'input[data-fill-target]', top: rect.top, left: rect.left };
  }, fieldIdentifier, textValue);

  if (result.error) throw new Error(result.error);
  // Use JS handle for the found input
  const inputHandle = await page.evaluateHandle((identifier) => {
    const labelNode = document.evaluate(
      "//*[contains(text(),'" + identifier + "')]",
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;
    const container = labelNode?.closest('.v-input');
    return container?.querySelector('input, textarea') || null;
  }, fieldIdentifier);
  if (!inputHandle) throw new Error(`Input untuk "${fieldIdentifier}" tidak dijumpai selepas label.`);

  const inputEl = inputHandle.asElement();
  if (!inputEl) throw new Error(`Input element invalid untuk "${fieldIdentifier}"`);
  await inputEl.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(textValue, { delay: isMobile ? 80 : 20 });
  await page.evaluate(el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, inputEl);

  console.log(`FIELD_FILL label "${fieldIdentifier}" with "${textValue}"`);
}

async function clickButtonByExactText(page, exactText) {
  await page.waitForFunction(
    text => [...document.querySelectorAll('.v-btn__content')].some(el => el.innerText.trim() === text),
    { timeout: 7000 },
    exactText
  );
  const allButtons = await page.$$('.v-btn__content');
  const idx = await page.$$eval('.v-btn__content', els => els.map(e => e.innerText.trim())).then(list => list.indexOf(exactText));
  if (idx === -1) return false;
  const button = allButtons[idx];
  if (!button) return false;
  await page.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }), button);
  await delay(400);
  const box = await button.boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  console.log(`BUTTON_CLICK: ${exactText}`);
  return true;
}

async function clickContinueThenSubmit(page) {
  await delay(1000);
  let clickedContinue = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.v-btn')].find(b =>
      b.innerText.trim().toLowerCase().includes('continue')
    );
    if (btn) { btn.scrollIntoView(); btn.click(); return true; }
    return false;
  });
  if (!clickedContinue) {
    console.log('NO_CONTINUE_FOUND, try NEXT');
    clickedContinue = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.v-btn')].find(b =>
        b.innerText.trim().toLowerCase().includes('next')
      );
      if (btn) { btn.scrollIntoView(); btn.click(); return true; }
      return false;
    });
  }
  console.log(clickedContinue ? 'CONTINUE/NEXT_CLICKED' : 'NO_CONTINUE_OR_NEXT');
  await delay(2000);
  await page.screenshot({ path: 'after_continue.png' });

  const submitClicked = await clickButtonByExactText(page, 'SUBMIT');
  if (!submitClicked) {
    console.log('SUBMIT_NOT_FOUND');
    return { success: false, evidence: ['submit_not_found'] };
  }
  await delay(2000);
  await page.screenshot({ path: 'after_submit.png' });

  // Success detection window 10s
  const start = Date.now();
  let foundCriteria = [];
  while (Date.now() - start < 10000) {
    const criteria = await page.evaluate(() => {
      const detected = [];
      const bodyText = document.body.innerText.toLowerCase();
      if (bodyText.includes('successfully submitted')) detected.push('contains "successfully submitted"');
      const divs = Array.from(document.querySelectorAll('div'));
      if (divs.some(div => div.innerText.includes('Your request to make a Prepaid topup or bill payment was successfully submitted.')))
        detected.push('contains prepaid/bill success banner');
      const sel = document.querySelector('#app > div.application--wrap > main > div > div > div.container.fluid.grid-list-xl > div > div:nth-child(2) > div > div');
      if (sel) detected.push('contains green section container');
      return detected;
    });
    if (criteria && criteria.length) { foundCriteria = criteria; break; }
    await delay(500);
  }

  if (foundCriteria.length > 0) {
    console.log('AUTO_TOPUP_SUCCESS');
    foundCriteria.forEach(c => console.log('   - ' + c));
    return { success: true, evidence: foundCriteria };
  }
  console.log('AUTO_TOPUP_FAILED');
  return { success: false, evidence: [] };
}

async function handleTopup(page) {
  console.log('\nTOPUP_START');
  await openMenu(page);
  await clickMenuByText(page, 'Dealer Kits');
  await clickMenuByText(page, 'Topup/Pay bill');
  await delay(2000);

  const formattedAmount = Number(autoData.amount).toFixed(2);
  await fillFieldByText(page, 'mobile number', autoData.phone);
  await fillFieldByText(page, 'amount to pay', formattedAmount);
  console.log(`FIELDS_FILLED ${autoData.phone} ${formattedAmount}`);

  const submitResult = await clickContinueThenSubmit(page);
  if (!submitResult.success) {
    console.log('AUTO_TOPUP_FAILED');
  } else {
    console.log('AUTO_TOPUP_SUCCESS');
  }
}

async function main() {
  const session = await login();
  if (!session) return;
  const { browser, page } = session;
  await closePopup(page);
  try {
    await handleTopup(page);
  } catch (err) {
    console.log('AUTO_TOPUP_FAILED', err.message);
  }
  await delay(2000);
  await browser.close();
  console.log('TOPUP_DONE');
}

main().catch(err => console.error('TOPUP_FATAL', err));
