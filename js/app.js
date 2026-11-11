/**
 * StudyFlow – app.js
 * Student planner & task manager PWA.
 * Screens are rendered from plain template strings into <main>; one delegated listener per
 * event type handles every interaction (fast, low memory, no framework needed).
 */
import * as core from './js/core.js';
import * as vaultCrypto from './js/crypto.js';
import * as db from './js/store.js';
import * as api from './js/api.js';
import { icon } from './js/icons.js';

const APP_VERSION = '1.0.0';
const DEFAULT_PLACE = { name: 'Dundee', detail: 'Scotland (default)', lat: 56.46, lon: -2.97, source: 'default' };
const RING_C = 2 * Math.PI * 45; // circumference of r=45 progress rings

/* =================================================================== state */
const S = {
  vault: null,      // encrypted record as stored in IndexedDB
  key: null,        // AES-GCM CryptoKey (memory only, cleared on lock)
  state: null,      // decrypted app data (memory only)
  ui: { view: 'all', moduleId: '', query: '', sort: 'due', weekOf: null, focusTask: '' },
  weather: { status: 'idle', error: '' },
  holidayStatus: 'idle',
  timer: null,
  wakeLock: null,
  installPrompt: null,
  photoUrls: new Map(),
  lastActive: Date.now(),
  hiddenAt: null,
  stack: [],
  saving: Promise.resolve(),
  afterUnlock: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = core.escapeHtml;
const today = () => core.toISODate(new Date());
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : '');
const main = () => $('#main');
const moduleById = id => S.state?.modules.find(m => m.id === id);
const taskById = id => S.state?.tasks.find(t => t.id === id);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* =========================================================== persistence */
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250); // debounce bursts of edits into one encrypted write
}
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!S.key || !S.state) return S.saving;
  const key = S.key, snapshot = S.state;
  S.saving = S.saving.then(async () => {
    S.vault = await vaultCrypto.sealVault(key, S.vault, snapshot);
    await db.put('kv', 'vault', S.vault);
  }).catch(err => { console.error('[save]', err); toast('Could not save – device storage may be full.'); });
  updateBadge();
  return S.saving;
}

function mirrorPrefs() {
  const s = S.state.settings;
  try { localStorage.setItem('sf_prefs', JSON.stringify({ textScale: s.textScale, theme: s.theme, contrast: s.contrast, reduceMotion: s.reduceMotion })); } catch { /* ignore */ }
}
function applyPrefs(s) {
  const root = document.documentElement;
  root.style.fontSize = `${(s.textScale || 1) * 100}%`;
  root.dataset.theme = s.theme || 'system';
  root.classList.toggle('high-contrast', !!s.contrast);
  root.classList.toggle('reduce-motion', !!s.reduceMotion);
  const meta = $$('meta[name="theme-color"]');
  const dark = s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  meta.forEach(m => m.setAttribute('content', dark ? '#14172B' : '#3B4CCA'));
}

/* ============================================================ feedback */
function toast(message, { action, onAction, timeout = 4000 } = {}) {
  const region = $('#toast-region');
  region.innerHTML = `<div class="toast"><span class="grow">${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}</div>`;
  const btn = $('button', region);
  if (btn) btn.addEventListener('click', () => { region.innerHTML = ''; onAction?.(); }, { once: true });
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { region.innerHTML = ''; }, action ? timeout + 3000 : timeout);
}
function announce(msg) {
  const a = $('#sr-announcer');
  a.textContent = '';
  setTimeout(() => { a.textContent = msg; }, 50);
}
function haptic(pattern = 12) {
  if (S.state?.settings.haptics && navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* ignore */ } }
}

/* ============================================================== dialogs */
function openDialog(html, cls = '') {
  const d = $('#dialog');
  d.className = `dialog ${cls}`;
  d.innerHTML = html;
  d.returnValue = '';
  d.showModal();
  return d;
}
function closeDialog() { const d = $('#dialog'); if (d.open) d.close(); }

function confirmDialog({ title, body, confirm = 'Confirm', danger = false, requireText = null }) {
  return new Promise(resolve => {
    const d = openDialog(`
      <form method="dialog" class="dialog-body">
        <h2 id="dialog-title">${esc(title)}</h2>
        <p>${body}</p>
        ${requireText ? `<div class="field"><label for="confirm-text">Type <strong>${esc(requireText)}</strong> to confirm</label>
          <input id="confirm-text" class="input" autocomplete="off" autocapitalize="characters"></div>` : ''}
        <div class="btn-row">
          <button class="btn btn-ghost" value="cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok" id="dialog-ok" ${requireText ? 'disabled' : ''}>${esc(confirm)}</button>
        </div>
      </form>`);
    if (requireText) {
      const input = $('#confirm-text', d), ok = $('#dialog-ok', d);
      input.addEventListener('input', () => { ok.disabled = input.value.trim().toUpperCase() !== requireText; });
      input.focus();
    }
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
  });
}

function passwordDialog({ title, body }) {
  return new Promise(resolve => {
    const d = openDialog(`
      <form method="dialog" class="dialog-body" id="pw-dialog-form">
        <h2 id="dialog-title">${esc(title)}</h2>
        <p>${esc(body)}</p>
        <div class="field"><label for="dlg-pw">Password</label>
          <input id="dlg-pw" class="input" type="password" autocomplete="current-password"></div>
        <div class="btn-row">
          <button class="btn btn-ghost" value="cancel">Cancel</button>
          <button class="btn btn-primary" value="ok">Continue</button>
        </div>
      </form>`);
    $('#dlg-pw', d).focus();
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? $('#dlg-pw', d).value : null), { once: true });
  });
}

/* =============================================================== router */
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: parts[0] || '', id: parts[1], sub: parts[2] };
}
function go(hash, replace = false) {
  if (replace) { history.replaceState(null, '', hash); route(); } else if (location.hash === hash) route(); else location.hash = hash;
}

const PUBLIC = ['welcome', 'signup', 'privacy'];
function route() {
  const r = parseRoute();
  if (!S.vault && !PUBLIC.includes(r.name)) return go('#/welcome', true);
  if (S.vault && !S.key && r.name !== 'unlock') {
    if (!['', 'welcome', 'signup'].includes(r.name)) S.afterUnlock = location.hash;
    return go('#/unlock', true);
  }
  if (S.key && ['', 'welcome', 'signup', 'unlock'].includes(r.name)) return go('#/today', true);
  const h = location.hash;
  if (S.stack[S.stack.length - 2] === h) S.stack.pop(); else if (S.stack[S.stack.length - 1] !== h) S.stack.push(h);
  if (S.stack.length > 30) S.stack.shift();
  renderView(true);
}

function viewFor(r) {
  switch (r.name) {
    case 'welcome': return viewWelcome();
    case 'signup': return viewSignup();
    case 'unlock': return viewUnlock();
    case 'privacy': return viewPrivacy();
    case 'today': return viewToday();
    case 'tasks': return viewTasks();
    case 'task':
      if (r.id === 'new') return viewTaskForm(null);
      if (r.sub === 'edit') return viewTaskForm(taskById(r.id));
      return viewTaskDetail(taskById(r.id));
    case 'calendar': return viewCalendar();
    case 'focus': return viewFocus();
    case 'more': return viewMore();
    case 'modules': return viewModules();
    case 'module': return viewModuleForm(r.id === 'new' ? null : moduleById(r.id));
    case 'class': return viewClassForm(r.id === 'new' ? null : S.state.classes.find(c => c.id === r.id));
    case 'password': return viewPassword();
    default: return viewNotFound();
  }
}

