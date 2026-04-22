// onesys-autorecharge.js (clean rewrite)
import puppeteer from 'puppeteer';
import fs from 'fs';

// Expected autodata.json:
// { "dealerId": "dysd123", "amount": 30 }
const autoData = JSON.parse(fs.readFileSync('autodata.json', 'utf8'));

const loginURL =
  'https://idp.onexox.my/auth/realms/onesys/protocol/openid-connect/auth' +
  '?client_id=webapp&redirect_uri=https%3A%2F%2Fonesys.onexox.my%2F&response_mode=fragment' +
  '&response_type=code&scope=openid&nonce=abc123';

const PUPPETEER_OPTS = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function login() {
  const browser = await puppeteer.launch(PUPPETEER_OPTS);
  const page = await browser.newPage();
  await page.goto(loginURL, { waitUntil: 'networkidle2' });
  try {
    await page.waitForSelector('input#username', { timeout: 10000 });
    // Update creds if needed
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
    await page.waitForSelector('.v-btn .v-btn__content .v-icon', { timeout: 8000 });
    await page.click('.v-btn .v-btn__content .v-icon');
    console.log('MENU_OPENED');
    return true;
  } catch (err) {
    console.log('MENU_BUTTON_NOT_FOUND', err.message);
    return false;
  }
}

async function goToTransferERecharge(page) {
  const url = 'https://onesys.onexox.my/ecash_transfer';
  try {
    await page.goto(url, { waitUntil: 'networkidle2' });
    console.log('NAVIGATE_OK', url);
    return true;
  } catch (err) {
    console.log('NAVIGATE_FAILED', err.message);
    return false;
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

async function clickMenuByHref(page, href) {
  await delay(500);
  const success = await page.evaluate(targetHref => {
    const link = document.querySelector(`a[href="${targetHref}"]`);
    if (link) {
      link.scrollIntoView();
      link.click();
      return true;
    }
    return false;
  }, href);
  if (!success) throw new Error(`Menu href "${href}" tidak dijumpai`);
  console.log(`MENU_CLICK: ${href}`);
}

async function fillInFrames(page, selector, value, label) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      await frame.waitForSelector(selector, { timeout: 3000 });
      await frame.$eval(
        selector,
        (el, v) => {
          el.focus();
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        value
      );
      console.log(`FIELD_FILL ${label} "${selector}" in frame "${frame.url()}"`);
      return true;
    } catch {}
  }
  return false;
}

async function fillFieldByText(page, fieldIdentifier, textValue) {
  const lowerId = fieldIdentifier.toLowerCase();

  const trySelector = async (selector, label) => {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.$eval(
        selector,
        (el, value) => {
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        textValue
      );
      console.log(`FIELD_FILL ${label} "${selector}" with "${textValue}"`);
      return true;
    } catch {
      return false;
    }
  };

  if (lowerId.includes('dealer id')) {
    await page.waitForFunction(() => {
      const inputs = Array.from(document.querySelectorAll('input[aria-label]'));
      return inputs.some(i =>
        (i.getAttribute('aria-label') || '').toLowerCase().includes('dealer id')
      );
    }, { timeout: 10000 }).catch(() => {});
  }

  if (await trySelector(`input[aria-label="${fieldIdentifier}"]`, 'aria-label-exact')) return;
  if (await trySelector('input[aria-label*="Dealer Id"]', 'aria-label-contains')) return;
  if (await trySelector(`input[aria-label*="${fieldIdentifier}"]`, 'aria-label')) return;
  if (await trySelector(`input[placeholder*="${fieldIdentifier}"]`, 'placeholder')) return;

  // Fallback: first text input in main content
  try {
    const filled = await page.evaluate((value) => {
      const scope = document.querySelector('main') || document;
      const inputs = Array.from(scope.querySelectorAll('input[type="text"]'));
      if (!inputs.length) return false;
      const el = inputs[0];
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, textValue);
    if (filled) {
      console.log(`FIELD_FILL fallback first input with "${textValue}"`);
      return;
    }
  } catch {}

  // Fallback: search by text label
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
    if (!input) return { error: `Tiada input/textarea untuk "${identifier}".` };
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }, fieldIdentifier, textValue);

  if (result.error) throw new Error(result.error);
  console.log(`FIELD_FILL label "${fieldIdentifier}" with "${textValue}"`);
}
async function clickButtonByExactText(page, exactText) {
  await page.waitForFunction(
    text => [...document.querySelectorAll('.v-btn__content')].some(el => el.innerText.trim() === text),
    { timeout: 5000 },
    exactText
  );
  const allButtons = await page.$$('.v-btn__content');
  const index = await page.$$eval('.v-btn__content', els =>
    els.findIndex(e => e.innerText.trim() === arguments[0]),
    exactText
  );
  if (index === -1) return false;
  const button = allButtons[index];
  if (!button) return false;
  await page.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }), button);
  await delay(400);
  const box = await button.boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  console.log(`BUTTON_CLICK: ${exactText}`);
  return true;
}

