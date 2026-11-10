/* No imports or network requests: this file also runs directly from file://. */
(() => {
  'use strict';

  const MINUTE = 60_000;
  const GAP_LIMIT = 3_000;
  const DEFAULTS = Object.freeze({
    showSeconds: true, showDday: true, targetDate: null,
    defaultMinutes: 25, presets: Object.freeze([10, 20, 25, 60]),
    pulseEnabled: true, soundEnabled: false, alertMode: 'ring', evaMode: false,
  });
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const validMinutes = value => Number.isInteger(value) && value >= 1 && value <= 180;

  function calendarDay(year, month, day) {
    // setUTCFullYear avoids Date.UTC's special handling of years 0–99.
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime() / 86_400_000;
  }

  function parseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const ordinal = calendarDay(year, month, day);
    const date = new Date(ordinal * 86_400_000);
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month &&
      date.getUTCDate() === day ? { year, month, day, ordinal } : null;
  }

  function dateInputValue(date) {
    return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function ddayLabel(target, now = new Date()) {
    const parsed = parseDate(target);
    if (!parsed) return 'D-—';
    const difference = parsed.ordinal - calendarDay(now.getFullYear(), now.getMonth() + 1, now.getDate());
    return difference === 0 ? 'D-DAY' : difference > 0 ? `D-${difference}` : `D+${-difference}`;
  }

  function formatTime(milliseconds) {
    const seconds = Math.ceil(Math.max(0, milliseconds) / 1_000);
    return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  }

  function formatPreciseTime(milliseconds) {
    const ms = Math.floor(Math.max(0, milliseconds));
    return `${pad(Math.floor(ms / MINUTE))}:${pad(Math.floor(ms / 1_000) % 60)}.${pad(ms % 1_000, 3)}`;
  }

  function cleanSettings(value) {
    const result = { ...DEFAULTS, presets: [...DEFAULTS.presets] };
    if (!value || value.version !== 1) return result;
    for (const key of ['showSeconds', 'showDday', 'pulseEnabled', 'soundEnabled', 'evaMode']) {
      if (typeof value[key] === 'boolean') result[key] = value[key];
    }
    if (['ring', 'screen'].includes(value.alertMode)) result.alertMode = value.alertMode;
    if (parseDate(value.targetDate)) result.targetDate = value.targetDate;
    if (validMinutes(value.defaultMinutes)) result.defaultMinutes = value.defaultMinutes;
    if (Array.isArray(value.presets) && value.presets.length === 4 && value.presets.every(validMinutes)) {
      result.presets = [...value.presets];
    }
    return result;
  }

  function interrupted(monotonicDelta, wallDelta) {
    return !Number.isFinite(monotonicDelta) || !Number.isFinite(wallDelta) ||
      monotonicDelta < 0 || monotonicDelta > GAP_LIMIT ||
      Math.abs(wallDelta - monotonicDelta) > GAP_LIMIT;
  }

  class Timer {
    constructor(defaultMinutes, snapshot) {
      this.state = 'idle';
      this.durationMs = defaultMinutes * MINUTE;
      this.remainingMs = this.durationMs;
      this.lastMono = 0;
      this.lastWall = 0;
      if (!snapshot || snapshot.version !== 1) return;
      const { state, durationMs, remainingMs } = snapshot;
      if (!['idle', 'running', 'paused', 'completed'].includes(state) ||
          !validMinutes(durationMs / MINUTE) || !Number.isFinite(remainingMs) ||
          remainingMs < 0 || remainingMs > durationMs ||
          (['running', 'paused'].includes(state) && remainingMs === 0)) return;
      this.durationMs = durationMs;
      this.state = state === 'running' ? 'paused' : state;
      this.remainingMs = state === 'idle' ? durationMs : state === 'completed' ? 0 : remainingMs;
    }

    start(monotonicNow, wallNow, minutes) {
      if (minutes !== undefined) {
        if (!validMinutes(minutes)) return;
        this.durationMs = minutes * MINUTE;
        this.remainingMs = this.durationMs;
      } else if (this.state === 'completed') {
        this.remainingMs = this.durationMs;
      }
      this.state = 'running';
      this.lastMono = monotonicNow;
      this.lastWall = wallNow;
    }

    sample(monotonicNow, wallNow) {
      if (this.state !== 'running') return null;
      const elapsed = monotonicNow - this.lastMono;
      const wallElapsed = wallNow - this.lastWall;
      this.lastMono = monotonicNow;
      this.lastWall = wallNow;
      // Detect suspension BEFORE subtracting time or deciding completion.
      if (interrupted(elapsed, wallElapsed)) {
        this.state = 'paused';
        return 'interrupted';
      }
      this.remainingMs = Math.max(0, this.remainingMs - elapsed);
      if (this.remainingMs === 0) {
        this.state = 'completed';
        return 'completed';
      }
      return null;
    }

    pause() { if (this.state === 'running') this.state = 'paused'; }
    reset() { this.state = 'idle'; this.remainingMs = this.durationMs; }
    get progress() { return Math.max(0, Math.min(1, this.remainingMs / this.durationMs)); }
    snapshot() {
      return { version: 1, state: this.state, durationMs: this.durationMs, remainingMs: this.remainingMs };
    }
  }

  // Pure logic can be tested with Node, without changing browser runtime dependencies.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Timer, cleanSettings, parseDate, calendarDay, dateInputValue, ddayLabel, formatTime, formatPreciseTime, interrupted };
  }
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries([
    'calendar', 'dday-row', 'dday', 'dday-editor', 'dday-date', 'dday-error',
    'clock-time', 'clock-seconds', 'timer-panel', 'timer-status', 'timer-remaining',
    'timer-total', 'ring-progress', 'ring-complete', 'toggle', 'reset', 'play-icon',
    'pause-icon', 'presets', 'settings-dialog', 'settings-form', 'storage-warning', 'announcement',
  ].map(id => [id, $(id)]));
  const SETTINGS_KEY = 'simple-clock.settings.v1';
  const TIMER_KEY = 'simple-clock.timer.v1';
  let storageFailed = false;

  function showStorageFailure() {
    storageFailed = true;
    ui['storage-warning'].hidden = false;
  }

  function readStorage(key) {
    let raw;
    try { raw = window.localStorage.getItem(key); }
    catch { showStorageFailure(); return null; }
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  function writeStorage(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); }
    catch { showStorageFailure(); }
  }

  let settings = cleanSettings(readStorage(SETTINGS_KEY));
  const timer = new Timer(settings.defaultMinutes, readStorage(TIMER_KEY));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let lastSave = performance.now();
  let lastLoopMono = lastSave;
  let lastLoopWall = Date.now();
  let pulseStarted = null;
  let audioContext = null;
  let announcedState = null;
  let evaFrame = null;
  let digitLayout = '';
  let digitCells = [];

  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  const saveTimer = () => { writeStorage(TIMER_KEY, timer.snapshot()); lastSave = performance.now(); };
  const saveSettings = () => writeStorage(SETTINGS_KEY, { version: 1, ...settings });

  // Long hexagonal bars keep the established tall proportions and tight pitch.
  // Reflect the right side to construct the left, preserving equal widths and
  // clear gaps between the pointed ends instead of clipping either side.
  const DIGIT_HEIGHT = 112;
  const DIGIT_WIDTH = 50;
  const UPPER_RIGHT = [[45, 6.5], [50, 11.5], [50, 49.5], [45, 54.5], [40, 49.5], [40, 11.5]];
  const LOWER_RIGHT = UPPER_RIGHT.map(([x, y]) => [x, DIGIT_HEIGHT - y]);
  const TOP_SEGMENT = [[6.5, 5], [11.5, 0], [38.5, 0], [43.5, 5], [38.5, 10], [11.5, 10]];
  const mirrorLeft = points => points.map(([x, y]) => [DIGIT_WIDTH - x, y]);
  const SEGMENTS = [
    TOP_SEGMENT, UPPER_RIGHT, LOWER_RIGHT,
    TOP_SEGMENT.map(([x, y]) => [x, DIGIT_HEIGHT - y]),
    mirrorLeft(LOWER_RIGHT), mirrorLeft(UPPER_RIGHT),
    TOP_SEGMENT.map(([x, y]) => [x, y + 51]),
  ].map(points => points.map(point => point.join(',')).join(' '));
  const DIGIT_SEGMENTS = ['012345', '12', '01346', '01236', '1256', '02356', '023456', '012', '0123456', '012356'];
  const svgNode = (name, attributes) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };

  function renderDigits(value) {
    const layout = value.replace(/\d/g, '#');
    if (layout !== digitLayout) {
      digitLayout = layout;
      digitCells = [];
      const nodes = [];
      let x = 0;
      let fractional = false;
      for (const character of layout) {
        if (character === '.') {
          nodes.push(svgNode('rect', { x, y: 104, width: 5, height: 8 }));
          x += 11;
          fractional = true;
        } else if (character === ':') {
          for (const y of [34, 75]) nodes.push(svgNode('rect', { x: x + 2, y, width: 5, height: 8 }));
          x += 12;
        } else {
          const scale = fractional ? .46 : 1;
          const group = svgNode('g', { transform: `translate(${x} ${DIGIT_HEIGHT * (1 - scale)}) scale(${scale}) matrix(1 0 -.07 1 8 0)` });
          const segments = SEGMENTS.map(points => svgNode('polygon', { points }));
          group.append(...segments);
          nodes.push(group);
          digitCells.push({ segments, value: null });
          x += fractional ? 28.5 : 62;
        }
      }
      $('eva-digits').replaceChildren(...nodes);
      $('eva-digits').setAttribute('viewBox', `-3 -3 ${x + 6} ${DIGIT_HEIGHT + 6}`);
    }
    [...value.replace(/\D/g, '')].forEach((digit, index) => {
      const cell = digitCells[index];
      if (cell.value === digit) return;
      cell.value = digit;
      cell.segments.forEach((segment, position) => segment.classList.toggle('lit', DIGIT_SEGMENTS[Number(digit)].includes(String(position))));
    });
  }

  function renderEvaTime() {
    if (!settings.evaMode) return;
    const precise = formatPreciseTime(timer.remainingMs);
    setText(ui['timer-remaining'], precise);
    renderDigits(precise);
  }

  function renderEvaPanels() {
    if (!settings.evaMode) return;
    const percent = `${Math.round(timer.progress * 100)}%`;
    document.querySelector('.dashboard').style.setProperty('--progress', timer.progress);
    document.querySelector('.dashboard').style.setProperty('--elapsed', 1 - timer.progress);
    $('eva-progress').style.setProperty('--progress', timer.progress);
    setText($('eva-percent'), percent);
    setText($('eva-session-total'), formatTime(timer.durationMs));
    setText($('eva-session-elapsed'), formatTime(timer.durationMs - timer.remainingMs));
    setText($('eva-session-percent'), percent);
    const states = { idle: 'STANDBY', running: 'ACTIVE', paused: 'HOLD', completed: 'LIMIT REACHED' };
    setText($('eva-magi-timer'), states[timer.state]);
    setText($('eva-magi-alert'), timer.state === 'completed' ? 'ALERT / LIMIT' : 'ALERT / READY');
    setText($('eva-monitor-state'), states[timer.state]);
  }

  function updateEvaLayout() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    document.documentElement.dataset.evaLayout = width < 600 || height / width >= 1.25 ? 'portrait'
      : width >= 1000 && height >= 650 ? 'wide' : 'medium';
  }

  function syncEvaAnimation() {
    if (!settings.evaMode || timer.state !== 'running' || document.hidden) {
      if (evaFrame !== null) cancelAnimationFrame(evaFrame);
      evaFrame = null;
    } else if (evaFrame === null) evaFrame = requestAnimationFrame(evaAnimation);
  }

  function evaAnimation() {
    evaFrame = null;
    if (!settings.evaMode || timer.state !== 'running' || document.hidden) return;
    // Both schedules feed the SAME engine. It detects a suspension before any
    // elapsed time is deducted, including the very first frame after a gap.
    const event = advanceTimer(performance.now(), Date.now());
    if (event) renderTimer();
    else renderEvaTime();
    syncEvaAnimation();
  }

  function renderClock() {
    const now = new Date();
    const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    setText(ui.calendar, `${pad(now.getFullYear(), 4)}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${weekdays[now.getDay()]}`);
    setText(ui['clock-time'], `${pad(now.getHours())}:${pad(now.getMinutes())}`);
    setText(ui['clock-seconds'], pad(now.getSeconds()));
    setText(ui.dday, ddayLabel(settings.targetDate, now));
  }

  function renderTimer() {
    const { state } = timer;
    ui['timer-panel'].dataset.state = state;
    document.documentElement.dataset.timerState = state;
    const statuses = settings.evaMode
      ? { idle: '待機 / STANDBY', running: '作動中 / ACTIVE', paused: '一時停止 / HOLD', completed: '活動停止 / LIMIT REACHED' }
      : { idle: 'READY', running: 'FOCUS', paused: 'PAUSED', completed: 'DONE' };
    setText(ui['timer-status'], statuses[state]);
    if (settings.evaMode) renderEvaTime();
    else setText(ui['timer-remaining'], formatTime(timer.remainingMs));
    ui['timer-remaining'].classList.toggle('long-time', timer.remainingMs > 99 * MINUTE + 59_000);
    setText(ui['timer-total'], `of ${formatTime(timer.durationMs)}`);
    // Positive offset retracts the end counterclockwise from 12 o'clock.
    ui['ring-progress'].style.strokeDashoffset = String(1 - timer.progress);
    const running = state === 'running';
    ui['play-icon'].toggleAttribute('hidden', running);
    ui['pause-icon'].toggleAttribute('hidden', !running);
    const labels = { idle: '시작', running: '일시정지', paused: '이어서 시작', completed: '같은 시간으로 다시 시작' };
    ui.toggle.setAttribute('aria-label', `타이머 ${labels[state]}`);
    ui.toggle.title = labels[state];
    ui.reset.disabled = state === 'idle';
    const hidePresets = running || state === 'paused';
    ui.presets.classList.toggle('is-hidden', hidePresets);
    ui.presets.setAttribute('aria-hidden', String(hidePresets));
    for (const button of ui.presets.children) button.disabled = hidePresets;
    $('eva-emergency').setAttribute('aria-hidden', String(!settings.evaMode || state !== 'completed'));
    renderEvaPanels();
    syncEvaAnimation();
    if (announcedState !== state) {
      const announcements = { idle: '타이머 준비', running: '타이머 시작', paused: '타이머 일시정지. 이어서 시작할 수 있습니다.', completed: '타이머가 완료되었습니다.' };
      setText(ui.announcement, announcements[state]);
      announcedState = state;
    }
  }

  function applySettings() {
    document.documentElement.classList.toggle('eva-mode', settings.evaMode);
    updateEvaLayout();
    ui['clock-seconds'].classList.toggle('seconds-hidden', !settings.showSeconds);
    ui['clock-seconds'].setAttribute('aria-hidden', String(!settings.showSeconds));
    ui['dday-row'].hidden = !settings.showDday;
    ui.presets.replaceChildren(...settings.presets.map(minutes => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset';
      button.textContent = minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`;
      button.setAttribute('aria-label', `${minutes}분 타이머 바로 시작`);
      button.addEventListener('click', () => startTimer(minutes));
      return button;
    }));
    if (!settings.pulseEnabled) stopPulse();
    renderAlertMode();
    renderClock();
    renderTimer();
    renderPulse(performance.now());
  }

  function prepareAudio() {
    if (!settings.soundEnabled || settings.evaMode) return;
    try {
      audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    } catch { /* Audio support is optional. */ }
  }

  function playCompletionSound() {
    if (!settings.soundEnabled || settings.evaMode || !audioContext || audioContext.state !== 'running') return;
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const now = audioContext.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(660, now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(.035, now + .035);
      gain.gain.exponentialRampToValueAtTime(.0001, now + .65);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + .7);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    } catch { /* The visible completion state must still work. */ }
  }

  function stopPulse() {
    const restoreFocus = document.activeElement === $('eva-alarm-dismiss');
    pulseStarted = null;
    $('eva-alarm-overlay').hidden = true;
    ui['ring-complete'].classList.remove('pulsing');
    ui['ring-complete'].style.removeProperty('animation-delay');
    document.documentElement.classList.remove('screen-pulsing', 'eva-alarm');
    document.documentElement.style.removeProperty('animation-delay');
    document.documentElement.style.removeProperty('--alarm-delay');
    if (restoreFocus) ui.toggle.focus({ preventScroll: true });
  }

  function renderAlertMode() {
    $('alert-mode').hidden = settings.evaMode;
    const screen = settings.alertMode === 'screen';
    $('alert-mode').setAttribute('aria-pressed', String(screen));
    $('alert-mode').dataset.enabled = String(settings.pulseEnabled);
    $('alert-mode').title = settings.pulseEnabled
      ? `${screen ? '화면' : '원형'} 알림 · 클릭하면 ${screen ? '원형' : '화면'} 알림`
      : `시각 알림 꺼짐 · 설정에서 켜세요. 선택 모드: ${screen ? '화면' : '원형'}`;
    $('alert-ring-icon').toggleAttribute('hidden', screen);
    $('alert-screen-icon').toggleAttribute('hidden', !screen);
  }

  function renderPulse(now) {
    if (pulseStarted === null) return;
    const elapsed = now - pulseStarted;
    if (!settings.pulseEnabled || reducedMotion.matches || elapsed >= 30_000) {
      stopPulse();
      return;
    }
    const root = document.documentElement;
    const ring = ui['ring-complete'];
    const className = settings.evaMode ? 'eva-alarm' : settings.alertMode === 'screen' ? 'screen-pulsing' : 'pulsing';
    const target = className === 'pulsing' ? ring : root;
    $('eva-alarm-overlay').hidden = className !== 'eva-alarm';
    for (const [element, effect] of [[root, 'eva-alarm'], [root, 'screen-pulsing'], [ring, 'pulsing']]) {
      if (effect !== className) element.classList.remove(effect);
      if (element !== target) element.style.removeProperty('animation-delay');
    }
    if (!target.classList.contains(className)) {
      // Changing modes preserves both the phase and the original 30-second deadline.
      target.style.animationDelay = `${-elapsed}ms`;
      root.style.setProperty('--alarm-delay', `${-elapsed}ms`);
      target.classList.add(className);
    }
  }

  function onCompleted(now) {
    if (settings.pulseEnabled && !reducedMotion.matches) {
      pulseStarted = now;
      renderPulse(now);
    }
    playCompletionSound();
  }

  function advanceTimer(mono, wall) {
    const event = timer.sample(mono, wall);
    if (event === 'completed') onCompleted(mono);
    if (event === 'interrupted') stopPulse();
    if (event || (timer.state === 'running' && mono - lastSave >= 1_000)) saveTimer();
    return event;
  }

  function tick() {
    const mono = performance.now();
    const wall = Date.now();
    const loopInterrupted = interrupted(mono - lastLoopMono, wall - lastLoopWall);
    lastLoopMono = mono;
    lastLoopWall = wall;
    if (pulseStarted !== null && (loopInterrupted || mono - pulseStarted >= 30_000)) stopPulse();
    advanceTimer(mono, wall);
    renderClock();
    renderTimer();
  }

  function startTimer(minutes) {
    closeTimerEditor(false);
    prepareAudio();
    stopPulse();
    timer.start(performance.now(), Date.now(), minutes);
    saveTimer();
    renderTimer();
    ui.toggle.focus({ preventScroll: true });
  }

  ui.toggle.addEventListener('click', () => {
    if (timer.state === 'running') {
      tick();
      timer.pause();
      saveTimer();
      renderTimer();
    } else startTimer();
  });
  ui.reset.addEventListener('click', () => {
    closeTimerEditor(false);
    stopPulse();
    timer.reset();
    saveTimer();
    renderTimer();
    ui.toggle.focus({ preventScroll: true });
  });
  $('eva-alarm-dismiss').addEventListener('click', stopPulse);
  document.addEventListener('keydown', event => {
    // Editors and the settings dialog retain their own Escape behavior.
    if (event.key !== 'Escape' || event.defaultPrevented || ui['settings-dialog'].open || $('eva-alarm-overlay').hidden) return;
    event.preventDefault();
    stopPulse();
  });
  ui['ring-complete'].addEventListener('animationend', event => {
    if (event.animationName === 'completion-pulse' && ui['ring-complete'].classList.contains('pulsing')) stopPulse();
  });
  document.documentElement.addEventListener('animationend', event => {
    if (event.target !== document.documentElement) return;
    const effect = { 'screen-completion-pulse': 'screen-pulsing', 'eva-completion-pulse': 'eva-alarm' }[event.animationName];
    if (effect && document.documentElement.classList.contains(effect)) stopPulse();
  });
  $('alert-mode').addEventListener('click', () => {
    tick();
    settings.alertMode = settings.alertMode === 'ring' ? 'screen' : 'ring';
    saveSettings();
    renderAlertMode();
    renderPulse(performance.now());
  });
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) stopPulse(); });

  function closeTimerEditor(restoreFocus = true) {
    $('timer-editor').hidden = true;
    $('timer-edit-open').hidden = false;
    if (restoreFocus) $('timer-edit-open').focus();
  }

  $('timer-edit-open').addEventListener('click', () => {
    if (!ui['dday-editor'].hidden) closeDateEditor(false);
    $('timer-minutes').value = timer.durationMs / MINUTE;
    $('timer-edit-open').hidden = true;
    $('timer-editor').hidden = false;
    $('timer-minutes').focus();
    $('timer-minutes').select();
  });
  $('timer-editor').addEventListener('submit', event => {
    event.preventDefault();
    const minutes = Number($('timer-minutes').value);
    if (!validMinutes(minutes)) return;
    stopPulse();
    timer.durationMs = minutes * MINUTE;
    timer.reset();
    saveTimer();
    closeTimerEditor();
    renderTimer();
  });
  $('timer-edit-cancel').addEventListener('click', () => closeTimerEditor());
  $('timer-editor').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeTimerEditor(); }
  });

  function openDateEditor() {
    closeTimerEditor(false);
    ui.dday.hidden = true;
    ui['dday-editor'].hidden = false;
    ui['dday-date'].value = settings.targetDate || dateInputValue(new Date());
    ui['dday-date'].setCustomValidity('');
    ui['dday-error'].textContent = '';
    ui['dday-date'].focus();
  }

  function closeDateEditor(restoreFocus = true) {
    ui['dday-editor'].hidden = true;
    ui.dday.hidden = false;
    if (restoreFocus) ui.dday.focus();
  }

  ui.dday.addEventListener('dblclick', openDateEditor);
  ui.dday.addEventListener('click', event => { if (event.detail === 0) openDateEditor(); });
  $('dday-cancel').addEventListener('click', () => closeDateEditor());
  ui['dday-date'].addEventListener('input', () => {
    ui['dday-date'].setCustomValidity('');
    ui['dday-error'].textContent = '';
  });
  ui['dday-editor'].addEventListener('submit', event => {
    event.preventDefault();
    if (!parseDate(ui['dday-date'].value)) {
      ui['dday-error'].textContent = '올바른 날짜를 입력해주세요.';
      return;
    }
    settings.targetDate = ui['dday-date'].value;
    saveSettings();
    closeDateEditor();
    renderClock();
  });
  ui['dday-editor'].addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeDateEditor(); }
  });

  const form = ui['settings-form'];
  const field = name => form.elements.namedItem(name);
  function renderSoundDraft() {
    field('soundEnabled').disabled = field('evaMode').checked;
    $('eva-sound-note').hidden = !field('evaMode').checked;
  }
  field('evaMode').addEventListener('change', renderSoundDraft);
  $('settings-open').addEventListener('click', () => {
    closeTimerEditor(false);
    if (!ui['dday-editor'].hidden) closeDateEditor(false);
    for (const key of ['showSeconds', 'showDday', 'pulseEnabled', 'soundEnabled', 'evaMode']) field(key).checked = settings[key];
    renderSoundDraft();
    field('targetDate').value = settings.targetDate || '';
    field('targetDate').setCustomValidity('');
    field('defaultMinutes').value = settings.defaultMinutes;
    settings.presets.forEach((minutes, index) => { field(`preset${index}`).value = minutes; });
    ui['storage-warning'].hidden = !storageFailed;
    ui['settings-dialog'].showModal();
  });
  const closeSettings = () => { ui['settings-dialog'].close(); $('settings-open').focus(); };
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  ui['settings-dialog'].addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
  ui['settings-dialog'].addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...form.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  $('clear-date').addEventListener('click', () => { field('targetDate').value = ''; field('targetDate').setCustomValidity(''); });
  field('targetDate').addEventListener('input', () => field('targetDate').setCustomValidity(''));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const targetDate = field('targetDate').value || null;
    if (targetDate && !parseDate(targetDate)) {
      field('targetDate').setCustomValidity('올바른 날짜를 입력해주세요.');
      field('targetDate').reportValidity();
      return;
    }
    const defaultMinutes = Number(field('defaultMinutes').value);
    const presets = Array.from({ length: 4 }, (_, index) => Number(field(`preset${index}`).value));
    if (!validMinutes(defaultMinutes) || !presets.every(validMinutes)) return;
    tick();
    const oldDefault = settings.defaultMinutes;
    settings = { ...settings, targetDate, defaultMinutes, presets };
    for (const key of ['showSeconds', 'showDday', 'pulseEnabled', 'soundEnabled', 'evaMode']) settings[key] = field(key).checked;
    if (timer.state === 'idle' && oldDefault !== defaultMinutes) {
      timer.durationMs = defaultMinutes * MINUTE;
      timer.reset();
      saveTimer();
    }
    saveSettings();
    prepareAudio();
    applySettings();
    closeSettings();
  });

  function suspend() {
    tick();
    timer.pause();
    stopPulse();
    saveTimer();
    renderTimer();
  }
  document.addEventListener('visibilitychange', () => { tick(); saveTimer(); });
  document.addEventListener('freeze', suspend);
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', tick);
  window.addEventListener('focus', tick);
  window.addEventListener('resize', updateEvaLayout);

  applySettings();
  saveTimer(); // Persist the paused restoration; never auto-resume a saved run.
  setInterval(tick, 250);
})();