function renderView(routeChanged) {
  const r = parseRoute();
  const v = viewFor(r);
  const m = main();
  m.innerHTML = v.html;
  m.classList.toggle('no-tabs', !v.tab);
  document.body.classList.toggle('no-tabs-body', !v.tab);
  $('.app-shell').classList.toggle('has-tabs', !!v.tab);
  $('#tabbar').hidden = !v.tab;
  $('#fab').hidden = !v.fab;
  $$('#tabbar .tab').forEach(a => { if (a.dataset.tab === v.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  updateTabBadge();
  document.title = `${v.title} – StudyFlow`;
  hydrate(m);
  v.after?.();
  if (routeChanged) {
    window.scrollTo(0, 0);
    const h1 = $('h1', m);
    if (h1 && !v.autofocus) h1.focus({ preventScroll: true });
  }
}

/** Re-render the current screen in place, keeping keyboard focus and scroll position. */
function refresh() {
  const a = document.activeElement;
  const id = a?.id;
  let sel = null;
  try { if (a && typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd]; } catch { /* not a text field */ }
  const y = window.scrollY;
  renderView(false);
  if (id) {
    const el = document.getElementById(id);
    if (el) { el.focus({ preventScroll: true }); try { if (sel) el.setSelectionRange(...sel); } catch { /* ignore */ } }
  }
  window.scrollTo(0, y);
}
function refreshIf(...names) { if (S.key && names.includes(parseRoute().name)) refresh(); }

function hydrate(root) {
  $$('[data-color]', root).forEach(el => { if (/^#[0-9a-f]{6}$/i.test(el.dataset.color)) el.style.setProperty('--c', el.dataset.color); });
  $$('[data-p]', root).forEach(el => el.style.setProperty('--p', `${el.dataset.p}%`));
  $$('img[data-photo-id]', root).forEach(async img => {
    const url = await photoUrl(img.dataset.photoId);
    if (url) img.src = url;
  });
}

/* ====================================================== shared fragments */
function header(title, { back = '', sub = '', actions = '' } = {}) {
  return `<header class="screen-header">
    ${back ? `<button type="button" class="icon-btn" data-action="back" data-fallback="${back}" aria-label="Back">${icon('back')}</button>` : ''}
    <h1 tabindex="-1" id="page-title">${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</h1>
    ${actions ? `<div class="header-actions">${actions}</div>` : ''}
  </header>`;
}

function field({ name, label, type = 'text', value = '', hint = '', attrs = '', required = false }) {
  const desc = [`err-${name}`, hint ? `hint-${name}` : ''].filter(Boolean).join(' ');
  return `<div class="field">
    <label for="f-${name}">${label}${required ? ' <span class="muted" aria-hidden="true">(required)</span>' : ''}</label>
    ${hint ? `<span class="hint" id="hint-${name}">${hint}</span>` : ''}
    <input class="input" id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${attrs} ${required ? 'aria-required="true"' : ''} aria-describedby="${desc}">
    <span class="error" id="err-${name}"></span>
  </div>`;
}

function passwordField({ name, label, autocomplete, hint = '' }) {
  return `<div class="field">
    <label for="f-${name}">${label}</label>
    ${hint ? `<span class="hint" id="hint-${name}">${hint}</span>` : ''}
    <div class="input-wrap">
      <input class="input" id="f-${name}" name="${name}" type="password" autocomplete="${autocomplete}" aria-describedby="err-${name}${hint ? ` hint-${name}` : ''}" spellcheck="false" autocapitalize="off">
      <button type="button" class="icon-btn" data-action="toggle-pw" data-target="f-${name}" aria-label="Show password" aria-pressed="false">${icon('eye')}</button>
    </div>
    <span class="error" id="err-${name}"></span>
  </div>`;
}

function moduleOptions(selected = '', { none = 'No module' } = {}) {
  return `<option value="">${none}</option>` + S.state.modules
    .map(m => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.code)} – ${esc(m.name)}</option>`).join('');
}

function taskItem(t) {
  const m = moduleById(t.moduleId);
  const td = today();
  const u = core.urgency(t, td);
  const prog = core.subtaskProgress(t);
  return `<li class="task ${t.done ? 'is-done' : ''}" data-color="${m?.colour || ''}">
    <label class="task-check">
      <input type="checkbox" class="check round" id="chk-${t.id}" data-action="toggle-task" data-id="${t.id}" ${t.done ? 'checked' : ''}
        aria-label="${esc(t.title)}: mark as ${t.done ? 'not done' : 'done'}">
    </label>
    <a class="task-link" href="#/task/${t.id}">
      <span class="task-title">${esc(t.title)}</span>
      <span class="task-meta">
        ${m ? `<span class="mod-tag"><span class="mod-dot" data-color="${m.colour}"></span>${esc(m.code)}</span>` : ''}
        <span class="due ${u}">${esc(core.dueLabel(t, td))}</span>
        <span class="badge ${t.priority}">${cap(t.priority)}<span class="visually-hidden"> priority</span></span>
        ${prog ? `<span>${prog.done}/${prog.total} steps</span>` : ''}
        ${t.photoIds?.length ? `<span>${icon('camera', { size: 14 })}<span class="visually-hidden">photos:</span> ${t.photoIds.length}</span>` : ''}
      </span>
    </a>
  </li>`;
}

function taskList(tasks, emptyHtml = '') {
  if (!tasks.length) return emptyHtml;
  return `<ul class="task-list">${tasks.map(taskItem).join('')}</ul>`;
}

function ring(pct, label, sub) {
  const off = RING_C * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return `<div class="ring" role="img" aria-label="${esc(`${label} ${sub}`)}">
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="45" fill="none" stroke-width="10"/>
    <circle class="bar" cx="50" cy="50" r="45" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>
    <div class="ring-label" aria-hidden="true">${esc(label)}<small>${esc(sub)}</small></div>
  </div>`;
}

const heroArt = `<svg class="hero-art" viewBox="0 0 320 180" role="img" aria-label="Illustration of a planner with ticked tasks and a clock">
  <rect x="40" y="22" width="170" height="140" rx="16" fill="var(--surface)" stroke="var(--border)" stroke-width="2"/>
  <rect x="40" y="22" width="170" height="34" rx="16" fill="var(--primary)"/><rect x="40" y="40" width="170" height="16" fill="var(--primary)"/>
  <circle cx="72" cy="22" r="6" fill="var(--bg)" stroke="var(--border)" stroke-width="2"/><circle cx="178" cy="22" r="6" fill="var(--bg)" stroke="var(--border)" stroke-width="2"/>
  <g stroke-linecap="round" stroke-width="3"><rect x="58" y="72" width="18" height="18" rx="5" fill="var(--success)" stroke="none"/><path d="m62 81 4 4 7-8" stroke="#fff" fill="none"/>
  <path d="M88 81h96" stroke="var(--border)"/><rect x="58" y="102" width="18" height="18" rx="5" fill="var(--success)" stroke="none"/><path d="m62 111 4 4 7-8" stroke="#fff" fill="none"/>
  <path d="M88 111h76" stroke="var(--border)"/><rect x="58" y="132" width="18" height="18" rx="5" fill="none" stroke="var(--muted)"/><path d="M88 141h86" stroke="var(--border)"/></g>
  <circle cx="242" cy="112" r="44" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="3"/><path d="M242 86v26l16 12" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" fill="none"/>
  <circle cx="268" cy="44" r="10" fill="var(--primary-soft)"/><circle cx="24" cy="128" r="7" fill="var(--accent-soft)"/></svg>`;

/* =========================================================== auth views */
function viewWelcome() {
  return {
    title: 'Welcome', autofocus: false, html: `
    <section class="auth">
      <div class="brand"><img src="icons/icon-192.png" width="52" height="52" alt=""><span class="brand-name">StudyFlow</span></div>
      ${heroArt}
      <div class="stack-sm">
        <h1 tabindex="-1">Plan your studies, beat every deadline.</h1>
        <p class="muted">A calm planner for university life – it works offline and keeps your data encrypted on this device.</p>
      </div>
      <ul class="feature-list">
        <li><span class="row-icon">${icon('tasks', { size: 20 })}</span><span><strong>Deadlines & tasks</strong><br><span class="muted small">Organised by module, priority and due date.</span></span></li>
        <li><span class="row-icon">${icon('calendar', { size: 20 })}</span><span><strong>Week planner</strong><br><span class="muted small">Your timetable, deadlines, bank holidays and the forecast in one place.</span></span></li>
        <li><span class="row-icon">${icon('focus', { size: 20 })}</span><span><strong>Focus timer</strong><br><span class="muted small">Pomodoro sessions that keep the screen on and vibrate when done.</span></span></li>
      </ul>
      <a class="btn btn-primary btn-block" href="#/signup">Get started</a>
      <p class="privacy-note">${icon('shield', { size: 18 })}<span>No account server, no tracking. <a href="#/privacy">Read the privacy notice</a>.</span></p>
    </section>`,
  };
}

function viewSignup() {
  return {
    title: 'Create your planner', html: `
    ${header('Create your planner', { back: '#/welcome' })}
    <form class="form" data-form="signup" novalidate>
      <p class="muted">Your password encrypts everything you store. It never leaves this device.</p>
      ${field({ name: 'name', label: 'What should we call you?', value: '', attrs: 'autocomplete="given-name" maxlength="40"', hint: 'Optional – only used for greetings.' })}
      ${passwordField({ name: 'password', label: 'Create a password', autocomplete: 'new-password', hint: 'At least 8 characters. A short phrase is easiest to remember.' })}
      <div class="strength" id="pw-strength" data-level="" aria-hidden="true"><span></span></div>
      <p class="small muted" id="pw-strength-text" aria-live="polite"></p>
      ${passwordField({ name: 'confirm', label: 'Confirm password', autocomplete: 'new-password' })}
      <label class="consent"><input type="checkbox" class="check" name="consent" id="f-consent" aria-describedby="err-consent">
        <span>I understand my data is stored only on this device and <strong>cannot be recovered</strong> if I forget my password. I can export an encrypted backup at any time.</span></label>
      <span class="error" id="err-consent"></span>
      <label class="consent"><input type="checkbox" class="check" name="sample" checked>
        <span>Add example modules and tasks so I can explore (you can delete them later).</span></label>
      <div class="alert" id="signup-alert" role="alert"></div>
      <button class="btn btn-primary btn-block" type="submit" id="signup-btn">Create planner</button>
    </form>`,
  };
}

function viewUnlock() {
  const lock = lockoutRemaining();
  return {
    title: 'Unlock', html: `
    <section class="auth">
      <div class="brand"><img src="icons/icon-192.png" width="52" height="52" alt=""><span class="brand-name">StudyFlow</span></div>
      <div class="stack-sm"><h1 tabindex="-1">Welcome back</h1><p class="muted">Enter your password to unlock your planner.</p></div>
      <form class="form" data-form="unlock" novalidate>
        ${passwordField({ name: 'password', label: 'Password', autocomplete: 'current-password' })}
        <div class="alert" id="unlock-alert" role="alert">${lock ? `Too many attempts. Try again in ${Math.ceil(lock / 1000)} seconds.` : ''}</div>
        <button class="btn btn-primary btn-block" type="submit" id="unlock-btn">${icon('lock', { size: 20 })} Unlock</button>
      </form>
      <button type="button" class="link-btn" data-action="forgot">Forgot your password?</button>
      <p class="privacy-note">${icon('shield', { size: 18 })}<span>Your planner is encrypted with AES-256. It locks automatically when you're away.</span></p>
    </section>`,
    after: () => setTimeout(() => $('#f-password')?.focus(), 50),
    autofocus: true,
  };
}

function viewPrivacy() {
  return {
    title: 'Privacy notice', tab: S.key ? 'more' : null, html: `
    ${header('Privacy notice', { back: S.key ? '#/more' : '#/welcome' })}
    <article class="card prose">
      <p>StudyFlow is designed around <strong>data minimisation</strong> and <strong>privacy by design</strong> (UK GDPR, Article 25).</p>
      <h2>What is stored</h2>
      <ul><li>Your tasks, modules, timetable, focus sessions, settings and any photos you attach.</li>
      <li>Everything is stored <strong>only on this device</strong> (IndexedDB) and encrypted with AES-256-GCM using a key derived from your password (PBKDF2, 310,000 iterations).</li>
      <li>Your password is never stored or sent anywhere.</li>
      <li>Display preferences (text size, contrast, theme) are kept unencrypted so the lock screen is accessible.</li></ul>
      <h2>What leaves the device</h2>
      <ul><li><strong>Weather:</strong> an approximate location (rounded to about 1 km) is sent to Open-Meteo, only when you use the weather feature.</li>
      <li><strong>Bank holidays:</strong> the public GOV.UK list is downloaded; nothing about you is sent.</li>
      <li>No analytics, adverts, cookies or tracking of any kind.</li></ul>
      <h2>Your rights</h2>
      <ul><li><strong>Access & portability:</strong> export an encrypted backup from More › Data.</li>
      <li><strong>Erasure:</strong> “Delete all my data” removes everything from this device immediately.</li>
      <li><strong>Consent:</strong> location, camera and notifications are only requested when you choose to use them, and can be revoked in your browser settings.</li></ul>
    </article>`,
  };
}

/* ============================================================ today view */
function viewToday() {
  const st = S.state, td = today();
  const stats = core.computeStats(st.tasks, st.focusLog, td);
  const open = st.tasks.filter(t => !t.done);
  const overdue = core.sortTasks(open.filter(t => core.isOverdue(t, td)), 'due');
  const dueToday = core.sortTasks(open.filter(t => t.due === td), 'due');
  const upcoming = core.sortTasks(open.filter(t => t.due > td && core.daysBetween(td, t.due) <= 7), 'due').slice(0, 5);
  const classes = core.classesForDate(st.classes, td);
  const hol = core.upcomingHolidays(st.cache.holidays?.list || [], td, 1)[0];
  const name = st.profile.name ? `, ${st.profile.name}` : '';
  const showInstall = !isStandalone() && (S.installPrompt || isIOS()) && !st.settings.installDismissed;

  return {
    title: 'Today', tab: 'today', fab: true, html: `
    ${header(`${core.greeting(new Date().getHours())}${name}`, { sub: core.formatLongDate(td),
      actions: `<button type="button" class="icon-btn" data-action="lock" aria-label="Lock planner">${icon('lock')}</button>` })}

    ${showInstall ? `<div class="card install-card section">
      <span class="row-icon">${icon('install', { size: 20 })}</span>
      <div class="grow"><strong>Install StudyFlow</strong><br><span class="small muted">${S.installPrompt ? 'Add it to your home screen for one-tap, full-screen access – even offline.' : 'Tap the Share button, then “Add to Home Screen”.'}</span></div>
      ${S.installPrompt ? `<button type="button" class="btn btn-secondary" data-action="install">Install</button>` : ''}
      <button type="button" class="icon-btn" data-action="dismiss-install" aria-label="Dismiss install suggestion">${icon('close', { size: 20 })}</button>
    </div>` : ''}

    <div class="grid-2 section">
      <section class="card stack" aria-labelledby="sum-h">
        <h2 id="sum-h" class="visually-hidden">Today's progress</h2>
        <div class="summary">
          ${ring(stats.todayPct, `${stats.todayPct}%`, 'today', )}
          <div class="stack-sm">
            <p><strong>${stats.doneToday} of ${stats.doneToday + stats.dueToday}</strong> of today's tasks done</p>
            <p class="small muted">${stats.dueThisWeek} due in the next 7 days · ${stats.open} open in total</p>
          </div>
        </div>
        <div class="stats">
          <div class="stat ${stats.overdue ? 'alert-stat' : ''}"><b>${stats.overdue}</b><span>Overdue</span></div>
          <div class="stat"><b>${stats.doneThisWeek}</b><span>Done this week</span></div>
          <div class="stat"><b>${core.formatMinutes(stats.focusWeek)}</b><span>Focus this week</span></div>
          <div class="stat"><b>${stats.streak} ${stats.streak === 1 ? 'day' : 'days'}</b><span>Study streak</span></div>
        </div>
      </section>
      ${weatherCard(classes)}
    </div>

    ${hol ? `<p class="holiday section">${icon('flag', { size: 20 })}<span><strong>${esc(hol.title)}</strong> – ${esc(core.formatLongDate(hol.date))}${hol.date === td ? ' (today)' : ` (in ${core.daysBetween(td, hol.date)} days)`}</span></p>` : ''}

    ${overdue.length ? `<section class="section" aria-labelledby="od-h"><div class="section-head"><h2 id="od-h">Overdue <span class="badge high">${overdue.length}</span></h2><a href="#/tasks" data-action="set-view" data-view="overdue">See all</a></div>${taskList(overdue)}</section>` : ''}

    <section class="section" aria-labelledby="dt-h">
      <div class="section-head"><h2 id="dt-h">Due today</h2></div>
      ${taskList(dueToday, `<div class="empty">${icon('check', { size: 28 })}<strong>Nothing due today</strong><span>${open.length ? 'Get ahead on something coming up.' : 'Add your first task with the + button.'}</span></div>`)}
    </section>

    <section class="section" aria-labelledby="cl-h">
      <div class="section-head"><h2 id="cl-h">Today's classes</h2><a href="#/modules">Timetable</a></div>
      ${classes.length ? `<div class="card card-tight">${classes.map(classRow).join('')}</div>`
        : `<p class="muted small">No classes today${st.classes.length ? '' : ' – add your timetable under More › Modules'}.</p>`}
    </section>

    <section class="section" aria-labelledby="up-h">
      <div class="section-head"><h2 id="up-h">Coming up</h2><a href="#/tasks" data-action="set-view" data-view="upcoming">See all</a></div>
      ${taskList(upcoming, `<p class="muted small">Nothing due in the next 7 days.</p>`)}
    </section>`,
    after: () => { loadWeather(); loadHolidays(); },
  };
}

function classRow(c) {
  const m = moduleById(c.moduleId);
  return `<div class="class-row"><span class="class-time">${esc(c.start)}–${esc(c.end)}</span>
    <span class="mod-dot" data-color="${m?.colour || ''}"></span>
    <span class="grow"><strong>${esc(m?.code || 'Class')}</strong> ${esc(c.kind || '')}<br><span class="small muted">${esc(c.room || m?.name || '')}</span></span></div>`;
}

function weatherCard(classesToday) {
  const w = S.state.cache.weather;
  const place = S.state.settings.location || DEFAULT_PLACE;
  const status = S.weather.status;
  let body;
  if (w?.data) {
    const info = core.weatherInfo(w.data.code);
    const stale = Date.now() - w.at > 3 * 3600000;
    body = `<div class="weather-main">
        <span class="weather-ico" role="img" aria-label="${esc(info.label)}">${info.icon}</span>
        <div class="grow"><div class="weather-temp num">${Math.round(w.data.temp)}°C</div>
        <div class="small muted">${esc(info.label)} · feels ${Math.round(w.data.feels)}° · wind ${Math.round(w.data.wind)} km/h</div></div>
      </div>
      <p class="weather-advice">${esc(core.weatherAdvice(w.data, classesToday))}</p>
      <div class="weather-days" aria-label="7-day forecast">${w.data.days.map(d => {
        const i = core.weatherInfo(d.code); const dt = core.parseISODate(d.date);
        return `<div><span class="visually-hidden">${core.DAY_NAMES[dt.getDay()]}: ${esc(i.label)}, high ${Math.round(d.max)}, low ${Math.round(d.min)}, rain chance ${d.rain ?? 0}%</span><span aria-hidden="true">${core.DAY_SHORT[dt.getDay()][0]}<span class="wd-ico">${i.icon}</span>${Math.round(d.max)}°</span></div>`;
      }).join('')}</div>
      <p class="small muted">${status === 'loading' ? 'Updating…' : `Updated ${new Date(w.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${(stale || S.weather.error) ? ' · showing saved forecast' : ''}`}</p>`;
  } else if (status === 'loading' || status === 'locating' || status === 'idle') {
    body = `<div class="stack-sm" aria-busy="true"><div class="skeleton"></div><span class="small muted">${status === 'locating' ? 'Finding your location…' : 'Loading forecast…'}</span><div class="skeleton"></div><div class="skeleton"></div></div>`;
  } else {
    body = `<p class="alert">${esc(S.weather.error || 'Weather unavailable.')}</p>`;
  }
  return `<section class="card weather" aria-labelledby="wx-h" aria-busy="${status === 'loading' || status === 'locating'}">
    <div class="section-head"><h2 id="wx-h">${icon('pin', { size: 18 })} ${esc(place.name)}</h2>
      <button type="button" class="icon-btn" data-action="weather-refresh" aria-label="Refresh weather">${status === 'loading' ? '<span class="spinner" aria-hidden="true"></span>' : icon('reset', { size: 20 })}</button></div>
    ${body}
    ${S.weather.error && w?.data ? `<p class="small muted" role="status">${esc(S.weather.error)}</p>` : ''}
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" data-action="weather-gps">${icon('pin', { size: 18 })} Use my location</button>
      <button type="button" class="btn btn-ghost" data-action="weather-search">${icon('search', { size: 18 })} Change city</button>
    </div>
  </section>`;
}

/* ============================================================ tasks view */
function viewTasks() {
  const st = S.state, td = today();
  const counts = {
    all: st.tasks.filter(t => !t.done).length,
    today: core.filterTasks(st.tasks, { view: 'today' }, td).length,
    upcoming: core.filterTasks(st.tasks, { view: 'upcoming' }, td).length,
    overdue: core.filterTasks(st.tasks, { view: 'overdue' }, td).length,
    done: st.tasks.filter(t => t.done).length,
  };
  const views = [['all', 'Open'], ['today', 'Today'], ['upcoming', 'Next 7 days'], ['overdue', 'Overdue'], ['done', 'Done']];
  return {
    title: 'Tasks', tab: 'tasks', fab: true, html: `
    ${header('Tasks')}
    <div class="stack-sm">
      <div class="search-wrap">${icon('search', { size: 20 })}
        <label for="task-search" class="visually-hidden">Search tasks</label>
        <input id="task-search" class="input" type="search" placeholder="Search tasks and notes" value="${esc(S.ui.query)}" data-action="search" autocomplete="off" enterkeyhint="search">
      </div>
      <div class="chip-row" role="group" aria-label="Show">
        ${views.map(([v, l]) => `<button type="button" class="chip" id="view-${v}" data-action="view" data-view="${v}" aria-pressed="${S.ui.view === v}">${l} <span class="count">${counts[v]}</span></button>`).join('')}
      </div>
      <div class="row-2">
        <div class="field"><label class="visually-hidden" for="task-module">Filter by module</label>
          <select id="task-module" class="select" data-action="filter-module">${moduleOptions(S.ui.moduleId, { none: 'All modules' })}</select></div>
        <div class="field"><label class="visually-hidden" for="task-sort">Sort by</label>
          <select id="task-sort" class="select" data-action="sort">
            ${[['due', 'Sort: due date'], ['priority', 'Sort: priority'], ['module', 'Sort: module'], ['created', 'Sort: newest']].map(([v, l]) => `<option value="${v}" ${S.ui.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
      </div>
    </div>
    <p class="visually-hidden" id="task-count" role="status"></p>
    <div id="task-list" class="section"></div>`,
    after: renderTaskList,
  };
}

function renderTaskList() {
  const box = $('#task-list');
  if (!box) return;
  const td = today();
  const list = core.sortTasks(core.filterTasks(S.state.tasks, { view: S.ui.view, moduleId: S.ui.moduleId, query: S.ui.query }, td), S.ui.sort, S.state.modules);
  const empty = S.state.tasks.length === 0
    ? `<div class="empty">${icon('tasks', { size: 32 })}<strong>No tasks yet</strong><span>Add assignments, readings and revision so nothing sneaks up on you.</span><a class="btn btn-primary" href="#/task/new">${icon('plus', { size: 20 })} Add a task</a></div>`
    : `<div class="empty">${icon('search', { size: 28 })}<strong>No matching tasks</strong><span>Try another filter or search term.</span></div>`;
  box.innerHTML = taskList(list, empty);
  hydrate(box);
  const c = $('#task-count');
  if (c) c.textContent = `${list.length} ${list.length === 1 ? 'task' : 'tasks'} shown`;
}

/* ========================================================= task form */
function viewTaskForm(task) {
  if (task === undefined) return viewNotFound();
  const t = task || { title: '', moduleId: S.ui.moduleId || '', type: 'assignment', due: S.ui.newDue || today(), dueTime: '', priority: 'medium', notes: '' };
  S.ui.newDue = null;
  const editing = !!task;
  return {
    title: editing ? 'Edit task' : 'New task', autofocus: !editing, html: `
    ${header(editing ? 'Edit task' : 'New task', { back: editing ? `#/task/${task.id}` : '#/tasks' })}
    <form class="form" data-form="task" data-id="${editing ? task.id : ''}" novalidate>
      ${field({ name: 'title', label: 'Title', value: t.title, required: true, attrs: 'maxlength="120" autocomplete="off" enterkeyhint="next"' })}
      <div class="row-2">
        <div class="field"><label for="f-moduleId">Module</label>
          <select class="select" id="f-moduleId" name="moduleId">${moduleOptions(t.moduleId)}</select>
          ${S.state.modules.length ? '' : '<a class="small" href="#/module/new">Add a module</a>'}</div>
        <div class="field"><label for="f-type">Type</label>
          <select class="select" id="f-type" name="type">${core.TASK_TYPES.map(x => `<option value="${x}" ${t.type === x ? 'selected' : ''}>${cap(x)}</option>`).join('')}</select></div>
      </div>
      <div class="row-2">
        ${field({ name: 'due', label: 'Due date', type: 'date', value: t.due || '' })}
        ${field({ name: 'dueTime', label: 'Time (optional)', type: 'time', value: t.dueTime || '' })}
      </div>
      <fieldset class="field"><legend class="label">Priority</legend>
        <div class="segmented">${core.PRIORITIES.map(p => `<label><input type="radio" name="priority" value="${p}" ${t.priority === p ? 'checked' : ''}><span>${cap(p)}</span></label>`).join('')}</div>
        <span class="error" id="err-priority"></span>
      </fieldset>
      <div class="field"><label for="f-notes">Notes</label>
        <textarea class="textarea" id="f-notes" name="notes" maxlength="2000" aria-describedby="err-notes">${esc(t.notes || '')}</textarea>
        <span class="error" id="err-notes"></span></div>
      ${editing ? '' : `<p class="small muted">${icon('camera', { size: 16 })} After saving you can add steps and photos (e.g. of the assignment sheet).</p>`}
      <div class="btn-row">
        <button type="button" class="btn btn-ghost" data-action="back" data-fallback="${editing ? `#/task/${task.id}` : '#/tasks'}">Cancel</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Save changes' : 'Add task'}</button>
      </div>
    </form>`,
    after: () => { if (!editing) $('#f-title')?.focus(); },
  };
}

/* ======================================================= task detail */
function viewTaskDetail(t) {
  if (!t) return viewNotFound();
  const m = moduleById(t.moduleId), td = today(), u = core.urgency(t, td);
  const prog = core.subtaskProgress(t);
  return {
    title: t.title, tab: 'tasks', html: `
    ${header('Task', { back: '#/tasks', actions: `
      <a class="icon-btn" href="#/task/${t.id}/edit" aria-label="Edit task">${icon('edit')}</a>
      <button type="button" class="icon-btn danger" data-action="delete-task" data-id="${t.id}" aria-label="Delete task">${icon('trash')}</button>` })}
    <article class="stack">
      <div class="card stack" data-color="${m?.colour || ''}">
        <h2 class="detail-title">${esc(t.title)}</h2>
        <div class="detail-meta">
          ${m ? `<span class="mod-tag"><span class="mod-dot" data-color="${m.colour}"></span>${esc(m.code)} · ${esc(m.name)}</span>` : ''}
          <span class="badge ${t.priority}">${cap(t.priority)} priority</span><span class="badge">${cap(t.type)}</span>
        </div>
        <dl class="kv">
          <dt>Due</dt><dd><span class="due ${u}">${esc(core.dueLabel(t, td))}</span>${t.due ? ` <span class="muted">(${esc(core.formatLongDate(t.due))}${t.dueTime ? `, ${esc(t.dueTime)}` : ''})</span>` : ''}</dd>
          ${t.done && t.completedAt ? `<dt>Completed</dt><dd>${esc(new Date(t.completedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</dd>` : ''}
        </dl>
        <div class="btn-row">
          <button type="button" class="btn ${t.done ? 'btn-ghost' : 'btn-primary'}" data-action="toggle-task-btn" data-id="${t.id}" id="detail-toggle">${icon('check', { size: 20 })} ${t.done ? 'Mark as not done' : 'Mark as done'}</button>
          ${t.done ? '' : `<a class="btn btn-secondary" href="#/focus" data-action="focus-on" data-id="${t.id}">${icon('focus', { size: 20 })} Focus on this</a>`}
        </div>
      </div>

      <section class="card card-tight" aria-labelledby="steps-h">
        <div class="section-head"><h2 id="steps-h">Steps ${prog ? `<span class="muted small">${prog.done}/${prog.total}</span>` : ''}</h2></div>
        ${prog ? `<div class="progress" role="progressbar" aria-label="Steps completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prog.pct}"><span data-p="${prog.pct}"></span></div>` : ''}
        <ul class="list">${(t.subtasks || []).map(s => `<li class="subtask ${s.done ? 'done' : ''}">
            <input type="checkbox" class="check" id="sub-${s.id}" data-action="toggle-sub" data-id="${t.id}" data-sub="${s.id}" ${s.done ? 'checked' : ''}>
            <label for="sub-${s.id}">${esc(s.text)}</label>
            <button type="button" class="icon-btn" data-action="delete-sub" data-id="${t.id}" data-sub="${s.id}" aria-label="Remove step: ${esc(s.text)}">${icon('close', { size: 18 })}</button></li>`).join('')}</ul>
        <form class="add-inline" data-form="subtask" data-id="${t.id}" novalidate>
          <label for="new-sub" class="visually-hidden">New step</label>
          <input id="new-sub" name="text" class="input" placeholder="Break it into a step…" maxlength="120" autocomplete="off" enterkeyhint="done">
          <button type="submit" class="icon-btn" aria-label="Add step">${icon('plus')}</button>
        </form>
      </section>

      ${t.notes ? `<section class="card stack-sm" aria-labelledby="notes-h"><h2 id="notes-h">Notes</h2><p class="notes">${esc(t.notes)}</p></section>` : ''}

      <section class="card stack-sm" aria-labelledby="ph-h">
        <h2 id="ph-h">Photos</h2>
        <p class="small muted">Snap the assignment brief, a whiteboard or lecture slide. Photos are compressed and encrypted on this device.</p>
        <div class="photos">
          ${(t.photoIds || []).map((pid, i) => `<button type="button" class="photo" data-action="view-photo" data-id="${t.id}" data-photo="${pid}" aria-label="Open photo ${i + 1}"><img data-photo-id="${pid}" alt="Photo ${i + 1} attached to ${esc(t.title)}"></button>`).join('')}
          <button type="button" class="photo-add" data-action="add-photo" data-id="${t.id}" data-capture="1">${icon('camera')}<span>Take photo</span></button>
          <button type="button" class="photo-add" data-action="add-photo" data-id="${t.id}" data-capture="0">${icon('upload')}<span>Choose image</span></button>
        </div>
      </section>
    </article>`,
  };
}

/* ======================================================== week view */
function viewCalendar() {
  const st = S.state, td = today();
  const anchor = S.ui.weekOf || td;
  const dates = core.weekDates(anchor);
  const hols = st.cache.holidays?.list || [];
  const wx = st.cache.weather?.data?.days || [];
  const range = `${core.formatDate(dates[0], { weekday: false })} – ${core.formatDate(dates[6], { weekday: false })} ${core.parseISODate(dates[6]).getFullYear()}`;
  const isThisWeek = dates.includes(td);
  return {
    title: 'Week', tab: 'calendar', fab: true, html: `
    ${header('Week', { sub: range })}
    <div class="week-nav">
      <button type="button" class="icon-btn" data-action="week" data-dir="-1" aria-label="Previous week">${icon('back')}</button>
      <div class="label" aria-live="polite">${isThisWeek ? 'This week' : esc(range)}</div>
      ${isThisWeek ? '' : `<button type="button" class="btn btn-ghost" data-action="week" data-dir="0">Today</button>`}
      <button type="button" class="icon-btn" data-action="week" data-dir="1" aria-label="Next week">${icon('next')}</button>
    </div>
    <p class="small muted" id="swipe-hint">Tip: swipe left or right to change week.</p>
    <div class="week section" id="week" aria-describedby="swipe-hint">
      ${dates.map(d => {
        const dt = core.parseISODate(d);
        const tasks = core.sortTasks(core.tasksForDate(st.tasks, d), 'due');
        const classes = core.classesForDate(st.classes, d);
        const hol = hols.find(h => h.date === d);
        const w = wx.find(x => x.date === d);
        const wi = w && core.weatherInfo(w.code);
        return `<section class="day ${d === td ? 'is-today' : ''}" aria-labelledby="d-${d}">
          <div class="day-head"><h2 id="d-${d}">${core.DAY_NAMES[dt.getDay()]} <span class="muted">${core.formatDate(d, { weekday: false })}</span>${d === td ? ' <span class="badge">Today</span>' : ''}</h2>
          ${w ? `<span class="day-wx"><span aria-hidden="true">${wi.icon}</span> ${Math.round(w.max)}°<span class="visually-hidden"> ${esc(wi.label)}</span>${w.rain != null ? ` · ${w.rain}%<span class="visually-hidden"> chance of rain</span>` : ''}</span>` : ''}
          <a class="icon-btn" href="#/task/new" data-action="new-on" data-date="${d}" aria-label="Add task on ${core.DAY_NAMES[dt.getDay()]} ${core.formatDate(d, { weekday: false })}">${icon('plus', { size: 20 })}</a></div>
          <div class="day-body">
            ${hol ? `<div class="day-item">${icon('flag', { size: 18 })}<span class="grow"><strong>${esc(hol.title)}</strong></span></div>` : ''}
            ${classes.map(c => { const m = moduleById(c.moduleId); return `<div class="day-item"><span class="kind">Class</span><span class="mod-dot" data-color="${m?.colour || ''}"></span><span class="grow">${esc(c.start)} <strong>${esc(m?.code || '')}</strong> ${esc(c.kind || '')}${c.room ? ` · <span class="muted">${esc(c.room)}</span>` : ''}</span></div>`; }).join('')}
            ${tasks.map(t => { const m = moduleById(t.moduleId); return `<a class="day-item ${t.done ? 'done' : ''}" href="#/task/${t.id}"><span class="kind">${t.done ? 'Done' : 'Due'}</span><span class="mod-dot" data-color="${m?.colour || ''}"></span><span class="grow">${esc(t.title)}${t.dueTime ? ` <span class="muted">${esc(t.dueTime)}</span>` : ''}</span><span class="badge ${t.priority}">${cap(t.priority)}</span></a>`; }).join('')}
            ${!hol && !classes.length && !tasks.length ? '<p class="day-empty">Free day</p>' : ''}
          </div></section>`;
      }).join('')}
    </div>`,
    after: () => { bindSwipe($('#week')); loadHolidays(); },
  };
}

function bindSwipe(el) {
  if (!el) return;
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 50) { changeWeek(dx < 0 ? 1 : -1); haptic(8); }
  }, { passive: true });
}
function changeWeek(dir) {
  S.ui.weekOf = dir === 0 ? null : core.addDays(S.ui.weekOf || today(), dir * 7);
  refresh();
  announce($('#page-title .sub')?.textContent || '');
}

/* ======================================================= focus timer */
function viewFocus() {
  const st = S.state, set = st.settings, td = today();
  const t = S.timer;
  const durMs = t ? t.durationMs : set.focusMin * 60000;
  const rem = t ? core.timerRemaining(t, Date.now()) : durMs;
  const running = t && !t.paused;
  const mode = t?.mode || 'focus';
  const todayMin = st.focusLog.filter(f => f.date === td).reduce((s, f) => s + f.minutes, 0);
  const sessions = st.focusLog.filter(f => f.date === td).length;
  const openTasks = core.sortTasks(st.tasks.filter(x => !x.done), 'due');
  const focusTask = taskById(t?.taskId || S.ui.focusTask);
  return {
    title: 'Focus', tab: 'focus', html: `
    ${header('Focus', { sub: `${core.formatMinutes(todayMin)} today · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}` })}
    <div class="focus-wrap">
      <div class="timer-ring ${mode === 'break' ? 'break' : ''}">
        <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="45" fill="none" stroke-width="6"/>
          <circle class="bar" id="timer-bar" cx="50" cy="50" r="45" fill="none" stroke-width="6" stroke-linecap="round" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${(RING_C * (1 - rem / durMs)).toFixed(1)}"/></svg>
        <div class="timer-center">
          <span class="timer-mode">${mode === 'break' ? 'Break' : 'Focus'}</span>
          <span class="timer-clock" id="timer-clock" role="timer" aria-live="off" aria-label="Time remaining">${core.formatClock(rem)}</span>
          ${focusTask && mode === 'focus' ? `<span class="small muted">${esc(focusTask.title)}</span>` : ''}
        </div>
      </div>
      <div class="stack">
        <div class="timer-controls">
          <button type="button" class="round-btn secondary" data-action="timer-reset" aria-label="Reset timer" ${t ? '' : 'disabled'}>${icon('reset')}</button>
          <button type="button" class="round-btn" id="timer-toggle" data-action="timer-toggle" aria-label="${running ? 'Pause' : t ? 'Resume' : 'Start'} ${mode}">${icon(running ? 'pause' : 'play', { size: 30 })}</button>
          <button type="button" class="round-btn secondary" data-action="timer-skip" aria-label="Finish ${mode} now" ${t ? '' : 'disabled'}>${icon('skip')}</button>
        </div>
        ${t ? '' : `
        <div class="field"><label for="focus-task">Working on</label>
          <select id="focus-task" class="select" data-action="focus-task"><option value="">Nothing specific</option>
            ${openTasks.map(x => `<option value="${x.id}" ${x.id === S.ui.focusTask ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></div>
        <div class="row-2">
          <div class="field"><label for="focus-len">Focus length</label>
            <select id="focus-len" class="select" data-action="focus-len">${[15, 25, 30, 45, 50].map(n => `<option value="${n}" ${set.focusMin === n ? 'selected' : ''}>${n} minutes</option>`).join('')}</select></div>
          <div class="field"><label for="break-len">Break length</label>
            <select id="break-len" class="select" data-action="break-len">${[5, 10, 15].map(n => `<option value="${n}" ${set.breakMin === n ? 'selected' : ''}>${n} minutes</option>`).join('')}</select></div>
        </div>`}
        <p class="small muted">${'wakeLock' in navigator ? 'Your screen stays on while the timer runs. ' : ''}${navigator.vibrate ? 'Your phone vibrates when a session ends.' : 'You will get an alert when a session ends.'}</p>
      </div>
    </div>`,
  };
}

function timerStart() {
  const set = S.state.settings;
  if (!S.timer) {
    const durationMs = set.focusMin * 60000;
    S.timer = { mode: 'focus', durationMs, endsAt: Date.now() + durationMs, paused: false, remainingMs: durationMs, taskId: S.ui.focusTask || '' };
  } else if (S.timer.paused) {
    S.timer.endsAt = Date.now() + S.timer.remainingMs;
    S.timer.paused = false;
  }
  requestWakeLock();
  haptic(10);
}
function timerPause() {
  if (!S.timer || S.timer.paused) return;
  S.timer.remainingMs = core.timerRemaining(S.timer, Date.now());
  S.timer.paused = true;
  releaseWakeLock();
}
function timerComplete(early = false) {
  const t = S.timer;
  if (!t) return;
  releaseWakeLock();
  if (t.mode === 'focus') {
    const elapsed = t.durationMs - core.timerRemaining(t, Date.now());
    const minutes = Math.round((early ? elapsed : t.durationMs) / 60000);
    if (minutes > 0 && S.state) { S.state.focusLog.push({ date: today(), minutes, taskId: t.taskId }); save(); }
    const breakMs = S.state.settings.breakMin * 60000;
    S.timer = { mode: 'break', durationMs: breakMs, endsAt: 0, paused: true, remainingMs: breakMs, taskId: t.taskId };
    if (minutes > 0) {
      notifyUser('Focus session complete', `Nice work – ${minutes} minutes logged. Time for a ${S.state.settings.breakMin}-minute break.`);
      toast(`Focus session complete – ${minutes} min logged.`);
    } else toast('Session ended early – under a minute, so nothing was logged.');
  } else {
    S.timer = null;
    notifyUser('Break over', 'Ready for another focus session?');
    toast('Break over – ready when you are.');
  }
  haptic([200, 100, 200]);
  announce(S.timer ? 'Focus session complete. Break ready.' : 'Break over.');
  refreshIf('focus');
}
function tickTimer() {
  const t = S.timer;
  if (!t || t.paused) return;
  const rem = core.timerRemaining(t, Date.now());
  const clock = $('#timer-clock');
  if (clock) {
    clock.textContent = core.formatClock(rem);
    const bar = $('#timer-bar');
    if (bar) bar.setAttribute('stroke-dashoffset', (RING_C * (1 - rem / t.durationMs)).toFixed(1));
  }
  if (rem <= 0) timerComplete();
}
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !S.wakeLock) {
      S.wakeLock = await navigator.wakeLock.request('screen');
      S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
    }
  } catch { S.wakeLock = null; }
}
function releaseWakeLock() { try { S.wakeLock?.release(); } catch { /* ignore */ } S.wakeLock = null; }

/* ======================================================== more / settings */
function viewMore() {
  const st = S.state, s = st.settings;
  const initial = (st.profile.name || 'S').trim()[0].toUpperCase();
  const notifSupported = 'Notification' in window;
  const perm = notifSupported ? Notification.permission : 'unsupported';
  return {
    title: 'More', tab: 'more', html: `
    ${header('More')}
    <div class="card profile">
      <span class="avatar" aria-hidden="true">${esc(initial)}</span>
      <div class="grow"><strong>${esc(st.profile.name || 'Student')}</strong><br>
        <span class="small muted">Planner created ${esc(new Date(st.profile.createdAt).toLocaleDateString([], { dateStyle: 'medium' }))} · ${st.tasks.length} tasks · ${st.modules.length} modules</span></div>
    </div>

    <h2 class="group-title">Study</h2>
    <ul class="list card card-tight">
      <li><a class="list-row list-link" href="#/modules"><span class="row-icon">${icon('book', { size: 20 })}</span><span class="grow"><span class="title">Modules & timetable</span><br><span class="meta">${st.modules.length} modules · ${st.classes.length} weekly classes</span></span>${icon('next', { size: 20 })}</a></li>
    </ul>

    <h2 class="group-title" id="a11y-h">Accessibility & display</h2>
    <ul class="list card card-tight" aria-labelledby="a11y-h">
      <li class="setting-row"><div class="grow"><label for="set-text"><strong>Text size</strong></label>
        <input type="range" class="range" id="set-text" min="0.9" max="1.5" step="0.1" value="${s.textScale}" data-setting="textScale" aria-valuetext="${Math.round(s.textScale * 100)} percent">
        <p class="small muted" aria-hidden="true">${Math.round(s.textScale * 100)}% – this text previews the size.</p></div></li>
      <li class="setting-row"><label class="grow" for="set-theme"><strong>Theme</strong></label>
        <select class="select" id="set-theme" data-setting="theme">${[['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<option value="${v}" ${s.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></li>
      <li><label class="switch-row"><span class="grow"><strong>High contrast</strong><br><span class="small muted">Stronger borders and colours.</span></span><input type="checkbox" class="switch" id="set-contrast" data-setting="contrast" ${s.contrast ? 'checked' : ''}></label></li>
      <li><label class="switch-row"><span class="grow"><strong>Reduce motion</strong><br><span class="small muted">Turn off animations.</span></span><input type="checkbox" class="switch" id="set-motion" data-setting="reduceMotion" ${s.reduceMotion ? 'checked' : ''}></label></li>
      <li><label class="switch-row"><span class="grow"><strong>Vibration feedback</strong><br><span class="small muted">${navigator.vibrate ? 'Short buzz when you complete things.' : 'Not supported on this device.'}</span></span><input type="checkbox" class="switch" id="set-haptics" data-setting="haptics" ${s.haptics ? 'checked' : ''} ${navigator.vibrate ? '' : 'disabled'}></label></li>
    </ul>

    <h2 class="group-title" id="notif-h">Reminders</h2>
    <ul class="list card card-tight" aria-labelledby="notif-h">
      <li><label class="switch-row"><span class="grow"><strong>Deadline reminders</strong><br><span class="small muted">${perm === 'unsupported' ? 'Notifications are not supported here (on iPhone, install the app first).' : perm === 'denied' ? 'Blocked – allow notifications in your browser settings.' : 'A notification when a task is due within 24 hours.'}</span></span>
        <input type="checkbox" class="switch" id="set-notif" data-action="toggle-notifications" ${s.notifications && perm === 'granted' ? 'checked' : ''} ${perm === 'unsupported' || perm === 'denied' ? 'disabled' : ''}></label></li>
      <li><label class="switch-row"><span class="grow"><strong>Hide task names on lock screen</strong><br><span class="small muted">Reminders say “You have a task due” instead.</span></span><input type="checkbox" class="switch" id="set-private" data-setting="privateNotifications" ${s.privateNotifications ? 'checked' : ''}></label></li>
    </ul>

    <h2 class="group-title" id="loc-h">Weather & holidays</h2>
    <ul class="list card card-tight" aria-labelledby="loc-h">
      <li class="setting-row"><span class="grow"><strong>Weather location</strong><br><span class="small muted">${esc((s.location || DEFAULT_PLACE).name)}${s.location?.source === 'gps' ? ' (from GPS, rounded to ~1 km)' : ''}</span></span>
        <button type="button" class="btn btn-ghost" data-action="weather-search">Change</button></li>
      <li class="setting-row"><label class="grow" for="set-region"><strong>Bank holidays</strong></label>
        <select class="select" id="set-region" data-setting="region">${Object.entries(core.BANK_HOLIDAY_REGIONS).map(([v, l]) => `<option value="${v}" ${s.region === v ? 'selected' : ''}>${l}</option>`).join('')}</select></li>
    </ul>

    <h2 class="group-title" id="sec-h">Security</h2>
    <ul class="list card card-tight" aria-labelledby="sec-h">
      <li class="setting-row"><label class="grow" for="set-lock"><strong>Auto-lock</strong><br><span class="small muted">Lock after inactivity.</span></label>
        <select class="select" id="set-lock" data-setting="autoLockMin">${[1, 5, 15, 30].map(n => `<option value="${n}" ${s.autoLockMin === n ? 'selected' : ''}>After ${n} min</option>`).join('')}</select></li>
      <li><a class="list-row list-link" href="#/password"><span class="row-icon">${icon('lock', { size: 20 })}</span><span class="grow title">Change password</span>${icon('next', { size: 20 })}</a></li>
      <li><button type="button" class="list-row list-link btn-block" data-action="lock"><span class="row-icon">${icon('shield', { size: 20 })}</span><span class="grow title">Lock now</span></button></li>
    </ul>

    <h2 class="group-title" id="data-h">Your data</h2>
    <ul class="list card card-tight" aria-labelledby="data-h">
      <li><button type="button" class="list-row list-link btn-block" data-action="export"><span class="row-icon">${icon('download', { size: 20 })}</span><span class="grow"><span class="title">Export encrypted backup</span><br><span class="meta">Restorable with your current password.</span></span></button></li>
      <li><button type="button" class="list-row list-link btn-block" data-action="import"><span class="row-icon">${icon('upload', { size: 20 })}</span><span class="grow"><span class="title">Restore from backup</span><br><span class="meta">Replaces the data on this device.</span></span></button></li>
      <li class="setting-row"><span class="grow small muted" id="storage-used">Calculating storage…</span></li>
      <li><a class="list-row list-link" href="#/privacy"><span class="row-icon">${icon('info', { size: 20 })}</span><span class="grow title">Privacy notice</span>${icon('next', { size: 20 })}</a></li>
      <li><button type="button" class="list-row list-link btn-block" data-action="delete-all"><span class="row-icon">${icon('trash', { size: 20 })}</span><span class="grow title due overdue">Delete all my data</span></button></li>
    </ul>

    <h2 class="group-title">App</h2>
    <ul class="list card card-tight">
      ${!isStandalone() && S.installPrompt ? `<li><button type="button" class="list-row list-link btn-block" data-action="install"><span class="row-icon">${icon('install', { size: 20 })}</span><span class="grow title">Install StudyFlow</span></button></li>` : ''}
      ${!isStandalone() && !S.installPrompt && isIOS() ? `<li class="setting-row"><span class="grow small">To install on iPhone/iPad: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</span></li>` : ''}
      <li class="setting-row"><span class="grow small muted">StudyFlow ${APP_VERSION} · ${isStandalone() ? 'installed app' : 'running in browser'} · ${navigator.onLine ? 'online' : 'offline'}</span>
        <button type="button" class="btn btn-ghost" data-action="check-update">Check for update</button></li>
    </ul>`,
    after: async () => {
      const est = await db.storageEstimate();
      const el = $('#storage-used');
      if (el) el.textContent = est?.usage != null ? `Storage used on this device: ${(est.usage / 1048576).toFixed(1)} MB` : 'Storage used: unavailable in this browser';
    },
  };
}

/* ======================================================= modules & classes */
function viewModules() {
  const st = S.state;
  const byDay = [1, 2, 3, 4, 5, 6, 0].map(d => ({ d, list: st.classes.filter(c => Number(c.day) === d).sort((a, b) => a.start.localeCompare(b.start)) })).filter(x => x.list.length);
  return {
    title: 'Modules & timetable', tab: 'more', html: `
    ${header('Modules & timetable', { back: '#/more' })}
    <section class="section" aria-labelledby="mods-h">
      <div class="section-head"><h2 id="mods-h">Modules</h2><a href="#/module/new">${icon('plus', { size: 16 })} Add module</a></div>
      ${st.modules.length ? `<ul class="list card card-tight">${st.modules.map(m => {
        const n = st.tasks.filter(t => t.moduleId === m.id && !t.done).length;
        return `<li><a class="list-row list-link" href="#/module/${m.id}"><span class="mod-dot" data-color="${m.colour}"></span><span class="grow"><span class="title">${esc(m.code)}</span> <span class="meta">${esc(m.name)}</span><br><span class="meta">${n} open ${n === 1 ? 'task' : 'tasks'}</span></span>${icon('next', { size: 20 })}</a></li>`;
      }).join('')}</ul>` : `<div class="empty">${icon('book', { size: 28 })}<strong>No modules yet</strong><span>Add the modules you're studying to colour-code your tasks.</span><a class="btn btn-primary" href="#/module/new">Add module</a></div>`}
    </section>
    <section class="section" aria-labelledby="tt-h">
      <div class="section-head"><h2 id="tt-h">Weekly timetable</h2>${st.modules.length ? `<a href="#/class/new">${icon('plus', { size: 16 })} Add class</a>` : ''}</div>
      ${byDay.length ? byDay.map(({ d, list }) => `<h3 class="group-title">${core.DAY_NAMES[d]}</h3><ul class="list card card-tight">${list.map(c => {
        const m = moduleById(c.moduleId);
        return `<li><a class="list-row list-link" href="#/class/${c.id}"><span class="class-time">${esc(c.start)}–${esc(c.end)}</span><span class="mod-dot" data-color="${m?.colour || ''}"></span><span class="grow"><span class="title">${esc(m?.code || '?')}</span> <span class="meta">${esc(c.kind || '')}${c.room ? ` · ${esc(c.room)}` : ''}</span></span>${icon('next', { size: 20 })}</a></li>`;
      }).join('')}</ul>`).join('') : `<p class="muted small">${st.modules.length ? 'No classes yet. Add lectures and labs to see them on your Today and Week screens.' : 'Add a module first, then its classes.'}</p>`}
    </section>`,
  };
}

function viewModuleForm(m) {
  if (m === undefined) return viewNotFound();
  const editing = !!m;
  const used = S.state.modules.map(x => x.colour);
  const v = m || { code: '', name: '', colour: core.MODULE_COLOURS.find(c => !used.includes(c)) || core.MODULE_COLOURS[0] };
  const names = ['Indigo', 'Orange', 'Green', 'Pink', 'Purple', 'Teal', 'Gold', 'Slate'];
  return {
    title: editing ? 'Edit module' : 'New module', tab: 'more', html: `
    ${header(editing ? 'Edit module' : 'New module', { back: '#/modules' })}
    <form class="form" data-form="module" data-id="${editing ? m.id : ''}" novalidate>
      ${field({ name: 'code', label: 'Module code', value: v.code, required: true, attrs: 'maxlength="12" autocapitalize="characters" autocomplete="off"', hint: 'e.g. CS52001' })}
      ${field({ name: 'name', label: 'Module name', value: v.name, required: true, attrs: 'maxlength="60" autocomplete="off"', hint: 'e.g. Mobile Application Development' })}
      <fieldset class="field"><legend class="label">Colour</legend>
        <div class="swatches">${core.MODULE_COLOURS.map((c, i) => `<label class="swatch"><input type="radio" name="colour" value="${c}" ${v.colour === c ? 'checked' : ''} aria-label="${names[i]}"><span data-color="${c}"></span></label>`).join('')}</div>
        <span class="hint">Colour is always shown alongside the module code, never on its own.</span></fieldset>
      <div class="btn-row">
        ${editing ? `<button type="button" class="btn btn-danger-ghost" data-action="delete-module" data-id="${m.id}">Delete</button>` : ''}
        <button type="submit" class="btn btn-primary">${editing ? 'Save module' : 'Add module'}</button>
      </div>
    </form>`,
  };
}

function viewClassForm(c) {
  if (c === undefined) return viewNotFound();
  const editing = !!c;
  const v = c || { moduleId: S.state.modules[0]?.id || '', day: 1, start: '09:00', end: '10:00', kind: 'Lecture', room: '' };
  return {
    title: editing ? 'Edit class' : 'New class', tab: 'more', html: `
    ${header(editing ? 'Edit class' : 'New class', { back: '#/modules' })}
    <form class="form" data-form="class" data-id="${editing ? c.id : ''}" novalidate>
      <div class="field"><label for="f-moduleId">Module</label>
        <select class="select" id="f-moduleId" name="moduleId" aria-describedby="err-moduleId">${moduleOptions(v.moduleId, { none: 'Choose a module' })}</select><span class="error" id="err-moduleId"></span></div>
      <div class="row-2">
        <div class="field"><label for="f-kind">Type</label>
          <select class="select" id="f-kind" name="kind">${['Lecture', 'Lab', 'Tutorial', 'Seminar', 'Workshop'].map(k => `<option ${v.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
        <div class="field"><label for="f-day">Day</label>
          <select class="select" id="f-day" name="day">${[1, 2, 3, 4, 5, 6, 0].map(d => `<option value="${d}" ${Number(v.day) === d ? 'selected' : ''}>${core.DAY_NAMES[d]}</option>`).join('')}</select></div>
      </div>
      <div class="row-2">
        ${field({ name: 'start', label: 'Starts', type: 'time', value: v.start })}
        ${field({ name: 'end', label: 'Ends', type: 'time', value: v.end })}
      </div>
      ${field({ name: 'room', label: 'Room (optional)', value: v.room, attrs: 'maxlength="40" autocomplete="off"', hint: 'e.g. QMB Lab 0' })}
      <div class="btn-row">
        ${editing ? `<button type="button" class="btn btn-danger-ghost" data-action="delete-class" data-id="${c.id}">Delete</button>` : ''}
        <button type="submit" class="btn btn-primary">${editing ? 'Save class' : 'Add class'}</button>
      </div>
    </form>`,
  };
}

function viewPassword() {
  return {
    title: 'Change password', tab: 'more', html: `
    ${header('Change password', { back: '#/more' })}
    <form class="form" data-form="password" novalidate>
      <p class="muted">Your data and photos will be re-encrypted with the new password.</p>
      ${passwordField({ name: 'current', label: 'Current password', autocomplete: 'current-password' })}
      ${passwordField({ name: 'password', label: 'New password', autocomplete: 'new-password', hint: 'At least 8 characters.' })}
      ${passwordField({ name: 'confirm', label: 'Confirm new password', autocomplete: 'new-password' })}
      <div class="alert" id="pw-alert" role="alert"></div>
      <button type="submit" class="btn btn-primary btn-block" id="pw-btn">Change password</button>
    </form>`,
  };
}

function viewNotFound() {
  return {
    title: 'Not found', tab: S.key ? 'today' : null, html: `${header('Not found', { back: '#/today' })}
    <div class="empty">${icon('search', { size: 28 })}<strong>That page doesn't exist</strong><span>It may have been deleted.</span><a class="btn btn-primary" href="#/today">Go to Today</a></div>`,
  };
}

/* ============================================================= auth logic */
function lockoutRemaining() {
  try {
    const f = JSON.parse(localStorage.getItem('sf_fail') || '{}');
    return f.until && f.until > Date.now() ? f.until - Date.now() : 0;
  } catch { return 0; }
}
function recordFailure() {
  let f = {};
  try { f = JSON.parse(localStorage.getItem('sf_fail') || '{}'); } catch { /* ignore */ }
  f.count = (f.count || 0) + 1;
  if (f.count >= 5) f.until = Date.now() + 30000 * 2 ** Math.min(f.count - 5, 5); // 30 s, doubling, max 16 min
  localStorage.setItem('sf_fail', JSON.stringify(f));
  return f;
}

async function onSignup(form) {
  const fd = new FormData(form);
  const pw = fd.get('password'), confirm = fd.get('confirm');
  const res = core.validatePassword(pw, confirm);
  const errors = {};
  if (!res.valid) {
    const mismatch = res.errors.includes('Passwords do not match.');
    const other = res.errors.filter(e => e !== 'Passwords do not match.');
    if (other.length) errors.password = other.join(' ');
    if (mismatch) errors.confirm = 'Passwords do not match.';
  }
  if (!fd.get('consent')) errors.consent = 'Please confirm you understand how your data is stored.';
  if (Object.keys(errors).length) return showErrors(form, errors);
  const btn = $('#signup-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Encrypting your planner…';
  try {
    let state = core.defaultState(fd.get('name') || '');
    if (fd.get('sample')) state = addSampleData(state);
    const { key, vault } = await vaultCrypto.createVault(pw, state);
    await db.put('kv', 'vault', vault);
    S.vault = vault; S.key = key; S.state = state;
    localStorage.removeItem('sf_fail');
    mirrorPrefs();
    db.requestPersistence();
    onUnlocked();
    go('#/today', true);
    toast(`Welcome${state.profile.name ? `, ${state.profile.name}` : ''}! Your planner is ready.`);
  } catch (err) {
    console.error(err);
    $('#signup-alert').textContent = `Could not create your planner: ${err.message}`;
    btn.disabled = false; btn.textContent = 'Create planner';
  }
}

async function onUnlock(form) {
  const alertEl = $('#unlock-alert');
  const wait = lockoutRemaining();
  if (wait) { alertEl.textContent = `Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`; return; }
  const pw = new FormData(form).get('password');
  if (!pw) return showErrors(form, { password: 'Enter your password.' });
  const btn = $('#unlock-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Unlocking…';
  try {
    const { key, state } = await vaultCrypto.openVault(pw, S.vault);
    S.key = key; S.state = core.migrateState(state);
    localStorage.removeItem('sf_fail');
    onUnlocked();
    const target = S.afterUnlock; S.afterUnlock = null;
    go(target && target !== '#/unlock' ? target : '#/today', true);
  } catch (err) {
    const f = recordFailure();
    btn.disabled = false; btn.innerHTML = `${icon('lock', { size: 20 })} Unlock`;
    const left = Math.max(0, 5 - f.count);
    const input = $('#f-password');
    input.value = ''; input.setAttribute('aria-invalid', 'true'); input.focus();
    alertEl.textContent = err.message === 'WRONG_PASSWORD'
      ? (f.until ? `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} seconds.` : `Incorrect password.${left <= 2 ? ` ${left} ${left === 1 ? 'attempt' : 'attempts'} left before a short lockout.` : ''}`)
      : `Could not unlock: ${err.message}`;
    haptic([60, 40, 60]);
  }
}

function onUnlocked() {
  S.lastActive = Date.now();
  applyPrefs(S.state.settings);
  mirrorPrefs();
  updateBadge();
  checkReminders();
}

async function lock(reason = '') {
  if (!S.key) return;
  await flush();
  releaseWakeLock();
  S.key = null; S.state = null; S.timer = null;
  S.photoUrls.forEach(u => URL.revokeObjectURL(u)); S.photoUrls.clear();
  closeDialog();
  S.afterUnlock = location.hash;
  go('#/unlock', true);
  if (reason) toast(reason);
}

async function onChangePassword(form) {
  const fd = new FormData(form);
  const res = core.validatePassword(fd.get('password'), fd.get('confirm'));
  const errors = {};
  if (!fd.get('current')) errors.current = 'Enter your current password.';
  if (!res.valid) {
    const other = res.errors.filter(e => e !== 'Passwords do not match.');
    if (other.length) errors.password = other.join(' ');
    if (res.errors.includes('Passwords do not match.')) errors.confirm = 'Passwords do not match.';
  }
  if (Object.keys(errors).length) return showErrors(form, errors);
  const btn = $('#pw-btn'); btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Re-encrypting…';
  try {
    await flush();
    await vaultCrypto.openVault(fd.get('current'), S.vault); // verify
    const { key, vault } = await vaultCrypto.createVault(fd.get('password'), S.state);
    // re-encrypt every photo with the new key
    for (const id of await db.keys('photos')) {
      const p = await db.get('photos', id);
      const bytes = await vaultCrypto.decryptBytes(S.key, p);
      await db.put('photos', id, { ...(await vaultCrypto.encryptBytes(key, bytes)), type: p.type, at: p.at });
    }
    await db.put('kv', 'vault', vault);
    S.vault = vault; S.key = key;
    go('#/more', true);
    toast('Password changed. Remember to export a new backup.');
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Change password';
    if (err.message === 'WRONG_PASSWORD') showErrors(form, { current: 'Current password is incorrect.' });
    else $('#pw-alert').textContent = `Could not change password: ${err.message}`;
  }
}

function showErrors(form, errors) {
  $$('[aria-invalid]', form).forEach(el => el.removeAttribute('aria-invalid'));
  $$('.error', form).forEach(el => { el.textContent = ''; });
  let first = null;
  for (const [k, msg] of Object.entries(errors)) {
    const input = form.elements[k];
    const target = input && !input.tagName && input.length ? input[0] : input;
    if (target) { target.setAttribute('aria-invalid', 'true'); first = first || target; }
    const err = $(`#err-${k}`, form);
    if (err) err.textContent = msg;
  }
  first?.focus();
  const n = Object.keys(errors).length;
  announce(`${n} ${n === 1 ? 'problem' : 'problems'}: ${Object.values(errors).join(' ')}`);
  haptic([40, 30, 40]);
}

/* ============================================================== sample data */
function addSampleData(state) {
  const td = today();
  const id = p => core.createId(p);
  const [c0, c1, c2] = core.MODULE_COLOURS;
  const mad = { id: id('m'), code: 'CS52001', name: 'Mobile Application Development', colour: c0 };
  const res = { id: id('m'), code: 'RM501', name: 'Research Methods', colour: c1 };
  const ds = { id: id('m'), code: 'DS502', name: 'Data Science', colour: c2 };
  const now = Date.now();
  const sub = (text, done = false) => ({ id: id('s'), text, done });
  const task = (o) => ({ id: id('t'), type: 'assignment', priority: 'medium', notes: '', dueTime: '', subtasks: [], photoIds: [], done: false, completedAt: null, createdAt: now, ...o });
  return {
    ...state,
    modules: [mad, res, ds],
    classes: [
      { id: id('c'), moduleId: mad.id, day: 3, start: '11:00', end: '12:00', kind: 'Lecture', room: 'QMB Lab 0' },
      { id: id('c'), moduleId: mad.id, day: 3, start: '12:00', end: '14:00', kind: 'Lab', room: 'QMB Labs 0–2' },
      { id: id('c'), moduleId: res.id, day: 1, start: '10:00', end: '12:00', kind: 'Seminar', room: 'Dalhousie 2F13' },
      { id: id('c'), moduleId: ds.id, day: 4, start: '14:00', end: '16:00', kind: 'Lab', room: 'QMB Lab 1' },
    ],
    tasks: [
      task({ title: 'Add offline mode to the app', moduleId: mad.id, due: core.addDays(td, 2), priority: 'high', type: 'lab',
        subtasks: [sub('Cache app shell in service worker', true), sub('Test offline in DevTools'), sub('Test on an Android phone')],
        notes: 'Application › Service Workers › tick “Offline”, then reload.' }),
      task({ title: 'Write 2-page project report', moduleId: mad.id, due: core.addDays(td, 14), dueTime: '17:00', priority: 'high',
        notes: 'Sections: development process, design decisions, testing, security/ethics/accessibility, reflection.' }),
      task({ title: 'Rehearse 5-minute app demo', moduleId: mad.id, due: core.addDays(td, 13), type: 'revision' }),
      task({ title: 'Read: research ethics chapter', moduleId: res.id, due: td, type: 'reading' }),
      task({ title: 'Submit data-cleaning lab', moduleId: ds.id, due: core.addDays(td, -1), priority: 'high', type: 'lab' }),
      task({ title: 'Revise for statistics quiz', moduleId: ds.id, due: core.addDays(td, 5), priority: 'low', type: 'exam' }),
      task({ title: 'Book a library study room', due: td, type: 'personal', priority: 'low', done: true, completedAt: now - 3600000 }),
      task({ title: 'Weekly reading summary', moduleId: res.id, due: core.addDays(td, -1), type: 'reading', done: true, completedAt: now - 86400000 }),
    ],
    focusLog: [{ date: core.addDays(td, -1), minutes: 50, taskId: '' }, { date: td, minutes: 25, taskId: '' }],
  };
}

/* ===================================================== task operations */
function toggleTask(id) {
  const t = taskById(id);
  if (!t) return;
  t.done = !t.done;
  t.completedAt = t.done ? Date.now() : null;
  save();
  if (t.done) {
    haptic(15);
    toast(`Completed “${t.title}”`, { action: 'Undo', onAction: () => { toggleTask(id); } });
  } else announce(`${t.title} marked as not done`);
  if (parseRoute().name === 'tasks') { renderTaskList(); refreshChipCounts(); } else refresh();
}
function refreshChipCounts() {
  // cheap re-render of the tasks header counts while keeping the search box untouched
  const td = today(), st = S.state;
  const counts = { all: st.tasks.filter(t => !t.done).length, today: core.filterTasks(st.tasks, { view: 'today' }, td).length,
    upcoming: core.filterTasks(st.tasks, { view: 'upcoming' }, td).length, overdue: core.filterTasks(st.tasks, { view: 'overdue' }, td).length,
    done: st.tasks.filter(t => t.done).length };
  Object.entries(counts).forEach(([k, n]) => { const c = $(`#view-${k} .count`); if (c) c.textContent = n; });
  updateTabBadge();
}

async function deleteTask(id) {
  const t = taskById(id);
  if (!t) return;
  const ok = await confirmDialog({ title: 'Delete task?', body: `“${esc(t.title)}” and its photos will be permanently deleted.`, confirm: 'Delete', danger: true });
  if (!ok) return;
  S.state.tasks = S.state.tasks.filter(x => x.id !== id);
  for (const pid of t.photoIds || []) { await db.del('photos', pid); S.photoUrls.delete(pid); }
  save();
  go('#/tasks', true);
  toast('Task deleted.');
}

function onTaskSubmit(form) {
  const fd = new FormData(form);
  const input = {
    title: (fd.get('title') || '').trim(), moduleId: fd.get('moduleId') || '', type: fd.get('type') || 'assignment',
    due: fd.get('due') || '', dueTime: fd.get('dueTime') || '', priority: fd.get('priority') || 'medium', notes: (fd.get('notes') || '').trim(),
  };
  const { valid, errors } = core.validateTask(input, today());
  if (!valid) return showErrors(form, errors);
  const id = form.dataset.id;
  if (id) {
    const t = taskById(id);
    if (t.due !== input.due || t.dueTime !== input.dueTime) delete S.state.notified[id];
    Object.assign(t, input, { updatedAt: Date.now() });
    save();
    go(`#/task/${id}`, true);
    toast('Changes saved.');
  } else {
    const t = { id: core.createId('t'), ...input, subtasks: [], photoIds: [], done: false, completedAt: null, createdAt: Date.now() };
    S.state.tasks.push(t);
    save();
    haptic(10);
    if (S.stack.length > 1) history.back(); else go('#/tasks', true);
    toast('Task added.', { action: 'View', onAction: () => go(`#/task/${t.id}`) });
  }
}

function onModuleSubmit(form) {
  const fd = new FormData(form);
  const id = form.dataset.id || null;
  const input = { code: (fd.get('code') || '').trim().toUpperCase(), name: (fd.get('name') || '').trim(), colour: fd.get('colour') || core.MODULE_COLOURS[0] };
  const { valid, errors } = core.validateModule(input, S.state.modules, id);
  if (!valid) return showErrors(form, errors);
  if (id) Object.assign(moduleById(id), input);
  else S.state.modules.push({ id: core.createId('m'), ...input });
  save();
  go('#/modules', true);
  toast(id ? 'Module saved.' : `${input.code} added.`);
}

async function deleteModule(id) {
  const m = moduleById(id);
  const n = S.state.tasks.filter(t => t.moduleId === id).length;
  const ok = await confirmDialog({ title: `Delete ${esc(m.code)}?`, body: `Its weekly classes will be removed. ${n ? `${n} ${n === 1 ? 'task' : 'tasks'} will be kept without a module.` : ''}`, confirm: 'Delete', danger: true });
  if (!ok) return;
  S.state.modules = S.state.modules.filter(x => x.id !== id);
  S.state.classes = S.state.classes.filter(c => c.moduleId !== id);
  S.state.tasks.forEach(t => { if (t.moduleId === id) t.moduleId = ''; });
  if (S.ui.moduleId === id) S.ui.moduleId = '';
  save();
  go('#/modules', true);
  toast('Module deleted.');
}

function onClassSubmit(form) {
  const fd = new FormData(form);
  const id = form.dataset.id || null;
  const input = { moduleId: fd.get('moduleId'), kind: fd.get('kind'), day: Number(fd.get('day')), start: fd.get('start'), end: fd.get('end'), room: (fd.get('room') || '').trim() };
  const { valid, errors } = core.validateClass(input);
  if (!valid) return showErrors(form, errors);
  if (id) Object.assign(S.state.classes.find(c => c.id === id), input);
  else S.state.classes.push({ id: core.createId('c'), ...input });
  save();
  go('#/modules', true);
  toast(id ? 'Class saved.' : 'Class added to your timetable.');
}

/* ================================================================ photos */
async function compressImage(file, max = 1280, quality = 0.72) {
  let source, w, h;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = source.width; h = source.height;
  } catch {
    const url = URL.createObjectURL(file);
    source = await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('That file is not a supported image.')); img.src = url; });
    w = source.naturalWidth; h = source.naturalHeight;
    URL.revokeObjectURL(url);
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Could not process image.'))), 'image/jpeg', quality));
}

async function addPhoto(taskId, file) {
  const t = taskById(taskId);
  if (!t || !file) return;
  if (!file.type.startsWith('image/')) return toast('Please choose an image file.');
  if ((t.photoIds || []).length >= 12) return toast('A task can have up to 12 photos.');
  toast('Saving photo…');
  try {
    const blob = await compressImage(file);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const payload = await vaultCrypto.encryptBytes(S.key, bytes);
    const pid = core.createId('ph');
    await db.put('photos', pid, { ...payload, type: 'image/jpeg', at: Date.now() });
    S.photoUrls.set(pid, URL.createObjectURL(blob));
    t.photoIds = [...(t.photoIds || []), pid];
    save();
    refresh();
    toast(`Photo added (${Math.round(blob.size / 1024)} KB, encrypted).`);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not add photo.');
  }
}

async function photoUrl(pid) {
  if (S.photoUrls.has(pid)) return S.photoUrls.get(pid);
  if (!S.key) return null;
  try {
    const p = await db.get('photos', pid);
    if (!p) return null;
    const bytes = await vaultCrypto.decryptBytes(S.key, p);
    const url = URL.createObjectURL(new Blob([bytes], { type: p.type || 'image/jpeg' }));
    S.photoUrls.set(pid, url);
    return url;
  } catch (err) { console.error('[photo]', err); return null; }
}

async function viewPhoto(taskId, pid) {
  const url = await photoUrl(pid);
  const d = openDialog(`<div class="dialog-body"><h2 id="dialog-title">Photo</h2><img src="${url}" alt="Attached photo, full size">
    <div class="btn-row"><button type="button" class="btn btn-danger-ghost" id="ph-del">${icon('trash', { size: 18 })} Delete photo</button><button type="button" class="btn btn-primary" id="ph-close">Close</button></div></div>`, 'photo-dialog');
  $('#ph-close', d).onclick = closeDialog;
  $('#ph-del', d).onclick = async () => {
    closeDialog();
    if (!(await confirmDialog({ title: 'Delete photo?', body: 'This cannot be undone.', confirm: 'Delete', danger: true }))) return;
    const t = taskById(taskId);
    t.photoIds = t.photoIds.filter(x => x !== pid);
    await db.del('photos', pid);
    URL.revokeObjectURL(S.photoUrls.get(pid)); S.photoUrls.delete(pid);
    save(); refresh(); toast('Photo deleted.');
  };
}

/* ======================================================== weather + GPS */
async function loadWeather(force = false) {
  const st = S.state;
  if (!st) return;
  const place = st.settings.location || DEFAULT_PLACE;
  const c = st.cache.weather;
  const fresh = c && c.lat === place.lat && c.lon === place.lon && Date.now() - c.at < 30 * 60000;
  if (S.weather.status === 'loading' || (!force && (fresh || S.weather.status === 'locating' || Date.now() - (S.weather.lastTry || 0) < 60000))) return;
  S.weather.lastTry = Date.now();
  if (!navigator.onLine) { S.weather = { status: 'error', error: 'Offline – showing your last saved forecast.', lastTry: Date.now() }; if (!c) S.weather.error = 'You are offline. The forecast will load when you reconnect.'; refreshIf('today'); return; }
  S.weather = { status: 'loading', error: '', lastTry: Date.now() };
  refreshIf('today');
  try {
    const data = await api.getWeather(place.lat, place.lon);
    if (!S.state) return;
    S.state.cache.weather = { data, at: Date.now(), lat: place.lat, lon: place.lon };
    S.weather = { status: 'ok', error: '', lastTry: Date.now() };
    save();
  } catch (err) {
    console.warn('[weather]', err);
    S.weather = { status: 'error', error: `Couldn't update the forecast (${err.message}).`, lastTry: Date.now() };
  }
  refreshIf('today', 'calendar');
}

async function useGPS() {
  S.weather = { status: 'locating', error: '' };
  refreshIf('today');
  try {
    const pos = await api.getPosition();
    S.state.settings.location = { name: 'Your location', detail: '', lat: core.roundCoord(pos.lat), lon: core.roundCoord(pos.lon), source: 'gps' };
    S.weather.status = 'idle';
    save();
    toast('Location found – updating forecast.');
    await loadWeather(true);
  } catch (err) {
    S.weather = { status: S.state.cache.weather ? 'ok' : 'error', error: err.message };
    toast(err.message);
    refreshIf('today');
  }
}

function searchCityDialog() {
  const d = openDialog(`<form class="dialog-body" id="city-form" novalidate>
      <h2 id="dialog-title">Choose a city</h2>
      <div class="field"><label for="city-q">City or town</label>
        <input id="city-q" class="input" type="search" autocomplete="address-level2" placeholder="e.g. Dundee" enterkeyhint="search" required></div>
      <p class="small muted" id="city-status" role="status"></p>
      <ul class="place-results" id="city-results"></ul>
      <div class="btn-row"><button type="button" class="btn btn-ghost" id="city-cancel">Cancel</button><button type="submit" class="btn btn-primary">Search</button></div>
    </form>`);
  const q = $('#city-q', d), status = $('#city-status', d), results = $('#city-results', d);
  q.focus();
  $('#city-cancel', d).onclick = closeDialog;
  $('#city-form', d).onsubmit = async e => {
    e.preventDefault();
    if (q.value.trim().length < 2) { status.textContent = 'Type at least two letters.'; return; }
    status.textContent = 'Searching…'; results.innerHTML = '';
    try {
      const places = await api.searchPlace(q.value);
      status.textContent = places.length ? `${places.length} ${places.length === 1 ? 'result' : 'results'}` : 'No places found – check the spelling.';
      results.innerHTML = places.map((p, i) => `<li><button type="button" data-i="${i}"><strong>${esc(p.name)}</strong> <span class="muted small">${esc(p.detail)}</span></button></li>`).join('');
      $$('button', results).forEach(b => b.onclick = () => {
        const p = places[Number(b.dataset.i)];
        S.state.settings.location = { name: p.name, detail: p.detail, lat: core.roundCoord(p.lat), lon: core.roundCoord(p.lon), source: 'search' };
        save(); closeDialog();
        toast(`Weather set to ${p.name}.`);
        loadWeather(true);
        refreshIf('more');
      });
    } catch (err) { status.textContent = `Search failed: ${err.message}`; }
  };
}

async function loadHolidays(force = false) {
  const st = S.state;
  if (!st || S.holidayStatus === 'loading') return;
  const c = st.cache.holidays;
  if (!force && c && c.region === st.settings.region && Date.now() - c.at < 7 * 86400000) return;
  if (!force && Date.now() - (S.holidayTry || 0) < 60000) return;
  S.holidayTry = Date.now();
  if (!navigator.onLine) return;
  S.holidayStatus = 'loading';
  try {
    const list = await api.getBankHolidays(st.settings.region);
    if (!S.state) return;
    S.state.cache.holidays = { region: st.settings.region, list, at: Date.now() };
    save();
    refreshIf('today', 'calendar');
  } catch (err) { console.warn('[holidays]', err); } finally { S.holidayStatus = 'idle'; }
}

/* ========================================================= notifications */
async function swReg() { try { return await navigator.serviceWorker?.getRegistration(); } catch { return null; } }

async function notifyUser(title, body, data = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !S.state?.settings.notifications) return;
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: data.tag || title, data };
  const reg = await swReg();
  try { if (reg) await reg.showNotification(title, opts); else new Notification(title, opts); } catch (err) { console.warn('[notify]', err); }
}

async function checkReminders() {
  const st = S.state;
  if (!st?.settings.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  const due = core.tasksToNotify(st.tasks, st.notified, Date.now());
  for (const t of due) {
    const label = core.dueLabel(t, today());
    if (st.settings.privateNotifications) await notifyUser('StudyFlow reminder', 'You have a task due soon.', { tag: t.id, url: `#/task/${t.id}` });
    else await notifyUser(t.title, label, { tag: t.id, url: `#/task/${t.id}` });
    st.notified[t.id] = t.due;
  }
  if (due.length) save();
}

async function toggleNotifications(el) {
  const st = S.state;
  if (el.checked) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { el.checked = false; st.settings.notifications = false; toast('Notifications were not allowed.'); refresh(); return; }
    st.settings.notifications = true;
    save();
    toast('Deadline reminders are on.');
    checkReminders();
  } else { st.settings.notifications = false; save(); }
}

function updateBadge() {
  if (!S.state) return;
  const td = today();
  const n = S.state.tasks.filter(t => !t.done && t.due && t.due <= td).length;
  try { if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch { /* unsupported */ }
}
function updateTabBadge() {
  const tab = $('#tabbar [data-tab="tasks"]');
  if (!tab) return;
  $('.tab-badge', tab)?.remove();
  if (!S.state) return;
  const n = core.filterTasks(S.state.tasks, { view: 'overdue' }, today()).length;
  if (n) tab.insertAdjacentHTML('beforeend', `<span class="tab-badge" aria-hidden="true">${n}</span>`);
  tab.setAttribute('aria-label', n ? `Tasks, ${n} overdue` : 'Tasks');
}

/* ======================================================== backup / erase */
async function exportBackup() {
  await flush();
  const photos = {};
  for (const id of await db.keys('photos')) photos[id] = await db.get('photos', id);
  const payload = JSON.stringify({ app: 'StudyFlow', format: 1, exportedAt: new Date().toISOString(), vault: S.vault, photos });
  const name = `studyflow-backup-${today()}.json`;
  const file = new File([payload], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: 'StudyFlow backup' }); toast('Backup shared.'); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Encrypted backup downloaded.');
}

async function importBackup(file) {
  try {
    const json = JSON.parse(await file.text());
    if (json.app !== 'StudyFlow' || !json.vault?.salt || !json.vault?.data) throw new Error('This is not a StudyFlow backup file.');
    const pw = await passwordDialog({ title: 'Restore backup', body: `Enter the password that was used when this backup was made (${json.exportedAt?.slice(0, 10) || 'unknown date'}).` });
    if (!pw) return;
    const { key, state } = await vaultCrypto.openVault(pw, json.vault);
    const ok = await confirmDialog({ title: 'Replace data on this device?', body: `The backup has ${state.tasks?.length || 0} tasks. Everything currently on this device will be replaced.`, confirm: 'Restore', danger: true });
    if (!ok) return;
    await db.wipeAll();
    await db.put('kv', 'vault', json.vault);
    for (const [id, p] of Object.entries(json.photos || {})) await db.put('photos', id, p);
    S.photoUrls.forEach(u => URL.revokeObjectURL(u)); S.photoUrls.clear();
    S.vault = json.vault; S.key = key; S.state = core.migrateState(state);
    onUnlocked();
    go('#/today', true);
    toast('Backup restored. Your password is now the backup’s password.');
  } catch (err) {
    toast(err.message === 'WRONG_PASSWORD' ? 'Wrong password for that backup.' : `Restore failed: ${err.message}`);
  }
}

async function deleteAll() {
  const ok = await confirmDialog({ title: 'Delete all data?', body: 'Every task, module, photo and setting will be erased from this device. This cannot be undone.', confirm: 'Delete everything', danger: true, requireText: 'DELETE' });
  if (!ok) return;
  await db.wipeAll();
  ['sf_prefs', 'sf_fail'].forEach(k => localStorage.removeItem(k));
  S.photoUrls.forEach(u => URL.revokeObjectURL(u)); S.photoUrls.clear();
  S.vault = null; S.key = null; S.state = null; S.timer = null;
  try { navigator.clearAppBadge?.(); } catch { /* ignore */ }
  applyPrefs({ textScale: 1, theme: 'system' });
  go('#/welcome', true);
  toast('All data deleted.');
}

async function forgotPassword() {
  const ok = await confirmDialog({ title: 'Forgot your password?', body: 'For your privacy, your password is never stored, so it cannot be recovered. You can restore an encrypted backup (if you know its password) or reset StudyFlow, which erases all data on this device.', confirm: 'Reset StudyFlow', danger: true, requireText: 'DELETE' });
  if (!ok) return;
  await db.wipeAll();
  localStorage.removeItem('sf_fail');
  S.vault = null;
  go('#/welcome', true);
  toast('StudyFlow has been reset.');
}

/* ================================================================ events */
const clickActions = {
  back: el => { if (S.stack.length > 1) history.back(); else go(el.dataset.fallback || '#/today', true); },
  lock: () => lock(),
  forgot: () => forgotPassword(),
  'toggle-pw': el => {
    const input = document.getElementById(el.dataset.target);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.setAttribute('aria-pressed', String(show));
    el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    el.innerHTML = icon(show ? 'eyeOff' : 'eye');
  },
  view: el => { S.ui.view = el.dataset.view; $$('[data-action="view"]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); renderTaskList(); },
  'set-view': el => { S.ui.view = el.dataset.view; S.ui.moduleId = ''; S.ui.query = ''; },
  'toggle-task-btn': el => toggleTask(el.dataset.id),
  'delete-task': el => deleteTask(el.dataset.id),
  'delete-sub': el => {
    const t = taskById(el.dataset.id);
    t.subtasks = t.subtasks.filter(s => s.id !== el.dataset.sub);
    save(); refresh(); announce('Step removed');
    $('#new-sub')?.focus();
  },
  'add-photo': el => {
    const input = $('#photo-input');
    if (el.dataset.capture === '1') input.setAttribute('capture', 'environment'); else input.removeAttribute('capture');
    input.dataset.task = el.dataset.id;
    input.value = '';
    input.click();
  },
  'view-photo': el => viewPhoto(el.dataset.id, el.dataset.photo),
  'focus-on': el => { S.ui.focusTask = el.dataset.id; },
  'new-on': el => { S.ui.newDue = el.dataset.date; },
  week: el => changeWeek(Number(el.dataset.dir)),
  'timer-toggle': () => { if (S.timer && !S.timer.paused) timerPause(); else timerStart(); refresh(); },
  'timer-reset': () => { S.timer = null; releaseWakeLock(); refresh(); announce('Timer reset'); },
  'timer-skip': () => timerComplete(true),
  'weather-gps': () => useGPS(),
  'weather-search': () => searchCityDialog(),
  'weather-refresh': () => { loadWeather(true); loadHolidays(true); },
  install: async () => {
    if (!S.installPrompt) return;
    S.installPrompt.prompt();
    const { outcome } = await S.installPrompt.userChoice;
    S.installPrompt = null;
    if (outcome === 'accepted') toast('Installing StudyFlow…');
    refreshIf('today', 'more');
  },
  'dismiss-install': () => { S.state.settings.installDismissed = true; save(); refresh(); },
  export: () => exportBackup(),
  import: () => { const i = $('#import-input'); i.value = ''; i.click(); },
  'delete-all': () => deleteAll(),
  'delete-module': el => deleteModule(el.dataset.id),
  'delete-class': async el => {
    if (!(await confirmDialog({ title: 'Delete class?', body: 'It will be removed from your weekly timetable.', confirm: 'Delete', danger: true }))) return;
    S.state.classes = S.state.classes.filter(c => c.id !== el.dataset.id); save(); go('#/modules', true); toast('Class deleted.');
  },
  'check-update': async () => {
    const reg = await swReg();
    if (!reg) return toast('Updates are handled by the browser.');
    await reg.update();
    toast(reg.waiting || reg.installing ? 'Update found – it will be ready shortly.' : 'You have the latest version.');
  },
};

function onSetting(el) {
  const key = el.dataset.setting;
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (['textScale'].includes(key)) value = Math.round(Number(value) * 10) / 10;
  if (['autoLockMin'].includes(key)) value = Number(value);
  S.state.settings[key] = value;
  save();
  if (['textScale', 'theme', 'contrast', 'reduceMotion'].includes(key)) { applyPrefs(S.state.settings); mirrorPrefs(); }
  if (key === 'region') loadHolidays(true);
  if (key === 'textScale') { refresh(); }
  if (key === 'haptics' && value) haptic(20);
}

function bindEvents() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'search') return;
    const fn = clickActions[el.dataset.action];
    if (fn) { if (el.tagName === 'BUTTON') e.preventDefault(); fn(el, e); }
  });

  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.setting && S.state) return onSetting(el);
    switch (el.dataset.action) {
      case 'toggle-task': return toggleTask(el.dataset.id);
      case 'toggle-sub': {
        const t = taskById(el.dataset.id), s = t.subtasks.find(x => x.id === el.dataset.sub);
        s.done = el.checked; save(); if (el.checked) haptic(8); refresh();
        const p = core.subtaskProgress(t);
        if (p && p.done === p.total && !t.done) toast('All steps done!', { action: 'Complete task', onAction: () => toggleTask(t.id) });
        return;
      }
      case 'filter-module': S.ui.moduleId = el.value; return renderTaskList();
      case 'sort': S.ui.sort = el.value; return renderTaskList();
      case 'focus-task': S.ui.focusTask = el.value; return;
      case 'focus-len': S.state.settings.focusMin = Number(el.value); save(); return refresh();
      case 'break-len': S.state.settings.breakMin = Number(el.value); save(); return;
      case 'toggle-notifications': return toggleNotifications(el);
      default:
    }
    if (el.id === 'photo-input' && el.files[0]) addPhoto(el.dataset.task, el.files[0]);
    if (el.id === 'import-input' && el.files[0]) importBackup(el.files[0]);
  });

  let searchT;
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.action === 'search') {
      clearTimeout(searchT);
      searchT = setTimeout(() => { S.ui.query = el.value; renderTaskList(); }, 150); // debounce
    }
    if (el.id === 'f-password' && $('#pw-strength')) {
      const s = core.passwordStrength(el.value);
      $('#pw-strength').dataset.level = el.value ? s.level : '';
      $('#pw-strength-text').textContent = el.value ? `Password strength: ${s.level}` : '';
    }
    if (el.dataset.setting === 'textScale') {
      el.setAttribute('aria-valuetext', `${Math.round(el.value * 100)} percent`);
      document.documentElement.style.fontSize = `${el.value * 100}%`; // live preview while dragging
    }
    if (el.getAttribute('aria-invalid') === 'true') { el.removeAttribute('aria-invalid'); const err = $(`#err-${el.name}`); if (err) err.textContent = ''; }
  });

  document.addEventListener('submit', e => {
    const form = e.target;
    const kind = form.dataset.form;
    if (!kind) return;
    e.preventDefault();
    ({
      signup: onSignup, unlock: onUnlock, task: onTaskSubmit, module: onModuleSubmit, class: onClassSubmit, password: onChangePassword,
      subtask: f => {
        const text = new FormData(f).get('text').trim();
        if (!text) return;
        taskById(f.dataset.id).subtasks.push({ id: core.createId('s'), text: text.slice(0, 120), done: false });
        save(); refresh(); $('#new-sub')?.focus(); announce(`Step added: ${text}`);
      },
    })[kind]?.(form);
  });

  // close dialog by tapping the backdrop
  $('#dialog').addEventListener('click', e => { if (e.target.id === 'dialog') closeDialog(); });

  // activity tracking for auto-lock
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(t => addEventListener(t, () => { S.lastActive = Date.now(); }, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { S.hiddenAt = Date.now(); flush(); }
    else {
      if (S.key && S.hiddenAt && !S.timer && Date.now() - S.hiddenAt > S.state.settings.autoLockMin * 60000) lock('Locked while you were away.');
      S.hiddenAt = null;
      if (S.timer && !S.timer.paused) { requestWakeLock(); tickTimer(); }
      if (S.key) { updateBadge(); refreshIf('today'); }
    }
  });
  addEventListener('pagehide', () => flush());

  addEventListener('online', () => { setOffline(false); if (S.key) { loadWeather(true); loadHolidays(); } toast('Back online.'); });
  addEventListener('offline', () => setOffline(true));
  addEventListener('hashchange', route);
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installPrompt = e; refreshIf('today', 'more'); });
  addEventListener('appinstalled', () => { S.installPrompt = null; toast('StudyFlow installed – find it on your home screen.'); refreshIf('today', 'more'); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => S.state && applyPrefs(S.state.settings));

  // timers: focus clock (fast) and housekeeping (slow)
  setInterval(tickTimer, 500);
  setInterval(() => {
    if (!S.key) return;
    if (!S.timer && Date.now() - S.lastActive > S.state.settings.autoLockMin * 60000) { lock('Locked after inactivity.'); return; }
    checkReminders();
  }, 15000);
}