async function clickSubmitFlexible(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(300);

  const clicked = await page.evaluate(() => {
    const selectors = [
      '.v-btn.theme--dark.primary',
      '.v-btn.theme--dark.primary .v-btn__content',
      'button.v-btn.theme--dark.primary',
      'button',
      '.v-btn__content',
      'div',
      'span',
    ];
    const isSubmit = (el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t.includes('submit');
    };
    for (const sel of selectors) {
      const list = Array.from(document.querySelectorAll(sel));
      const target = list.find(isSubmit);
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof target.click === 'function') target.click();
        else target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }
    }
    return false;
  }).catch(() => false);

  if (clicked) {
    console.log('BUTTON_SUBMIT_CLICKED');
    return true;
  }

  console.log('BUTTON_SUBMIT_NOT_FOUND');
  return false;
}

async function clickContinueThenSubmit(page) {
  await delay(1000);
  let clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.v-btn')].find(b =>
      b.innerText.trim().toLowerCase().includes('continue')
    );
    if (btn) {
      btn.scrollIntoView();
      btn.click();
      return true;
    }
    return false;
  });
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.v-btn')].find(b =>
        b.innerText.trim().toLowerCase().includes('next')
      );
      if (btn) {
        btn.scrollIntoView();
        btn.click();
        return true;
      }
      return false;
    });
  }
  console.log(clicked ? 'CONTINUE_NEXT_CLICKED' : 'CONTINUE_NEXT_MISSING');

  await delay(2000);
  await page.screenshot({ path: 'after_continue.png' });

  // Tunggu butang submit muncul di step 2 (sehingga 15s)
  try {
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('.v-btn__content, button')];
      return nodes.some(n => (n.textContent || '').toLowerCase().includes('submit'));
    }, { timeout: 15000 });
    console.log('SUBMIT_VISIBLE');
  } catch {
    console.log('SUBMIT_NOT_FOUND_WITHIN_15S');
    await page.screenshot({ path: 'submit_not_found.png', fullPage: true });
    return { success: false, evidence: ['Butang SUBMIT tidak muncul selepas Continue'] };
  }

  const submitClicked = await clickSubmitFlexible(page);
  if (!submitClicked) {
    return { success: false, evidence: ['Butang SUBMIT tidak dapat ditekan'] };
  }
  await delay(2000);
  await page.screenshot({ path: 'after_submit.png' });
  await page.screenshot({ path: 'after_submit_full.png', fullPage: true });
  try {
    const html = await page.content();
    fs.writeFileSync('after_submit.html', html, 'utf8');
  } catch (err) {
    console.log('WARN: unable to save after_submit.html', err.message);
  }

  const startTime = Date.now();
  let foundCriteria = [];
  while (Date.now() - startTime < 30000) { // wait up to 30s for toast/page update
    const criteria = await page.evaluate(() => {
      const detected = [];
      const bodyText = document.body.innerText.toLowerCase();
      if (bodyText.includes('successfully submitted')) detected.push('contains "successfully submitted"');
      if (bodyText.includes('request to transfer e-recharge was successfully submitted'))
        detected.push('contains full success message');
      if (bodyText.includes('your request to transfer e-recharge was successfully submitted'))
        detected.push('contains exact banner text');
      if (bodyText.includes('submitted successfully')) detected.push('contains "submitted successfully"');
      if (bodyText.includes('success') && bodyText.includes('submitted'))
        detected.push('generic success+submitted text');
      if (bodyText.includes('success') && bodyText.includes('transfer'))
        detected.push('generic success+transfer text');
      if (bodyText.includes('your request to transfer e-recharge was successfully submitted'))
        detected.push('contains exact green banner text');
      const successAlert = document.querySelector('.v-alert.success, .v-alert--success, .alert-success');
      if (successAlert) detected.push('success alert element detected');

      const snack = document.querySelector('.v-snack--active .v-snack__content');
      if (snack && snack.textContent) {
        const snackText = snack.textContent.toLowerCase();
        if (snackText.includes('success') || snackText.includes('submitted')) {
          detected.push('snack success: ' + snack.textContent.trim().slice(0, 160));
        }
      }

      const errorAlert = document.querySelector('.v-alert.error, .v-alert--error, .alert-danger, .v-alert.warning, .v-alert--warning');
      if (errorAlert && errorAlert.textContent.trim()) {
        detected.push('error alert: ' + errorAlert.textContent.trim().slice(0, 160));
      }

      const fieldErrors = Array.from(document.querySelectorAll('.v-messages__message, .error--text'))
        .map(e => (e.textContent || '').trim())
        .filter(Boolean);
      if (fieldErrors.length) detected.push('field errors: ' + fieldErrors.slice(0, 3).join(' | '));

      const submitStepComplete = Array.from(document.querySelectorAll('.v-stepper__step'))
        .some(step => step.classList.contains('v-stepper__step--complete') &&
          (step.textContent || '').toLowerCase().includes('submit'));
      if (submitStepComplete) detected.push('submit step marked complete');
      return detected;
    });
    let detected = criteria;
    if (!detected || detected.length === 0) {
      // Check inside iframes as some pages render content in frames
      for (const frame of page.frames()) {
        try {
          const frameCriteria = await frame.evaluate(() => {
            const found = [];
            const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
            if (bodyText.includes('successfully submitted')) found.push('frame contains "successfully submitted"');
            if (bodyText.includes('request to transfer e-recharge was successfully submitted'))
              found.push('frame contains full success message');
            if (bodyText.includes('your request to transfer e-recharge was successfully submitted'))
              found.push('frame contains exact banner text');
            const successAlert = document.querySelector('.v-alert.success, .v-alert--success, .alert-success');
            if (successAlert) found.push('frame success alert element detected');
            return found;
          });
          if (frameCriteria && frameCriteria.length > 0) {
            detected = frameCriteria;
            break;
          }
        } catch {}
      }
    }
    if (detected && detected.length > 0) {
      foundCriteria = detected;
      break;
    }
    await delay(500);
  }

  if (foundCriteria.length > 0) {
    foundCriteria.forEach(crit => console.log('SUCCESS_FLAG: ' + crit));
    const hasError = foundCriteria.some(crit =>
      crit.startsWith('error alert:') || crit.startsWith('field errors:')
    );
    if (hasError) {
      console.log('VALIDATION_ERROR');
      return { success: false, evidence: foundCriteria };
    }
    return { success: true, evidence: foundCriteria };
  }
  return { success: false, evidence: [] };
}

