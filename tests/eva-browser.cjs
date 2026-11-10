/* Dev-only: NODE_PATH=/path/to/node_modules node tests/eva-browser.cjs
   Optional BROWSER_PATH and SCREENSHOT_DIR. Opens index.html through file://. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');

const url = pathToFileURL(path.resolve(__dirname, '../index.html')).href;
const screenshotDir = process.env.SCREENSHOT_DIR || '/tmp/simple-clock-eva';
const settingsKey = 'simple-clock.settings.v1';
const timerKey = 'simple-clock.timer.v1';
const errors = [];
const externalRequests = [];
let browser;
let passed = 0;

async function fixture(seed = {}, extra = {}) {
  const context = await browser.newContext({
    viewport: { width: 480, height: 800 }, timezoneId: 'Asia/Seoul', ...extra,
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.addInitScript(({ seed, settingsKey, timerKey }) => {
    if (!sessionStorage.getItem('eva-qa-initialized')) {
      localStorage.clear();
      if (seed.settings) localStorage.setItem(settingsKey, JSON.stringify(seed.settings));
      if (seed.timer) localStorage.setItem(timerKey, JSON.stringify(seed.timer));
      sessionStorage.setItem('eva-qa-initialized', '1');
    }
    window.__evaQaAudioOscillators = 0;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (Audio) {
      const createOscillator = Audio.prototype.createOscillator;
      Audio.prototype.createOscillator = function (...args) {
        window.__evaQaAudioOscillators++;
        return createOscillator.apply(this, args);
      };
    }
  }, { seed, settingsKey, timerKey });
  await page.clock.install({ time: new Date('2026-11-09T14:32:08+09:00') });
  await page.clock.pauseAt(new Date('2026-11-09T14:32:09+09:00'));
  await page.goto(url);
  return { page, context };
}

async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const state = page => page.locator('html').getAttribute('data-timer-state');
const remaining = page => page.locator('#timer-remaining').textContent();
const hasClass = (page, name) => page.locator('html').evaluate((root, value) => root.classList.contains(value), name);
const openSettings = page => page.locator('#settings-open').click();
const saveSettings = page => page.locator('#settings-form button[type="submit"]').click();
const savedSettings = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), settingsKey);
const pausedTimer = (remainingMs = 250) => ({ version: 1, state: 'paused', durationMs: 60_000, remainingMs });

async function setEva(page, enabled) {
  await openSettings(page);
  await page.locator('[name="evaMode"]').setChecked(enabled);
  await saveSettings(page);
  assert.equal(await hasClass(page, 'eva-mode'), enabled);
}

function parseMilliseconds(text) {
  const match = /^(\d{2,3}):(\d{2})\.(\d{3})$/.exec(text.trim());
  assert.ok(match, `Expected MM:SS.mmm, received ${JSON.stringify(text)}`);
  return Number(match[1]) * 60_000 + Number(match[2]) * 1_000 + Number(match[3]);
}

async function editMinutes(page, minutes) {
  await page.locator('#timer-edit-open').click();
  await page.locator('#timer-minutes').fill(String(minutes));
  await page.locator('#timer-minutes').press('Enter');
}

async function resizeViewport(page, width, height) {
  const unchanged = await page.evaluate(({ width, height }) => {
    if (innerWidth === width && innerHeight === height) return true;
    window.__evaQaResizeComplete = false;
    window.addEventListener('resize', () => { window.__evaQaResizeComplete = true; }, { once: true });
    return false;
  }, { width, height });
  await page.setViewportSize({ width, height });
  if (unchanged) return;
  // Browser resize delivery uses real rendering tasks, independently of the paused
  // test clock. Wait for that event without synthesizing it or waiting on app state.
  const deadline = Date.now() + 2_000;
  let observed;
  do {
    observed = await page.evaluate(() => ({ event: window.__evaQaResizeComplete, width: innerWidth, height: innerHeight }));
    if (observed.event && observed.width === width && observed.height === height) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Browser resize was not delivered for ${width}x${height}: ${JSON.stringify(observed)}`);
}

async function assertNoEffect(page) {
  assert.equal(await hasClass(page, 'eva-alarm'), false);
  assert.equal(await hasClass(page, 'screen-pulsing'), false);
  assert.equal(await page.locator('#ring-complete').evaluate(element => element.classList.contains('pulsing')), false);
  assert.equal(await page.locator('#eva-alarm-overlay').isVisible(), false);
  assert.equal(await page.locator('#eva-alarm-overlay').evaluate(element => element.hidden), true);
}

async function assertViewportOverlay(page, width, height) {
  const overlay = await page.locator('#eva-alarm-overlay').boundingBox();
  assert.ok(overlay, 'Emergency overlay must be visible');
  for (const [key, expected] of Object.entries({ x: 0, y: 0, width, height })) {
    assert.ok(Math.abs(overlay[key] - expected) <= 1, `Overlay ${key}: ${overlay[key]} instead of ${expected}`);
  }
  const structure = await page.locator('#eva-alarm-overlay').evaluate(element => ({
    directChild: element.parentElement === document.body,
    position: getComputedStyle(element).position,
  }));
  assert.deepEqual(structure, { directChild: true, position: 'fixed' });
  const plate = await page.locator('.eva-alarm-plate').boundingBox();
  assert.ok(plate && plate.width > 0 && plate.height > 0);
  assert.ok(Math.abs(plate.y + plate.height / 2 - height / 2) <= 2, 'Warning must stay centered in the viewport');
  assert.ok(plate.x >= -1 && plate.x + plate.width <= width + 1, 'Emergency text must fit the viewport');
  const dismiss = await page.locator('#eva-alarm-dismiss').boundingBox();
  assert.ok(dismiss && dismiss.width >= 32 && dismiss.height >= 32);
  assert.ok(dismiss.y >= 0 && dismiss.y + dismiss.height <= height + 1, 'Dismiss must remain reachable');
}

(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  console.log(`Browser: ${await browser.version()}`);
  await fs.mkdir(screenshotDir, { recursive: true });

  await check('old/invalid settings default to normal; EVA save, cancel, reload and sound draft', async () => {
    for (const settings of [{ version: 1 }, { version: 1, evaMode: 'true' }]) {
      const { page, context } = await fixture({ settings });
      assert.equal(await hasClass(page, 'eva-mode'), false);
      await context.close();
    }
    const { page, context } = await fixture({ settings: { version: 1, soundEnabled: true } });
    await openSettings(page);
    await page.locator('[name="evaMode"]').check();
    assert.equal(await page.locator('[name="soundEnabled"]').isDisabled(), true);
    assert.equal(await page.locator('[name="soundEnabled"]').isChecked(), true);
    assert.equal(await hasClass(page, 'eva-mode'), false, 'Draft must not apply the theme');
    await page.locator('#settings-cancel').click();
    assert.equal(await hasClass(page, 'eva-mode'), false);
    await setEva(page, true);
    assert.equal((await savedSettings(page)).soundEnabled, true);
    await page.reload();
    assert.equal(await hasClass(page, 'eva-mode'), true);
    assert.equal(await page.locator('#alert-mode').isVisible(), false);
    await openSettings(page);
    await page.locator('[name="evaMode"]').uncheck();
    assert.equal(await page.locator('[name="soundEnabled"]').isDisabled(), false);
    await page.keyboard.press('Escape');
    assert.equal(await hasClass(page, 'eva-mode'), true);
    await context.close();
  });

  await check('theme switching preserves idle/running/paused/completed time and total', async () => {
    for (const wantedState of ['idle', 'running', 'paused', 'completed']) {
      const durationMs = 30 * 60_000;
      const timer = { version: 1, state: wantedState === 'running' ? 'paused' : wantedState,
        durationMs, remainingMs: wantedState === 'completed' ? 0 : wantedState === 'idle' ? durationMs : 902_000 };
      const { page, context } = await fixture({ timer });
      if (wantedState === 'running') await page.locator('#toggle').click();
      const before = await remaining(page);
      const total = await page.locator('#timer-total').textContent();
      for (let iteration = 0; iteration < 2; iteration++) {
        await setEva(page, true);
        assert.equal(await state(page), wantedState);
        assert.equal(await remaining(page), `${before}.000`);
        assert.equal(await page.locator('#timer-total').textContent(), total);
        await setEva(page, false);
        assert.equal(await state(page), wantedState);
        assert.equal(await remaining(page), before);
      }
      if (wantedState === 'running') {
        await page.clock.runFor(1_000);
        assert.equal(await remaining(page), '15:01', 'Repeated theme changes must not duplicate the countdown');
      }
      await context.close();
    }
  });

  await check('EVA offline layouts, 180-minute digits, resize and small settings dialog', async () => {
    const { page, context } = await fixture({ settings: { version: 1, evaMode: true, defaultMinutes: 180 } });
    await context.setOffline(true);
    await page.reload();
    assert.equal(await remaining(page), '180:00.000');
    assert.equal(await page.locator('#eva-digits').getAttribute('aria-hidden'), 'true');
    for (const [width, height] of [
      [320, 450], [320, 600], [390, 844], [480, 800], [280, 400], [640, 720],
      [800, 480], [1024, 768], [1440, 900], [1920, 1080], [1080, 1920], [1280, 600],
    ]) {
      await resizeViewport(page, width, height);
      await page.clock.runFor(50);
      const expected = width < 600 || height / width >= 1.25 ? 'portrait'
        : width >= 1000 && height >= 650 ? 'wide' : 'medium';
      assert.equal(await page.locator('html').getAttribute('data-eva-layout'), expected, `${width}x${height}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Horizontal overflow at ${width}x${height}`);
      const digitBox = await page.locator('#eva-digits').boundingBox();
      const buttonBox = await page.locator('#timer-edit-open').boundingBox();
      assert.ok(digitBox && digitBox.width > 0 && digitBox.height > 0);
      assert.ok(digitBox.x >= -1 && digitBox.x + digitBox.width <= width + 1, `Clipped digits at ${width}x${height}`);
      assert.ok(digitBox.x >= buttonBox.x - 1 && digitBox.x + digitBox.width <= buttonBox.x + buttonBox.width + 1);
      for (const id of ['toggle', 'reset', 'settings-open']) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert.ok(box && box.width >= 32 && box.height >= 32, `${id} target too small at ${width}x${height}`);
      }
      if (expected === 'wide') {
        for (const selector of ['.eva-magi', '.eva-session', '.eva-monitor']) assert.equal(await page.locator(selector).isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), true, `Wide control room exceeds viewport at ${width}x${height}`);
      }
      await page.screenshot({ path: path.join(screenshotDir, `eva-${width}x${height}.png`), fullPage: true });
      await openSettings(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#settings-form button[type="submit"]').scrollIntoViewIfNeeded();
      const save = await page.locator('#settings-form button[type="submit"]').boundingBox();
      assert.ok(save.y >= 0 && save.y + save.height <= height + 1, `Settings save inaccessible at ${width}x${height}`);
      if (width === 280 || width === 320 || width === 1440) {
        await page.screenshot({ path: path.join(screenshotDir, `eva-settings-${width}x${height}.png`) });
      }
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#settings-open').evaluate(element => element === document.activeElement), true);
      assert.equal(await state(page), 'idle');
    }
    await context.close();
  });

  await check('real milliseconds pause, resume and freeze; active RAF stops while paused or hidden', async () => {
    const { page, context } = await fixture({ settings: { version: 1, evaMode: true }, timer: pausedTimer(10_000) });
    await page.evaluate(() => {
      const request = window.requestAnimationFrame.bind(window);
      window.__evaQaFrames = 0;
      window.requestAnimationFrame = callback => request(time => { window.__evaQaFrames++; callback(time); });
    });
    await page.locator('#toggle').click();
    await page.clock.runFor(1_137);
    const runningMs = parseMilliseconds(await remaining(page));
    assert.ok(Math.abs(runningMs - 8_863) <= 34, `Unexpected interpolated time: ${runningMs}`);
    assert.ok(await page.evaluate(() => window.__evaQaFrames > 10), 'Running countdown should update between timer samples');
    await page.locator('#toggle').click();
    const pausedMs = parseMilliseconds(await remaining(page));
    await page.clock.runFor(100);
    const pausedFrames = await page.evaluate(() => window.__evaQaFrames);
    await page.clock.runFor(1_000);
    assert.equal(parseMilliseconds(await remaining(page)), pausedMs);
    assert.equal(await page.evaluate(() => window.__evaQaFrames), pausedFrames);
    await page.locator('#toggle').click();
    await page.clock.runFor(400);
    assert.ok(Math.abs(parseMilliseconds(await remaining(page)) - (pausedMs - 400)) <= 34);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(100);
    const hiddenFrames = await page.evaluate(() => window.__evaQaFrames);
    await page.clock.runFor(1_000);
    assert.equal(await page.evaluate(() => window.__evaQaFrames), hiddenFrames);
    await page.evaluate(() => {
      delete document.hidden;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(100);
    assert.equal(await state(page), 'running');
    assert.ok(await page.evaluate(() => window.__evaQaFrames) > hiddenFrames);
    await context.close();
  });

  await check('execution gaps pause before decrement; reload restores milliseconds without running', async () => {
    const { page, context } = await fixture({ settings: { version: 1, evaMode: true }, timer: pausedTimer(2_345) });
    await page.locator('#toggle').click();
    await page.clock.fastForward(60_000);
    assert.equal(await state(page), 'paused');
    assert.equal(await remaining(page), '00:02.345');
    await assertNoEffect(page);
    await page.locator('#toggle').click();
    await page.clock.runFor(500);
    await page.reload();
    assert.equal(await state(page), 'paused');
    assert.equal(await remaining(page), '00:01.845');
    await page.clock.runFor(2_000);
    assert.equal(await remaining(page), '00:01.845');
    await context.close();
  });

  await check('EVA preserves D-day, presets, direct minute editing and keyboard paths', async () => {
    const { page, context } = await fixture({ settings: { version: 1, evaMode: true } });
    await page.locator('#dday').dblclick();
    await page.locator('#dday-date').fill('2026-11-23');
    await page.locator('#dday-date').press('Enter');
    assert.equal(await page.locator('#dday').textContent(), 'D-14');
    for (const minutes of [1, 25, 180]) {
      await editMinutes(page, minutes);
      assert.equal(await remaining(page), `${String(minutes).padStart(2, '0')}:00.000`);
      assert.equal(await state(page), 'idle');
    }
    await page.locator('#timer-edit-open').focus();
    await page.keyboard.press('Enter');
    await page.locator('#timer-minutes').fill('5');
    await page.keyboard.press('Escape');
    assert.equal(await remaining(page), '180:00.000');
    for (const [index, minutes] of [10, 20, 25, 60].entries()) {
      await page.locator('.preset').nth(index).click();
      assert.equal(await state(page), 'running');
      assert.equal(await remaining(page), `${minutes}:00.000`);
      await page.locator('#reset').click();
    }
    await context.close();
  });

  await check('EVA overlays the viewport without moving panels, remains silent and expires after 30 seconds', async () => {
    const { page, context } = await fixture({ settings: { version: 1, evaMode: true, soundEnabled: true }, timer: pausedTimer() });
    await page.locator('#toggle').click();
    const before = await Promise.all(['#timer-panel', '.clock-panel'].map(selector => page.locator(selector).boundingBox()));
    await page.clock.runFor(250);
    assert.equal(await state(page), 'completed');
    assert.equal(await remaining(page), '00:00.000');
    assert.equal(await hasClass(page, 'eva-alarm'), true);
    assert.equal(await page.locator('#eva-emergency').isVisible(), false, 'Use the floating alarm during active completion');
    assert.equal(await page.locator('#eva-alarm-overlay').isVisible(), true);
    assert.equal(await page.evaluate(() => window.__evaQaAudioOscillators), 0);
    const after = await Promise.all(['#timer-panel', '.clock-panel'].map(selector => page.locator(selector).boundingBox()));
    for (let index = 0; index < before.length; index++) {
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(before[index][key] - after[index][key]) <= 1, `Alarm changed panel ${index} ${key}`);
      }
    }
    for (const [width, height] of [[280, 400], [320, 450], [800, 480], [1440, 900]]) {
      await resizeViewport(page, width, height);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await assertViewportOverlay(page, width, height);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await assertViewportOverlay(page, width, height);
      await page.screenshot({ path: path.join(screenshotDir, `eva-emergency-${width}x${height}.png`) });
      await openSettings(page);
      assert.equal(await page.locator('#settings-dialog').evaluate(dialog => {
        const close = document.getElementById('settings-close').getBoundingClientRect();
        return dialog.contains(document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2));
      }), true, 'Settings must remain above the emergency layer');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#settings-dialog').isVisible(), false);
      assert.equal(await page.locator('#eva-alarm-overlay').isVisible(), true, 'Escape in settings must only close settings');
    }
    await page.clock.runFor(29_750);
    assert.equal(await hasClass(page, 'eva-alarm'), true);
    await page.clock.runFor(250);
    await assertNoEffect(page);
    assert.equal(await page.locator('#eva-emergency').isVisible(), true);
    assert.equal(await remaining(page), '00:00.000');
    await page.reload();
    assert.equal(await state(page), 'completed');
    await assertNoEffect(page);
    assert.equal(await page.locator('#eva-emergency').isVisible(), true);
    await context.close();
  });

  await check('emergency dismissal preserves completion; Escape respects editors and no dismissed effect replays', async () => {
    for (const method of ['click', 'keyboard', 'escape']) {
      const { page, context } = await fixture({ settings: { version: 1, evaMode: true }, timer: pausedTimer() },
        { viewport: { width: 320, height: 450 } });
      await page.locator('#toggle').click();
      await page.clock.runFor(250);
      assert.equal(await page.locator('#eva-alarm-overlay').isVisible(), true);
      if (method === 'escape') {
        await page.locator('#timer-edit-open').click();
        await page.locator('#timer-minutes').fill('7');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#timer-editor').isVisible(), false);
        assert.equal(await page.locator('#eva-alarm-overlay').isVisible(), true, 'Editor Escape must not also dismiss the alarm');
        await page.locator('#dday').dblclick();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#dday-editor').isVisible(), false);
        assert.equal(await page.locator('#eva-alarm-overlay').isVisible(), true, 'D-day Escape must not also dismiss the alarm');
        await page.keyboard.press('Escape');
      } else if (method === 'keyboard') {
        await page.locator('#eva-alarm-dismiss').focus();
        await page.keyboard.press('Enter');
      } else await page.locator('#eva-alarm-dismiss').click();
      await assertNoEffect(page);
      assert.equal(await state(page), 'completed');
      assert.equal(await remaining(page), '00:00.000');
      assert.equal(await page.locator('#eva-emergency').isVisible(), true);
      await setEva(page, false);
      await setEva(page, true);
      await assertNoEffect(page);
      await page.reload();
      await assertNoEffect(page);
      assert.equal(await state(page), 'completed');
      await context.close();
    }
  });

  await check('completion at 20 seconds can change themes without resetting the deadline or normal options', async () => {
    for (const initiallyEva of [false, true]) {
      for (const alertMode of ['ring', 'screen']) {
        const { page, context } = await fixture({
          settings: { version: 1, evaMode: initiallyEva, alertMode, soundEnabled: true }, timer: pausedTimer(),
        });
        await page.locator('#toggle').click();
        await page.clock.runFor(20_250);
        const sounds = await page.evaluate(() => window.__evaQaAudioOscillators);
        await setEva(page, !initiallyEva);
        assert.equal(await state(page), 'completed');
        assert.equal(await page.locator('#eva-alarm-overlay').isVisible(), !initiallyEva);
        assert.equal(await page.locator('#alert-mode').isVisible(), initiallyEva);
        assert.equal((await savedSettings(page)).alertMode, alertMode);
        assert.equal((await savedSettings(page)).soundEnabled, true);
        assert.equal(await page.evaluate(() => window.__evaQaAudioOscillators), sounds);
        await page.clock.runFor(9_000);
        const active = initiallyEva
          ? alertMode === 'screen' ? await hasClass(page, 'screen-pulsing')
            : await page.locator('#ring-complete').evaluate(element => element.classList.contains('pulsing'))
          : await hasClass(page, 'eva-alarm');
        assert.equal(active, true);
        await page.clock.runFor(1_000);
        await assertNoEffect(page);
        await setEva(page, initiallyEva);
        await assertNoEffect(page);
        await context.close();
      }
    }
  });

  await check('EVA emergency clears on start/reset/edit/disable/reduced motion/gap/page exit', async () => {
    for (const action of ['start', 'reset', 'edit', 'disable', 'reduce', 'gap', 'exit']) {
      const { page, context } = await fixture({ settings: { version: 1, evaMode: true }, timer: pausedTimer() });
      await page.locator('#toggle').click();
      await page.clock.runFor(250);
      assert.equal(await hasClass(page, 'eva-alarm'), true);
      assert.equal(await page.locator('#eva-alarm-overlay').isVisible(), true);
      if (action === 'start') await page.locator('.preset').first().click();
      if (action === 'reset') await page.locator('#reset').click();
      if (action === 'edit') await editMinutes(page, 7);
      if (action === 'disable') {
        await openSettings(page);
        await page.locator('[name="pulseEnabled"]').uncheck();
        await saveSettings(page);
      }
      if (action === 'reduce') await page.emulateMedia({ reducedMotion: 'reduce' });
      if (action === 'gap') await page.clock.fastForward(60_000);
      if (action === 'exit') await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      // Media query listeners are asynchronous browser events; a real task lets them settle.
      if (action === 'reduce') await page.waitForFunction(() => !document.documentElement.classList.contains('eva-alarm'));
      await assertNoEffect(page);
      const stillCompleted = ['disable', 'reduce', 'gap', 'exit'].includes(action);
      assert.equal(await page.locator('#eva-emergency').isVisible(), stillCompleted);
      if (stillCompleted) {
        if (action === 'reduce') await page.emulateMedia({ reducedMotion: 'no-preference' });
        if (action === 'disable') {
          await openSettings(page);
          await page.locator('[name="pulseEnabled"]').check();
          await saveSettings(page);
        }
        await setEva(page, false);
        await setEva(page, true);
        await assertNoEffect(page);
      }
      await context.close();
    }
  });

  await check('disabled visuals and reduced motion begin with static EVA completion', async () => {
    for (const reduced of [false, true]) {
      const { page, context } = await fixture({
        settings: { version: 1, evaMode: true, pulseEnabled: reduced }, timer: pausedTimer(),
      }, { reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.locator('#toggle').click();
      await page.clock.runFor(250);
      assert.equal(await state(page), 'completed');
      assert.equal(await page.locator('#eva-emergency').isVisible(), true);
      await assertNoEffect(page);
      await context.close();
    }
  });

  await check('normal screen alert uses the stronger one-second pulse and still stops at 30 seconds', async () => {
    const { page, context } = await fixture({ settings: { version: 1, alertMode: 'screen' }, timer: pausedTimer() });
    await page.locator('#toggle').click();
    await page.clock.runFor(250);
    const animation = await page.evaluate(() => {
      const effect = document.getAnimations().find(item => item.effect.target === document.documentElement);
      if (!effect) return null;
      effect.pause();
      effect.currentTime = 500;
      return { timing: effect.effect.getTiming(), color: getComputedStyle(document.documentElement).backgroundColor };
    });
    assert.ok(animation, 'Screen completion must animate the page background');
    assert.equal(animation.timing.duration, 1_000);
    assert.equal(animation.timing.iterations, 30);
    assert.equal(animation.color, 'rgb(100, 42, 46)');
    await page.screenshot({ path: path.join(screenshotDir, 'normal-screen-alert-peak.png') });
    await page.clock.runFor(30_000);
    await assertNoEffect(page);
    assert.equal(await page.locator('html').evaluate(root => getComputedStyle(root).backgroundColor), 'rgb(13, 12, 15)');
    await context.close();
  });

  assert.deepEqual(errors, [], 'No uncaught browser errors');
  assert.deepEqual(externalRequests, [], 'Local execution must not request external resources');
  console.log(`All ${passed} EVA browser checks passed. Screenshots: ${screenshotDir}`);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); });
