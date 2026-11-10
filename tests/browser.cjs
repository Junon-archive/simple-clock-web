/* Dev-only: NODE_PATH=/path/to/node_modules node tests/browser.cjs
   Optional BROWSER_PATH and SCREENSHOT_DIR environment variables. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const url = pathToFileURL(path.resolve(__dirname, '../index.html')).href;
const screenshotDir = process.env.SCREENSHOT_DIR || '/tmp/simple-clock-screenshots';
const errors = [];
const externalRequests = [];
const settingsKey = 'simple-clock.settings.v1';
const timerKey = 'simple-clock.timer.v1';
let browser;
let passed = 0;

async function fixture(seed = {}, extra = {}) {
  const context = await browser.newContext({ viewport: { width: 480, height: 800 }, timezoneId: 'Asia/Seoul', ...extra });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.addInitScript(({ seed, settingsKey, timerKey }) => {
    if (sessionStorage.getItem('qa-initialized')) return;
    localStorage.clear();
    if (seed.settings) localStorage.setItem(settingsKey, JSON.stringify(seed.settings));
    if (seed.timer) localStorage.setItem(timerKey, JSON.stringify(seed.timer));
    if (seed.corrupt) { localStorage.setItem(settingsKey, '{'); localStorage.setItem(timerKey, 'null'); }
    sessionStorage.setItem('qa-initialized', '1');
  }, { seed, settingsKey, timerKey });
  await page.clock.install({ time: new Date('2026-11-09T14:32:08+09:00') });
  await page.clock.pauseAt(new Date('2026-11-09T14:32:09+09:00'));
  await page.goto(url);
  return { context, page };
}

async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const state = page => page.locator('#timer-panel').getAttribute('data-state');
const remaining = page => page.locator('#timer-remaining').textContent();
const openSettings = page => page.locator('#settings-open').click();
const saveSettings = page => page.locator('#settings-form button[type="submit"]').click();

(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  console.log(`Browser: ${await browser.version()}`);
  await fs.mkdir(screenshotDir, { recursive: true });

  await check('file:// offline; five viewport layouts and settings modal', async () => {
    const { page, context } = await fixture();
    await context.setOffline(true);
    await page.reload();
    for (const [width, height] of [[320, 600], [480, 800], [640, 720], [800, 480], [1122, 1402]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => {
        const rect = id => document.getElementById(id).getBoundingClientRect().toJSON();
        return { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight,
          clock: rect('clock-time'), face: rect('timer-face'), settings: rect('settings-open'), presets: rect('presets') };
      });
      assert.ok(layout.w <= width, `horizontal overflow ${width}`);
      assert.ok(layout.h <= height, `vertical overflow ${width}x${height}: ${layout.h}`);
      assert.ok(Math.abs(layout.face.width - layout.face.height) < 1);
      assert.ok(layout.clock.bottom < layout.face.top);
      assert.ok(layout.presets.bottom <= layout.settings.top);
      assert.ok(layout.settings.bottom <= height);
      await page.screenshot({ path: path.join(screenshotDir, `${width}x${height}.png`) });
      await openSettings(page);
      const bounds = await page.locator('.dialog-actions').boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height);
      await page.screenshot({ path: path.join(screenshotDir, `settings-${width}x${height}.png`) });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#settings-open').evaluate(e => e === document.activeElement), true);
    }
    await page.setViewportSize({ width: 280, height: 400 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await openSettings(page);
    await page.locator('input[name="soundEnabled"]').check();
    await saveSettings(page);
    await context.close();
  });

  await check('clock settings persist; seconds do not shift main clock; presets validate', async () => {
    const { page, context } = await fixture();
    const before = await page.locator('#clock-time').boundingBox();
    await openSettings(page);
    await page.locator('[name="showSeconds"]').uncheck();
    await page.locator('[name="preset0"]').fill('30');
    await page.locator('[name="defaultMinutes"]').fill('180');
    await saveSettings(page);
    assert.equal(await page.locator('#clock-seconds').isVisible(), false);
    assert.deepEqual(await page.locator('#clock-time').boundingBox(), before);
    assert.equal(await remaining(page), '180:00');
    await page.reload();
    assert.equal(await page.locator('#clock-seconds').isVisible(), false);
    assert.equal(await page.locator('.preset').first().textContent(), '30분');
    await openSettings(page);
    await page.locator('[name="preset0"]').fill('0');
    await saveSettings(page);
    assert.equal(await page.locator('#settings-dialog').isVisible(), true);
    await page.locator('#settings-cancel').click();
    assert.equal(await page.locator('.preset').first().textContent(), '30분');
    await context.close();
  });

  await check('D-day inline editing, Enter/Escape, target date persistence and deletion', async () => {
    const { page, context } = await fixture();
    assert.equal(await page.locator('#dday').textContent(), 'D-—');
    await page.locator('#dday').dblclick();
    await page.locator('#dday-date').fill('2026-11-23');
    await page.locator('#dday-date').press('Enter');
    assert.equal(await page.locator('#dday').textContent(), 'D-14');
    await page.reload();
    assert.equal(await page.locator('#dday').textContent(), 'D-14');
    await page.locator('#dday').focus();
    await page.keyboard.press('Enter');
    await page.locator('#dday-date').fill('2026-11-09');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#dday').textContent(), 'D-14');
    await openSettings(page);
    await page.locator('#clear-date').click();
    await saveSettings(page);
    assert.equal(await page.locator('#dday').textContent(), 'D-—');
    await context.close();
  });

  await check('all presets start directly; pause/resume/reset and ring fraction', async () => {
    const { page, context } = await fixture();
    for (const [index, text] of ['10:00', '20:00', '25:00', '60:00'].entries()) {
      await page.locator('.preset').nth(index).click();
      assert.equal(await state(page), 'running');
      assert.equal(await remaining(page), text);
      assert.equal(await page.locator('#ring-progress').evaluate(e => e.style.strokeDashoffset), '0');
      assert.equal(await page.locator('#pause-icon').isVisible(), true);
      assert.equal(await page.locator('#play-icon').isVisible(), false);
      await page.locator('#reset').click();
    }
    await page.locator('.preset').first().click();
    await page.clock.runFor(2_000);
    assert.equal(await remaining(page), '09:58');
    await page.locator('#toggle').click();
    await page.clock.runFor(10_000);
    assert.equal(await remaining(page), '09:58');
    await page.locator('#toggle').click();
    await page.clock.runFor(1_000);
    assert.equal(await remaining(page), '09:57');
    assert.equal(await page.locator('#timer-total').textContent(), 'of 10:00');
    await context.close();
  });

  await check('refresh and actual close/reopen restore remaining time as paused', async () => {
    const { page, context } = await fixture();
    await page.locator('.preset').first().click();
    await page.clock.runFor(5_000);
    await page.reload();
    assert.equal(await state(page), 'paused');
    assert.equal(await remaining(page), '09:55');
    await page.locator('#toggle').click();
    await page.clock.runFor(1_000);
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(url);
    assert.equal(await state(reopened), 'paused');
    assert.equal(await remaining(reopened), '09:54');
    await context.close();
  });

  await check('long execution gap pauses before completion; focus loss alone does not pause', async () => {
    const { page, context } = await fixture({ timer: { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 2_000 } });
    await page.locator('#toggle').click();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await state(page), 'running');
    await page.clock.fastForward(60_000);
    assert.equal(await state(page), 'paused');
    assert.equal(await remaining(page), '00:02');
    await context.close();
  });

  await check('completion pulse lasts 30s, is confined to the ring, and does not replay', async () => {
    const { page, context } = await fixture({ timer: { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 1_000 } });
    await page.locator('#toggle').click();
    await page.clock.runFor(1_000);
    assert.equal(await state(page), 'completed');
    assert.equal(await remaining(page), '00:00');
    assert.equal(await page.locator('#ring-complete').evaluate(e => e.classList.contains('pulsing')), true);
    const animated = await page.evaluate(() => document.getAnimations().map(a => a.effect.target.id));
    assert.deepEqual(animated, ['ring-complete']);
    await page.clock.runFor(29_000);
    assert.equal(await page.locator('#ring-complete').evaluate(e => e.classList.contains('pulsing')), true);
    await page.clock.runFor(1_000);
    assert.equal(await page.locator('#ring-complete').evaluate(e => e.classList.contains('pulsing')), false);
    assert.equal(await state(page), 'completed');
    await page.reload();
    assert.equal(await state(page), 'completed');
    assert.equal(await page.locator('#ring-complete').evaluate(e => e.classList.contains('pulsing')), false);
    await context.close();
  });

  await check('completion effect stops on new start, reset and settings disable', async () => {
    for (const action of ['start', 'reset', 'disable']) {
      const { page, context } = await fixture({ timer: { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 250 } });
      await page.locator('#toggle').click();
      await page.clock.runFor(250);
      if (action === 'start') await page.locator('.preset').first().click();
      else if (action === 'reset') await page.locator('#reset').click();
      else {
        await openSettings(page);
        await page.locator('[name="pulseEnabled"]').uncheck();
        await saveSettings(page);
      }
      assert.equal(await page.locator('#ring-complete').evaluate(e => e.classList.contains('pulsing')), false);
      await context.close();
    }
  });

  await check('reduced motion skips pulse; settings do not change a running timer', async () => {
    const { page, context } = await fixture({ timer: { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 1_000 } }, { reducedMotion: 'reduce' });
    await page.locator('#toggle').click();
    await openSettings(page);
    await page.locator('[name="defaultMinutes"]').fill('45');
    await saveSettings(page);
    assert.equal(await page.locator('#timer-total').textContent(), 'of 01:00');
    await page.clock.runFor(1_000);
    assert.equal(await state(page), 'completed');
    assert.equal(await page.locator('#ring-complete').evaluate(e => e.classList.contains('pulsing')), false);
    await context.close();
  });

  await check('corrupt storage and rejected storage access leave the app usable', async () => {
    const { page, context } = await fixture({ corrupt: true });
    assert.equal(await remaining(page), '25:00');
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
    await page.reload();
    await openSettings(page);
    assert.equal(await page.locator('#storage-warning').isVisible(), true);
    await page.locator('[name="defaultMinutes"]').fill('20');
    await saveSettings(page);
    assert.equal(await remaining(page), '20:00');
    await page.locator('#toggle').click();
    assert.equal(await state(page), 'running');
    await context.close();
  });

  await check('local date and D-day update across midnight; system clock jumps pause running timers', async () => {
    const { page, context } = await fixture({ settings: { version: 1, targetDate: '2026-11-10' } });
    await page.clock.setSystemTime(new Date('2026-11-09T23:59:59+09:00'));
    await page.clock.runFor(250);
    assert.equal(await page.locator('#dday').textContent(), 'D-1');
    await page.clock.runFor(1_000);
    assert.equal(await page.locator('#calendar').textContent(), '2026.11.10 TUE');
    assert.equal(await page.locator('#clock-time').textContent(), '00:00');
    assert.equal(await page.locator('#dday').textContent(), 'D-DAY');
    await page.locator('#toggle').click();
    await page.clock.setSystemTime(new Date('2026-11-10T02:00:00+09:00'));
    await page.clock.runFor(250);
    assert.equal(await state(page), 'paused');
    assert.equal(await remaining(page), '25:00');
    await context.close();
  });

  await check('keyboard focus stays in settings; repeated actions and resizing preserve a run', async () => {
    const { page, context } = await fixture();
    await page.locator('.preset').first().focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#toggle').evaluate(e => e === document.activeElement), true);
    for (let i = 0; i < 6; i++) await page.locator('#toggle').click();
    assert.equal(await state(page), 'running');
    for (let i = 0; i < 3; i++) {
      await openSettings(page);
      for (let tab = 0; tab < 20; tab++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('#settings-dialog')), true);
      }
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 320, height: 600 });
    await page.clock.runFor(1_000);
    assert.equal(await remaining(page), '09:59');
    await context.close();
  });

  await check('inline timer editing validates, saves, cancels and resets every timer state', async () => {
    for (const originalState of ['idle', 'running', 'paused', 'completed']) {
      const { page, context } = await fixture({ timer: {
        version: 1, state: originalState, durationMs: 20 * 60_000,
        remainingMs: originalState === 'completed' ? 0 : 15 * 60_000,
      } });
      if (originalState === 'running') await page.locator('#toggle').click();
      await page.locator('#timer-edit-open').click();
      assert.equal(await page.locator('#timer-minutes').inputValue(), '20');
      await page.locator('#timer-minutes').fill('35');
      await page.keyboard.press('Escape');
      assert.equal(await state(page), originalState);
      assert.equal(await page.locator('#timer-total').textContent(), 'of 20:00');
      await page.locator('#timer-edit-open').focus();
      await page.keyboard.press('Enter');
      for (const invalid of ['0', '181', '1.5', '']) {
        await page.locator('#timer-minutes').fill(invalid);
        await page.locator('#timer-editor button[type="submit"]').click();
        assert.equal(await page.locator('#timer-editor').isVisible(), true);
        assert.equal(await state(page), originalState);
      }
      await page.locator('#timer-minutes').fill('35');
      await page.locator('#timer-minutes').press('Enter');
      assert.equal(await state(page), 'idle');
      assert.equal(await remaining(page), '35:00');
      assert.equal(await page.locator('#ring-progress').evaluate(e => e.style.strokeDashoffset), '0');
      await page.reload();
      assert.equal(await remaining(page), '35:00');
      await page.locator('#toggle').click();
      await page.clock.runFor(1_000);
      assert.equal(await remaining(page), '34:59');
      await page.locator('#timer-edit-open').click();
      await page.clock.runFor(1_000);
      await page.locator('#timer-edit-cancel').click();
      assert.equal(await remaining(page), '34:58');
      await context.close();
    }
  });

  await check('inline timer editor fits small viewports and new starts discard its draft', async () => {
    const { page, context } = await fixture({ timer: { version: 1, state: 'paused', durationMs: 20 * 60_000, remainingMs: 15 * 60_000 } });
    await page.screenshot({ path: path.join(screenshotDir, 'counterclockwise-quarter.png') });
    for (const [width, height] of [[320, 600], [800, 480], [280, 400]]) {
      await page.setViewportSize({ width, height });
      await page.locator('#timer-edit-open').click();
      const ring = await page.locator('#timer-face').boundingBox();
      const editor = await page.locator('#timer-editor').boundingBox();
      assert.ok(editor.x >= ring.x && editor.y >= ring.y);
      assert.ok(editor.x + editor.width <= ring.x + ring.width + 1);
      assert.ok(editor.y + editor.height <= ring.y + ring.height + 1);
      await page.screenshot({ path: path.join(screenshotDir, `timer-editor-${width}x${height}.png`) });
      await page.locator('#timer-minutes').fill('35');
      await page.locator('#reset').click();
      assert.equal(await page.locator('#timer-editor').isVisible(), false);
      assert.equal(await remaining(page), '20:00');
      await page.locator('#timer-edit-open').click();
      await page.locator('.preset').first().click();
      assert.equal(await page.locator('#timer-editor').isVisible(), false);
      assert.equal(await remaining(page), '10:00');
      await page.locator('#reset').click();
      await page.locator('#timer-edit-open').click();
      await page.locator('#timer-minutes').fill('20');
      await page.locator('#timer-minutes').press('Enter');
      await page.locator('#toggle').click();
    }
    await context.close();
  });

  await check('alert toggle persists, supports the keyboard and does not change a running timer', async () => {
    const { page, context } = await fixture();
    const mode = page.locator('#alert-mode');
    assert.equal(await mode.getAttribute('aria-pressed'), 'false');
    await mode.focus();
    await page.keyboard.press('Enter');
    assert.equal(await mode.getAttribute('aria-pressed'), 'true');
    await page.reload();
    assert.equal(await mode.getAttribute('aria-pressed'), 'true');
    await page.locator('#toggle').click();
    await page.clock.runFor(1_000);
    await mode.click();
    assert.equal(await state(page), 'running');
    assert.equal(await remaining(page), '24:59');
    assert.equal(await page.locator('#timer-total').textContent(), 'of 25:00');
    for (const [width, height] of [[320, 600], [800, 480]]) {
      await page.setViewportSize({ width, height });
      const control = await page.locator('#toggle').boundingBox();
      const toggle = await mode.boundingBox();
      assert.ok(toggle.x >= control.x + control.width);
      assert.ok(toggle.width >= 32 && toggle.height >= 32);
      assert.ok(Math.abs(control.x + control.width / 2 - width / 2) < 1);
      await mode.click();
      await page.screenshot({ path: path.join(screenshotDir, `alert-toggle-${width}x${height}.png`) });
    }
    await context.close();
  });

  await check('screen completion changes only the background and returns to black after 30 seconds', async () => {
    const { page, context } = await fixture({
      settings: { version: 1, alertMode: 'screen' },
      timer: { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 250 },
    });
    const textColor = await page.locator('#timer-remaining').evaluate(e => getComputedStyle(e).color);
    await page.locator('#toggle').click();
    await page.clock.runFor(250);
    assert.equal(await page.locator('html').evaluate(e => e.classList.contains('screen-pulsing')), true);
    assert.equal(await page.locator('#ring-complete').evaluate(e => e.classList.contains('pulsing')), false);
    const animation = await page.evaluate(() => {
      const animations = document.getAnimations();
      const background = animations.find(a => a.effect.target === document.documentElement);
      background.pause();
      background.currentTime = 500;
      return { targets: animations.map(a => a.effect.target.tagName), color: getComputedStyle(document.documentElement).backgroundColor };
    });
    assert.deepEqual(animation.targets, ['HTML']);
    assert.equal(animation.color, 'rgb(100, 42, 46)');
    assert.equal(await page.locator('#timer-remaining').evaluate(e => getComputedStyle(e).color), textColor);
    await page.screenshot({ path: path.join(screenshotDir, 'screen-alert-peak.png') });
    await page.clock.runFor(29_000);
    assert.equal(await page.locator('html').evaluate(e => e.classList.contains('screen-pulsing')), true);
    await page.clock.runFor(1_000);
    assert.equal(await page.locator('html').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(13, 12, 15)');
    assert.equal(await state(page), 'completed');
    await page.locator('#alert-mode').click();
    await page.locator('#alert-mode').click();
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await page.reload();
    assert.equal(await page.locator('#alert-mode').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await context.close();
  });

  await check('switching completion modes keeps the original 30-second deadline in either direction', async () => {
    for (const alertMode of ['ring', 'screen']) {
      const { page, context } = await fixture({
        settings: { version: 1, alertMode },
        timer: { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 250 },
      });
      await page.locator('#toggle').click();
      await page.clock.runFor(20_250);
      await page.locator('#alert-mode').click();
      const target = page.locator(alertMode === 'ring' ? 'html' : '#ring-complete');
      assert.equal(await target.evaluate(e => e.style.animationDelay), '-20000ms');
      assert.equal(await page.evaluate(() => document.getAnimations().length), 1);
      await page.clock.runFor(9_000);
      assert.equal(await page.evaluate(() => document.getAnimations().length), 1);
      await page.clock.runFor(1_000);
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
      assert.equal(await page.locator('html').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(13, 12, 15)');
      await context.close();
    }
  });

  await check('screen alert stops on all reset paths and never bypasses disabled or reduced-motion settings', async () => {
    for (const action of ['start', 'reset', 'edit', 'disable', 'reduce', 'gap', 'reload']) {
      const { page, context } = await fixture({
        settings: { version: 1, alertMode: 'screen' },
        timer: { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 250 },
      });
      await page.locator('#toggle').click();
      await page.clock.runFor(250);
      if (action === 'start') await page.locator('.preset').first().click();
      if (action === 'reset') await page.locator('#reset').click();
      if (action === 'edit') {
        await page.locator('#timer-edit-open').click();
        await page.locator('#timer-minutes').fill('15');
        await page.locator('#timer-minutes').press('Enter');
      }
      if (action === 'disable') {
        await openSettings(page);
        await page.locator('[name="pulseEnabled"]').uncheck();
        await saveSettings(page);
        await page.locator('#alert-mode').click();
        assert.equal(await page.locator('#alert-mode').getAttribute('data-enabled'), 'false');
        await openSettings(page);
        await page.locator('[name="pulseEnabled"]').check();
        await saveSettings(page);
      }
      if (action === 'reduce') { await page.emulateMedia({ reducedMotion: 'reduce' }); await page.clock.runFor(250); }
      if (action === 'gap') await page.clock.fastForward(60_000);
      if (action === 'reload') await page.reload();
      await page.waitForFunction(() => !document.documentElement.classList.contains('screen-pulsing'));
      assert.equal(await page.locator('html').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(13, 12, 15)');
      assert.equal(await page.locator('#ring-complete').evaluate(e => e.classList.contains('pulsing')), false);
      await context.close();
    }
    for (const disabled of ['reduce', 'off']) {
      const { page, context } = await fixture({
        settings: { version: 1, alertMode: 'screen', pulseEnabled: disabled !== 'off' },
        timer: { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 250 },
      }, disabled === 'reduce' ? { reducedMotion: 'reduce' } : {});
      await page.locator('#toggle').click();
      await page.clock.runFor(250);
      await page.locator('#alert-mode').click();
      await page.locator('#alert-mode').click();
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
      await context.close();
    }
  });

  assert.deepEqual(errors, [], 'uncaught browser errors');
  assert.deepEqual(externalRequests, [], 'unexpected network dependencies');
  console.log(`${passed} browser checks passed; no uncaught errors or external requests. Screenshots: ${screenshotDir}`);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); });