async function handleERecharge(page) {
  console.log('ERECHARGE_START');
  const navigated = await goToTransferERecharge(page);
  if (!navigated) {
    const menuOpened = await openMenu(page);
    if (!menuOpened) {
      throw new Error('Menu utama gagal dibuka dan direct nav gagal');
    }
    await clickMenuByText(page, 'Dealer Kits');
    await clickMenuByText(page, 'e-recharge');
    await clickMenuByHref(page, '/ecash_transfer');
    await delay(3000);
  }

  try {
    const url = page.url();
    const title = await page.title();
    console.log('PAGE_INFO', url, title);
  } catch {}

  // Wait until transfer form is actually rendered
  try {
    await page.waitForFunction(() => {
      const hasDealerInput =
        document.querySelector('input[aria-label="Enter Dealer Id"]') ||
        document.querySelector('input[aria-label*="Dealer Id"]') ||
        document.querySelector('input[placeholder*="Enter Dealer Id"]');
      const hasLabelText = Array.from(document.querySelectorAll('*'))
        .some(el => (el.textContent || '').toLowerCase().includes('dealer id'));
      return Boolean(hasDealerInput) || hasLabelText;
    }, { timeout: 15000 });
  } catch (err) {
    console.log('FORM_WAIT_FAILED', err.message);
    try {
      await page.screenshot({ path: 'form_not_ready.png', fullPage: true });
      const html = await page.content();
      fs.writeFileSync('form_not_ready.html', html, 'utf8');
    } catch {}
  }

  const formattedAmount = Number(autoData.amount).toFixed(2);

  const dealerSelector = 'input[aria-label="Enter Dealer Id"]';
  const dealerFilled = await fillInFrames(page, dealerSelector, autoData.dealerId, 'dealer-id');
  if (!dealerFilled) {
    await fillFieldByText(page, 'Enter Dealer Id', autoData.dealerId);
  }

  const amountSelector = 'input[aria-label="Enter transfer amount"], input[placeholder*="Enter transfer amount"]';
  const amountFilled = await fillInFrames(page, amountSelector, formattedAmount, 'transfer-amount');
  if (!amountFilled) {
    await fillFieldByText(page, 'Enter transfer amount', formattedAmount);
  }
  console.log('FIELDS_FILLED', autoData.dealerId, formattedAmount);

  const submitResult = await clickContinueThenSubmit(page);
  if (!submitResult.success) console.log('SUBMIT_FAILED');
  return submitResult;
}

async function main() {
  const session = await login();
  if (!session) {
    console.log('AUTO_RECHARGE_FAILED');
    return;
  }
  const { browser, page } = session;
  try {
    await closePopup(page);
    const result = await handleERecharge(page);
    if (result && result.success) {
      console.log('AUTO_RECHARGE_SUCCESS');
    } else {
      console.log('AUTO_RECHARGE_FAILED');
    }
  } catch (err) {
    console.error('AUTO_RECHARGE_FAILED', err.message);
  } finally {
    await delay(3000);
    await browser.close();
    console.log('AUTORECHARGE_DONE');
  }
}

main().catch(err => {
  console.error('AUTO_RECHARGE_FAILED', err);
});