function setOffline(off) {
  $('#offline-banner').hidden = !off;
  document.documentElement.classList.toggle('offline', off);
}

/* ======================================================= service worker */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('service-worker.js').then(reg => {
    console.log('Service Worker registered', reg.scope);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version of StudyFlow is ready.', { action: 'Update', timeout: 10000, onAction: () => { S.updateRequested = true; nw.postMessage({ type: 'SKIP_WAITING' }); } });
        }
      });
    });
  }).catch(err => console.warn('Service Worker registration failed', err));
  // Only reload when the user accepted an update. (Bug fix: on the very first visit clients.claim()
  // also fires controllerchange, which used to reload the page and lock a user who had just signed up.)
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (reloaded || !S.updateRequested) return; reloaded = true;
    await flush();
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'OPEN' && e.data.url) location.hash = e.data.url;
  });
}

/* ================================================================= boot */
async function boot() {
  $$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  bindEvents();
  setOffline(!navigator.onLine);
  registerSW();
  try {
    if (!globalThis.crypto?.subtle) throw new Error('This browser cannot encrypt data here. Open StudyFlow over HTTPS (or localhost).');
    S.vault = await db.get('kv', 'vault') || null;
  } catch (err) {
    main().innerHTML = `<section class="auth"><h1 tabindex="-1">StudyFlow can't start</h1><p class="alert">${esc(err.message || 'Local storage is unavailable (private browsing may block it).')}</p></section>`;
    return;
  }
  // deep link from a notification: ?open=#/task/123
  const open = new URLSearchParams(location.search).get('open');
  if (open) { history.replaceState(null, '', `${location.pathname}${open}`); }
  route();
}

boot();

// version visible in the DevTools console (no data is exposed)
window.StudyFlow = { version: APP_VERSION };
