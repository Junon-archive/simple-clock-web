const test = require('node:test');
const assert = require('node:assert/strict');
const { Timer, cleanSettings, parseDate, ddayLabel, formatTime, formatPreciseTime, interrupted } = require('../app.js');

test('every duration begins as a full circle, with accurate elapsed time', () => {
  for (const minutes of [1, 10, 20, 25, 30, 60, 180]) {
    const timer = new Timer(minutes);
    timer.start(0, 0);
    assert.equal(timer.progress, 1);
    for (let time = 1_000; time <= minutes * 30_000; time += 1_000) timer.sample(time, time);
    assert.equal(timer.progress, .5);
  }
});

test('pause and resume retain the original denominator', () => {
  const timer = new Timer(30);
  timer.start(0, 0);
  timer.sample(1_250, 1_250);
  timer.pause();
  timer.sample(50_000, 50_000);
  assert.equal(timer.remainingMs, 1_798_750);
  timer.start(100_000, 100_000);
  timer.sample(101_000, 101_000);
  assert.equal(timer.durationMs, 1_800_000);
  assert.equal(timer.remainingMs, 1_797_750);
  timer.reset();
  assert.equal(timer.state, 'idle');
  assert.equal(timer.progress, 1);
});

test('completion happens once, never becomes negative, and can restart', () => {
  const timer = new Timer(1, { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 500 });
  timer.start(0, 0);
  assert.equal(timer.sample(750, 750), 'completed');
  assert.equal(timer.remainingMs, 0);
  assert.equal(timer.progress, 0);
  assert.equal(timer.sample(1_000, 1_000), null);
  timer.start(2_000, 2_000);
  assert.equal(timer.remainingMs, 60_000);
});

test('suspension is detected BEFORE time subtraction and completion', () => {
  for (const [mono, wall] of [[60_000, 60_000], [250, 60_000], [250, -60_000]]) {
    const timer = new Timer(1, { version: 1, state: 'paused', durationMs: 60_000, remainingMs: 500 });
    timer.start(0, 0);
    assert.equal(timer.sample(mono, wall), 'interrupted');
    assert.equal(timer.remainingMs, 500);
    assert.equal(timer.state, 'paused');
  }
});

test('small callback delays use elapsed milliseconds rather than callback count', () => {
  const timer = new Timer(1);
  timer.start(0, 0);
  timer.sample(1_333, 1_333);
  timer.sample(2_500, 2_500);
  assert.equal(timer.remainingMs, 57_500);
  assert.equal(interrupted(3_000, 3_000), false);
  assert.equal(interrupted(3_001, 3_001), true);
});

test('running snapshots restore as paused; closed time is never consumed', () => {
  const timer = new Timer(30);
  timer.start(0, 0);
  timer.sample(1_234, 1_234);
  const restored = new Timer(25, timer.snapshot());
  assert.equal(restored.state, 'paused');
  restored.sample(86_400_000, 86_400_000);
  assert.equal(restored.remainingMs, timer.remainingMs);
  assert.equal(restored.durationMs, timer.durationMs);
});

test('corrupt and inconsistent timer data falls back safely', () => {
  for (const bad of [null, {}, { version: 2 }, { version: 1, state: 'alien' },
    { version: 1, state: 'running', durationMs: 60_000, remainingMs: -1 },
    { version: 1, state: 'paused', durationMs: 60_000, remainingMs: NaN },
    { version: 1, state: 'running', durationMs: 60_000, remainingMs: 0 },
    { version: 1, state: 'idle', durationMs: Infinity, remainingMs: 5 }]) {
    const timer = new Timer(25, bad);
    assert.equal(timer.state, 'idle');
    assert.equal(timer.remainingMs, 25 * 60_000);
  }
});

test('formatting rounds upward and supports hours as minutes', () => {
  assert.equal(formatTime(1), '00:01');
  assert.equal(formatTime(59_001), '01:00');
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(-1), '00:00');
  assert.equal(formatTime(10_800_000), '180:00');
});

test('EVA milliseconds use the real remainder, including fractional samples and long durations', () => {
  for (const [value, expected] of [[0, '00:00.000'], [-12, '00:00.000'], [1, '00:00.001'],
    [59_999.9, '00:59.999'], [60_000, '01:00.000'], [10_800_000, '180:00.000']]) {
    assert.equal(formatPreciseTime(value), expected);
  }
  const timer = new Timer(1);
  timer.start(0, 0);
  for (let ms = 16; ms <= 1_000; ms += 16) timer.sample(ms, ms);
  timer.sample(1_000, 1_000); // heartbeat and RAF share the same monotonic timeline
  assert.equal(timer.remainingMs, 59_000);
  assert.equal(formatPreciseTime(timer.remainingMs), '00:59.000');
});

test('EVA setting migration preserves ordinary sound and alert choices', () => {
  for (const value of [undefined, 'true', 1, null]) assert.equal(cleanSettings({ version: 1, evaMode: value }).evaMode, false);
  const settings = cleanSettings({ version: 1, evaMode: true, soundEnabled: true, alertMode: 'screen' });
  assert.equal(settings.evaMode, true);
  assert.equal(settings.soundEnabled, true);
  assert.equal(settings.alertMode, 'screen');
});

test('D-day handles leap days, year boundaries and empty input', () => {
  assert.equal(ddayLabel(null), 'D-—');
  assert.equal(ddayLabel('2026-11-23', new Date(2026, 10, 9, 23, 59)), 'D-14');
  assert.equal(ddayLabel('2026-11-09', new Date(2026, 10, 9)), 'D-DAY');
  assert.equal(ddayLabel('2026-11-08', new Date(2026, 10, 9)), 'D+1');
  assert.equal(ddayLabel('2027-01-01', new Date(2026, 11, 31)), 'D-1');
  assert.equal(ddayLabel('2028-03-01', new Date(2028, 1, 28)), 'D-2');
  assert.ok(parseDate('2028-02-29'));
  assert.ok(parseDate('0001-01-01'));
  for (const bad of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-13-01', '2026-1-1']) assert.equal(parseDate(bad), null);
});

test('D-day counts calendar dates across daylight-saving transitions', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    assert.equal(ddayLabel('2026-03-09', new Date(2026, 2, 7, 23)), 'D-2');
    assert.equal(ddayLabel('2026-11-02', new Date(2026, 9, 31, 23)), 'D-2');
  } finally { if (previous) process.env.TZ = previous; else delete process.env.TZ; }
});

test('settings validation preserves valid values and rejects unsafe times', () => {
  const settings = cleanSettings({ version: 1, showSeconds: false, defaultMinutes: 0, presets: [1, 2, 3, 181], targetDate: '2026-02-30' });
  assert.equal(settings.showSeconds, false);
  assert.equal(settings.defaultMinutes, 25);
  assert.deepEqual(settings.presets, [10, 20, 25, 60]);
  assert.equal(settings.targetDate, null);
  assert.deepEqual(cleanSettings({ version: 1, presets: [30, 30, 90, 180] }).presets, [30, 30, 90, 180]);
});

test('alert mode defaults safely for old data and preserves the visual-alert master switch', () => {
  assert.equal(cleanSettings({ version: 1 }).alertMode, 'ring');
  assert.equal(cleanSettings({ version: 1, alertMode: 'unexpected' }).alertMode, 'ring');
  const settings = cleanSettings({ version: 1, alertMode: 'screen', pulseEnabled: false });
  assert.equal(settings.alertMode, 'screen');
  assert.equal(settings.pulseEnabled, false);
});
