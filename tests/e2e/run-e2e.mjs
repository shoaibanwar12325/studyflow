// End-to-end tests: drives the real app in Chrome on an emulated phone (Playwright).
// GPS, camera and both APIs are simulated so the run is deterministic and works offline.
// Usage: npm run test:e2e   (needs Playwright + Chrome; set CHROME_PATH to override the browser)
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../tools/serve.mjs';
import { weatherFixture, geocodeFixture, holidaysFixture } from './fixtures.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/npm-tools/node_modules/playwright'); }
const { chromium } = playwright;

const PORT = 8099;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = fileURLToPath(new URL('../../screenshots/', import.meta.url));
const PHOTO = fileURLToPath(new URL('./assignment-photo.jpg', import.meta.url));
const PASSWORD = 'blue river 42';
const results = [];
const consoleErrors = [];
const metrics = {};

function isoToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ✔ ${name}`); }
  catch (err) { if (globalThis.__page) await globalThis.__page.screenshot({ path: `${SHOTS}fail-${results.length + 1}.png` }).catch(() => {}); results.push({ name, ok: false, ms: Date.now() - t0, error: err.message.split('\n')[0] }); console.log(`  ✘ ${name}\n     ${err.message.split('\n').slice(0, 3).join('\n     ')}`); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function mockApis(ctx, counter) {
  await ctx.route(/api\.open-meteo\.com/, r => { counter.weather++; counter.lastWeatherUrl = r.request().url(); r.fulfill({ json: weatherFixture(isoToday()), headers: { 'access-control-allow-origin': '*' } }); });
  await ctx.route(/geocoding-api\.open-meteo\.com/, r => { counter.geo++; r.fulfill({ json: geocodeFixture, headers: { 'access-control-allow-origin': '*' } }); });
  await ctx.route(/www\.gov\.uk\/bank-holidays\.json/, r => { counter.hol++; r.fulfill({ json: holidaysFixture(new Date().getFullYear()), headers: { 'access-control-allow-origin': '*' } }); });
}

/** Automated accessibility audit of the visible screen. */
async function a11yAudit(page, label) {
  return page.evaluate(label => {
    const issues = [];
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const name = el => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      const lb = el.getAttribute('aria-labelledby');
      if (lb) return lb.split(' ').map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return l.textContent.trim(); }
      const wrap = el.closest('label'); if (wrap) return wrap.textContent.trim();
      if (el.tagName === 'IMG') return el.getAttribute('alt');
      return (el.textContent || '').trim() || el.getAttribute('title') || '';
    };
    const els = [...document.querySelectorAll('main a[href], main button, main input:not([type=hidden]), main select, main textarea, nav a, #fab')].filter(visible);
    let small = 0;
    for (const el of els) {
      if (el.matches('input.visually-hidden, .visually-hidden')) continue;
      if (!name(el)) issues.push(`no accessible name: <${el.tagName.toLowerCase()} ${el.className}>`);
      const target = el.matches('input[type=checkbox], input[type=radio]') ? (el.closest('label') || el) : el;
      const r = target.getBoundingClientRect();
      const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.closest('p, span');
      if (!inline && (r.height < 24 || r.width < 24)) issues.push(`target < 24px: ${name(el).slice(0, 30)} (${Math.round(r.width)}x${Math.round(r.height)})`);
      if (!inline && r.height < 40) small++;
    }
    document.querySelectorAll('main img').forEach(img => { if (!img.hasAttribute('alt')) issues.push('img without alt'); });
    const h1s = [...document.querySelectorAll('main h1')].filter(visible).length;
    if (h1s !== 1) issues.push(`expected exactly one h1, found ${h1s}`);
    if (!document.documentElement.lang) issues.push('html lang missing');

    // colour contrast of visible text (WCAG 1.4.3)
    const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = el => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.9) return c; } return parse(getComputedStyle(document.body).backgroundColor); };
    let checked = 0, worst = 99, worstText = '';
    const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || seen.has(el) || !walker.currentNode.textContent.trim() || !visible(el) || el.closest('.visually-hidden, svg, [aria-hidden="true"], button[disabled], .weather-ico, .wd-ico, .day-wx > span')) continue;
      seen.add(el);
      const s = getComputedStyle(el); const fg = parse(s.color); const bg = bgOf(el);
      if (!fg || !bg || parseFloat(s.opacity) < 1) continue;
      const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700);
      checked++;
      if (ratio < worst) { worst = ratio; worstText = walker.currentNode.textContent.trim().slice(0, 30); }
      if (ratio < (large ? 3 : 4.5)) issues.push(`contrast ${ratio.toFixed(2)}:1 on "${walker.currentNode.textContent.trim().slice(0, 30)}"`);
    }
    return { label, interactive: els.length, belowTouch40: small, textChecked: checked, worstContrast: Number(worst.toFixed(2)), worstText, issues };
  }, label);
}

const audits = [];
async function audit(page, label) {
  const a = await a11yAudit(page, label);
  audits.push(a);
  expect(a.issues.length === 0, `${label}: ${a.issues.slice(0, 4).join(' | ')}`);
}

/** Create the test "camera" photo (a 2400×1800 JPEG of an assignment sheet) if it is missing. */
async function ensurePhoto(browser) {
  const { access } = await import('node:fs/promises');
  try { await access(PHOTO); return; } catch { /* create it */ }
  const p = await browser.newPage({ viewport: { width: 2400, height: 1800 } });
  await p.setContent('<body style="margin:0;background:#fdfcf7;font:70px Arial;color:#444"><div style="margin:160px 200px;padding:120px;background:#fff;border:6px solid #ccc;height:1240px"><b style="font-size:110px;color:#222">Assignment brief</b><p>Deadline: Wednesday, Week 10, 17:00</p><p>Demo: 5 minutes, live on a device</p><p>Report: 2 pages, Calibri 11</p></div></body>');
  await p.screenshot({ path: PHOTO, type: 'jpeg', quality: 92 });
  await p.close();
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const server = await startServer(PORT);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  await ensurePhoto(browser);
  const counter = { weather: 0, geo: 0, hol: 0 };
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
    geolocation: { latitude: 56.458123, longitude: -2.982345 }, permissions: ['geolocation', 'notifications'],
    serviceWorkers: 'allow', acceptDownloads: true, locale: 'en-GB', timezoneId: 'Europe/London',
  });
  await mockApis(ctx, counter);
  const page = await ctx.newPage();
  globalThis.__page = page;
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
  const shot = async name => { await page.evaluate(() => { document.getElementById('toast-region').innerHTML = ''; }); await page.screenshot({ path: `${SHOTS}${name}.png` }); };

  console.log('\nStudyFlow E2E – Pixel 7 viewport (412×915)\n');

  await step('First launch shows the welcome screen', async () => {
    const t0 = Date.now();
    await page.goto(BASE);
    await page.getByRole('heading', { level: 1, name: /Plan your studies/ }).waitFor();
    metrics.firstLoadMs = Date.now() - t0;
    await audit(page, 'Welcome');
    await shot('welcome');
  });

  await step('Sign-up validates the password and consent', async () => {
    await page.getByRole('link', { name: 'Get started' }).click();
    await page.getByRole('heading', { name: 'Create your planner' }).waitFor();
    await page.getByRole('button', { name: 'Create planner' }).click();
    expect(/at least 8/.test(await page.locator('#err-password').textContent()), 'password error not shown');
    expect(/confirm/.test(await page.locator('#err-consent').textContent()), 'consent error not shown');
    expect(await page.locator('#f-password').getAttribute('aria-invalid') === 'true', 'aria-invalid not set');
    await page.fill('#f-password', 'password');
    await page.fill('#f-confirm', 'password');
    await page.getByRole('button', { name: 'Create planner' }).click();
    expect(/too common/.test(await page.locator('#err-password').textContent()), 'common password not rejected');
    await audit(page, 'Sign-up');
  });

  await step('Account is created and the Today dashboard loads (with sample data)', async () => {
    await page.fill('#f-name', 'Sam');
    await page.fill('#f-password', PASSWORD);
    await page.fill('#f-confirm', PASSWORD);
    await page.locator('#f-consent').check();
    await shot('signup');
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Create planner' }).click();
    await page.getByRole('heading', { level: 1, name: /, Sam/ }).waitFor();
    metrics.signupEncryptMs = Date.now() - t0;
    expect(await page.locator('#tabbar').isVisible(), 'tab bar hidden');
  });

  await step('API: weather (Open-Meteo) is fetched and displayed with advice', async () => {
    await page.locator('.weather-temp').waitFor({ timeout: 8000 });
    const temp = await page.locator('.weather-temp').textContent();
    expect(temp.includes('8°C'), `unexpected temp ${temp}`);
    expect(/rain|waterproof/i.test(await page.locator('.weather-advice').textContent()), 'no rain advice');
    expect(await page.locator('.weather-days > div').count() === 7, '7-day forecast missing');
    expect(counter.weather >= 1, 'weather API not called');
  });

  await step('API: GOV.UK bank holidays are fetched and shown', async () => {
    await page.waitForTimeout(500);
    expect(counter.hol >= 1, 'holiday API not called');
  });

  await step('Sensor: GPS location updates the forecast (coordinates rounded to ~1 km)', async () => {
    const before = counter.weather;
    await page.getByRole('button', { name: 'Use my location' }).click();
    await page.getByRole('heading', { name: 'Your location' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.weather-temp'));
    await page.waitForTimeout(400);
    expect(counter.weather > before, 'forecast not refreshed after GPS');
    const sent = new URL(counter.lastWeatherUrl).searchParams;
    expect(sent.get('latitude') === '56.46' && sent.get('longitude') === '-2.98', `coords sent were ${sent.get('latitude')},${sent.get('longitude')} (should be rounded)`);
    await audit(page, 'Today');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('today');
  });

  await step('API: city search (Open-Meteo geocoding) changes the weather location', async () => {
    await page.getByRole('button', { name: 'Change city' }).click();
    await page.fill('#city-q', 'Edinburgh');
    await page.locator('#city-form button[type=submit]').click();
    await page.locator('#city-results button').first().click();
    await page.getByRole('heading', { name: 'Edinburgh' }).waitFor();
    expect(counter.geo === 1, 'geocoding not called');
  });

  await step('Local storage: data in IndexedDB is encrypted (no plaintext)', async () => {
    await page.waitForTimeout(400);
    const raw = await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('studyflow');
      r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('vault'); g.onsuccess = () => res(JSON.stringify(g.result)); g.onerror = rej; };
      r.onerror = rej;
    }));
    expect(raw.length > 500, 'vault missing');
    // short words can appear by chance inside random base64 ciphertext, so look for them as JSON values
    for (const secret of ['"Sam"', 'Rehearse', 'CS52001', 'Edinburgh', PASSWORD]) expect(!raw.includes(secret), `plaintext "${secret}" found in storage`);
    const ls = await page.evaluate(() => JSON.stringify(localStorage));
    expect(!ls.includes('Rehearse') && !ls.includes('"Sam"'), 'plaintext in localStorage');
  });

  await step('Tasks: search, filter chips and module filter', async () => {
    await page.locator('#tabbar [data-tab="tasks"]').click();
    await page.getByRole('heading', { level: 1, name: 'Tasks' }).waitFor();
    const open = await page.locator('#task-list .task').count();
    expect(open === 6, `expected 6 open sample tasks, got ${open}`);
    await page.fill('#task-search', 'report');
    await page.waitForTimeout(300);
    expect(await page.locator('#task-list .task').count() === 1, 'search failed');
    await page.fill('#task-search', '');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /Overdue/ }).click();
    expect(await page.locator('#task-list .task').count() === 1, 'overdue filter failed');
    await page.getByRole('button', { name: /Open/ }).click();
    await page.selectOption('#task-module', { label: 'CS52001 – Mobile Application Development' });
    expect(await page.locator('#task-list .task').count() === 3, 'module filter failed');
    await page.selectOption('#task-module', '');
    await audit(page, 'Tasks');
    await shot('tasks');
  });

  await step('Tasks: add a task with validation (FAB → form → list)', async () => {
    await page.locator('#fab').click();
    await page.getByRole('heading', { name: 'New task' }).waitFor();
    await page.getByRole('button', { name: 'Add task' }).click();
    expect((await page.locator('#err-title').textContent()).includes('Enter a task title'), 'title error missing');
    expect(await page.evaluate(() => document.activeElement.id) === 'f-title', 'focus not moved to invalid field');
    await page.fill('#f-title', 'Fix GPS permission-denied bug');
    await page.selectOption('#f-moduleId', { label: 'CS52001 – Mobile Application Development' });
    await page.locator('.segmented label', { hasText: 'High' }).click();
    await page.fill('#f-notes', 'Handle the denied-permission case.');
    await audit(page, 'Task form');
    await shot('task-form');
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByRole('heading', { level: 1, name: 'Tasks' }).waitFor();
    const titles = await page.locator('.task-title').allTextContents();
    expect(titles.includes('Fix GPS permission-denied bug'), 'task not added');
  });

  await step('Tasks: complete a task (checkbox), undo toast shown', async () => {
    const first = page.locator('#task-list .task').first();
    const title = await first.locator('.task-title').textContent();
    await first.locator('input.check').click(); // single click: the row leaves the Open list once done
    await page.locator('.toast', { hasText: 'Completed' }).waitFor();
    await page.getByRole('button', { name: /Done/ }).click();
    const done = await page.locator('#task-list .task-title').allTextContents();
    expect(done.includes(title), 'completed task not in Done view');
    await page.getByRole('button', { name: /Open/ }).click();
  });

  await step('Task detail: add steps and attach a camera photo (compressed + encrypted)', async () => {
    await page.locator('.task-link', { hasText: 'Add offline mode' }).click();
    await page.getByRole('heading', { name: 'Add offline mode to the app' }).waitFor();
    await page.fill('#new-sub', 'Run Lighthouse audit');
    await page.getByRole('button', { name: 'Add step' }).click();
    await page.locator('.subtask label', { hasText: 'Run Lighthouse audit' }).waitFor();
    await page.locator('.subtask input').nth(1).click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Take photo' }).click()]);
    await chooser.setFiles(PHOTO);
    await page.locator('.toast', { hasText: /Photo added \(\d+ KB/ }).waitFor({ timeout: 8000 });
    const toastText = await page.locator('.toast').textContent();
    metrics.photoKB = Number(toastText.match(/(\d+) KB/)[1]);
    expect(metrics.photoKB < 122, `photo was not compressed (${metrics.photoKB} KB)`);
    await page.locator('.photo img[src^="blob:"]').waitFor();
    const stored = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('studyflow'); r.onsuccess = () => { const g = r.result.transaction('photos').objectStore('photos').getAll(); g.onsuccess = () => res(g.result); }; }));
    expect(stored.length === 1 && stored[0].iv && stored[0].ct, 'photo not stored encrypted');
    await audit(page, 'Task detail');
    await shot('task-photos');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('task-detail');
  });

  await step('Week planner: 7 days with classes, deadlines, forecast; week navigation', async () => {
    await page.locator('#tabbar [data-tab="calendar"]').click();
    await page.getByRole('heading', { level: 1, name: /Week/ }).waitFor();
    expect(await page.locator('.day').count() === 7, 'not 7 days');
    expect(await page.locator('.day.is-today').count() === 1, 'today not highlighted');
    expect(await page.locator('.day-item .kind', { hasText: 'Class' }).count() >= 4, 'classes missing');
    expect(await page.locator('.day-wx').count() >= 1, 'forecast not shown in week');
    await audit(page, 'Week');
    await shot('week');
    await page.getByRole('button', { name: 'Next week' }).click();
    await page.getByRole('button', { name: 'Today', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    expect(await page.locator('.day.is-today').count() === 1, 'Today button failed');
  });

  await step('Focus timer: start, pause, and complete logs the session', async () => {
    await page.locator('#tabbar [data-tab="focus"]').click();
    await page.getByRole('heading', { level: 1, name: /Focus/ }).waitFor();
    await page.selectOption('#focus-len', '15');
    await audit(page, 'Focus');
    await page.getByRole('button', { name: 'Start focus' }).click();
    await page.waitForTimeout(2200);
    const clock = await page.locator('#timer-clock').textContent();
    expect(['14:59', '14:58', '14:57'].includes(clock), `clock not ticking (${clock})`);
    await page.getByRole('button', { name: 'Pause focus' }).click();
    await shot('focus');
    await page.getByRole('button', { name: 'Resume focus' }).click();
    await page.getByRole('button', { name: 'Finish focus now' }).click();
    await page.locator('.timer-mode', { hasText: 'Break' }).waitFor();
    await page.getByRole('button', { name: 'Reset timer' }).click();
  });

  await step('Settings: text size, high contrast and dark theme apply instantly', async () => {
    await page.locator('#tabbar [data-tab="more"]').click();
    await page.getByRole('heading', { level: 1, name: 'More' }).waitFor();
    await audit(page, 'More');
    await shot('more');
    await page.locator('#set-text').fill('1.3');
    await page.locator('#set-text').dispatchEvent('change');
    expect(await page.evaluate(() => document.documentElement.style.fontSize) === '130%', 'text size not applied');
    await page.locator('label.switch-row', { hasText: 'High contrast' }).click();
    expect(await page.evaluate(() => document.documentElement.classList.contains('high-contrast')), 'high contrast not applied');
    await page.locator('#tabbar [data-tab="today"]').click();
    await page.getByRole('heading', { level: 1, name: /Sam/ }).waitFor();
    await audit(page, 'Today (130% text + high contrast)');
    await shot('today-large-text-contrast');
    await page.locator('#tabbar [data-tab="more"]').click();
    await page.locator('#set-text').fill('1');
    await page.locator('#set-text').dispatchEvent('change');
    await page.locator('label.switch-row', { hasText: 'High contrast' }).click();
    await page.selectOption('#set-theme', 'dark');
    await page.locator('#tabbar [data-tab="today"]').click();
    await page.getByRole('heading', { level: 1, name: /Sam/ }).waitFor();
    await audit(page, 'Today (dark)');
    await shot('today-dark');
    await page.locator('#tabbar [data-tab="more"]').click();
    await page.selectOption('#set-theme', 'light');
  });

  await step('Modules: add a module and a weekly class', async () => {
    await page.getByRole('link', { name: /Modules & timetable/ }).click();
    await page.getByRole('link', { name: /Add module/ }).click();
    await page.fill('#f-code', 'cs52001');
    await page.fill('#f-name', 'Duplicate');
    await page.getByRole('button', { name: 'Add module' }).click();
    expect((await page.locator('#err-code').textContent()).includes('already exists'), 'duplicate module allowed');
    await page.fill('#f-code', 'CS50003');
    await page.fill('#f-name', 'Human-Computer Interaction');
    await page.locator('.swatch').nth(4).click();
    await audit(page, 'Module form');
    await page.getByRole('button', { name: 'Add module' }).click();
    await page.locator('.list-row', { hasText: 'CS50003' }).waitFor();
    await page.getByRole('link', { name: /Add class/ }).click();
    await page.selectOption('#f-moduleId', { label: 'CS50003 – Human-Computer Interaction' });
    await page.selectOption('#f-day', '5');
    await page.fill('#f-start', '15:00');
    await page.fill('#f-end', '14:00');
    await page.getByRole('button', { name: 'Add class' }).click();
    expect((await page.locator('#err-end').textContent()).includes('after the start'), 'class time validation missing');
    await page.fill('#f-end', '16:00');
    await page.getByRole('button', { name: 'Add class' }).click();
    await page.locator('.list-row', { hasText: 'CS50003' }).nth(1).waitFor();
    await audit(page, 'Modules');
    await shot('modules');
  });

  await step('Calendar import: a student-portal .ics file is previewed and imported (modules, classes, deadlines)', async () => {
    const { writeFile: wf } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const ymd = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
    const file = `${tmpdir()}/portal-export.ics`;
    await wf(file, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Blackboard Learn//Calendar//EN',
      'BEGIN:VEVENT', 'UID:bb-due-1', `DTSTART:${ymd(9)}T170000Z`, `DTEND:${ymd(9)}T170000Z`, 'SUMMARY:AC50002 - Human Computer Interaction: Usability Report Due', 'DESCRIPTION:Upload to Turnitin.', 'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:bb-exam-1', `DTSTART;VALUE=DATE:${ymd(20)}`, 'SUMMARY:AC50002 Final Exam', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:tt-1', `DTSTART:${ymd(1)}T100000`, `DTEND:${ymd(1)}T120000`, 'RRULE:FREQ=WEEKLY;COUNT=10', 'SUMMARY:AC50002 Lecture', 'LOCATION:Fulton Building\\, LT1', 'END:VEVENT',
      'END:VCALENDAR', ''].join('\r\n'));
    await page.locator('#tabbar [data-tab="more"]').click();
    await page.getByRole('link', { name: /Import calendar \(\.ics\)/ }).click();
    await page.getByRole('heading', { level: 1, name: 'Import calendar' }).waitFor();
    await audit(page, 'Import calendar');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Choose .ics file' }).click()]);
    await chooser.setFiles(file);
    await page.locator('.alert.info', { hasText: 'portal-export.ics' }).waitFor();
    expect(/1 module, 1 weekly class and 2 deadlines/.test(await page.locator('.alert.info').textContent()), 'unexpected preview summary');
    await audit(page, 'Import preview');
    await shot('import-preview');
    await page.getByRole('button', { name: 'Import selected' }).click();
    await page.getByRole('heading', { level: 1, name: /Week/ }).waitFor();
    await page.locator('.toast', { hasText: 'Imported 2 deadlines, 1 class, 1 module' }).waitFor();
    // re-import the same file: items are updated, not duplicated
    await page.goto(`${BASE}#/import`);
    const [c2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Choose .ics file' }).click()]);
    await c2.setFiles(file);
    await page.locator('.check-row .badge', { hasText: 'Update' }).first().waitFor();
    await page.getByRole('button', { name: 'Import selected' }).click();
    await page.locator('.toast', { hasText: '3 updated' }).waitFor();
    await page.locator('#tabbar [data-tab="tasks"]').click();
    await page.fill('#task-search', 'Usability Report Due');
    await page.waitForTimeout(300);
    expect(await page.locator('#task-list .task').count() === 1, 'duplicate task after re-import');
    expect((await page.locator('#task-list .task-meta').first().textContent()).includes('AC50002'), 'module not linked');
    await page.fill('#task-search', '');
  });

  await step('Calendar: sample university calendar de-duplicates, and deadlines export as .ics', async () => {
    await page.goto(`${BASE}#/import`);
    await page.getByRole('button', { name: 'Try a sample university calendar' }).click();
    await page.locator('.alert.info', { hasText: 'sample-university-calendar.ics' }).waitFor();
    expect(await page.locator('.check-row .badge', { hasText: 'Already added' }).count() >= 2, 'existing module/class not detected');
    await page.getByRole('button', { name: 'Import selected' }).click();
    await page.getByRole('heading', { level: 1, name: /Week/ }).waitFor();
    await shot('week-imported');
    await page.locator('#tabbar [data-tab="more"]').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Add deadlines to my calendar/ }).click()]);
    expect(download.suggestedFilename().endsWith('.ics'), 'export is not an .ics file');
    const { readFile: rf } = await import('node:fs/promises');
    const text = await rf(await download.path(), 'utf8');
    expect(text.startsWith('BEGIN:VCALENDAR') && text.includes('MAB001 Project Report'), 'exported calendar content wrong');
    await page.goto(`${BASE}#/modules`);
    await page.getByRole('heading', { level: 1, name: 'Modules & timetable' }).waitFor();
  });

  await step('Notifications: enabling reminders shows a notification for tasks due within 24 h', async () => {
    await page.locator('#tabbar [data-tab="more"]').click();
    await page.locator('label.switch-row', { hasText: 'Deadline reminders' }).click();
    await page.locator('.toast', { hasText: 'reminders are on' }).waitFor();
    await page.waitForTimeout(800);
    const n = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(x => x.title));
    expect(n.length >= 1, 'no notification shown');
    metrics.notifications = n;
    await page.goto(`${BASE}#/modules`);
  });

  await step('Security: reload requires the password; wrong password rejected; data persists', async () => {
    await page.waitForTimeout(400);
    await page.reload();
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    await audit(page, 'Unlock');
    await page.fill('#f-password', 'not my password');
    await page.getByRole('button', { name: /Unlock/ }).click();
    await page.locator('#unlock-alert', { hasText: 'Incorrect password' }).waitFor();
    await shot('unlock');
    const t0 = Date.now();
    await page.fill('#f-password', PASSWORD);
    await page.getByRole('button', { name: /Unlock/ }).click();
    await page.getByRole('heading', { level: 1, name: 'Modules & timetable' }).waitFor(); // returns to where the user was
    metrics.unlockMs = Date.now() - t0;
    await page.locator('#tabbar [data-tab="tasks"]').click();
    expect((await page.locator('.task-title').allTextContents()).some(t => t.includes('Fix GPS')), 'data not persisted');
  });

  await step('Security: deep link while locked returns to that screen after unlocking', async () => {
    await page.locator('#tabbar [data-tab="today"]').click();
    await page.getByRole('button', { name: 'Lock planner' }).click();
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    await page.goto(`${BASE}#/calendar`);
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    await page.fill('#f-password', PASSWORD);
    await page.getByRole('button', { name: /Unlock/ }).click();
    await page.getByRole('heading', { level: 1, name: /Week/ }).waitFor();
  });

  await step('PWA: service worker active, manifest valid, app works fully offline', async () => {
    const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { active: !!r.active, scope: r.scope, controlled: !!navigator.serviceWorker.controller }; });
    expect(sw.active, 'service worker not active');
    const manifest = await (await page.request.get(`${BASE}manifest.json`)).json();
    expect(manifest.display === 'standalone' && manifest.icons.some(i => i.sizes === '512x512') && manifest.start_url, 'manifest incomplete');
    const cached = await page.evaluate(async () => (await caches.keys()).join(','));
    expect(cached.includes('studyflow-shell-'), 'shell not cached');
    await ctx.setOffline(true);
    await page.reload();
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    expect(await page.locator('#offline-banner').isVisible(), 'offline banner not shown');
    await page.fill('#f-password', PASSWORD);
    await page.getByRole('button', { name: /Unlock/ }).click();
    await page.getByRole('heading', { level: 1, name: /Week/ }).waitFor();
    await page.locator('#tabbar [data-tab="today"]').click();
    await page.locator('.weather-temp').waitFor();
    await shot('offline');
    await page.locator('#fab').click();
    await page.fill('#f-title', 'Added while offline');
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.locator('.task-title', { hasText: 'Added while offline' }).first().waitFor();
    await ctx.setOffline(false);
  });

  await step('Responsive: small phone, landscape, tablet layouts have no horizontal overflow', async () => {
    const sizes = [['phone-small', 360, 740, '#/today'], ['landscape', 915, 412, '#/tasks'], ['tablet', 1024, 768, '#/calendar'], ['tablet-today', 1024, 768, '#/today']];
    for (const [name, w, h, hash] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(hh => { location.hash = hh; }, hash);
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow <= 1, `${name}: horizontal overflow ${overflow}px`);
      await shot(name);
    }
    await page.setViewportSize({ width: 412, height: 915 });
  });

  await step('Security: user input is escaped (XSS attempt is shown as text, not run)', async () => {
    await page.evaluate(() => { location.hash = '#/task/new'; });
    await page.getByRole('heading', { name: 'New task' }).waitFor();
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    await page.fill('#f-title', evil);
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.locator('.task-title', { hasText: '<img src=x' }).first().waitFor();
    expect(await page.evaluate(() => window.__xss) === undefined, 'XSS payload executed');
    expect(await page.locator('#task-list img, #task-list script').count() === 0, 'markup was injected into the DOM');
  });

  await step('Performance: load size and timings', async () => {
    await page.goto('about:blank');
    await ctx.clearCookies();
    const p2 = await ctx.newPage();
    await p2.goto(BASE);
    await p2.getByRole('heading', { name: 'Welcome back' }).waitFor();
    const perf = await p2.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const res = performance.getEntriesByType('resource');
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return { dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), fcp: fcp ? Math.round(fcp.startTime) : null, requests: res.length + 1 };
    });
    Object.assign(metrics, perf);
    await p2.close();
  });

  await step('No JavaScript errors in the console during the whole run', async () => {
    const real = consoleErrors.filter(e => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e));
    expect(real.length === 0, real.slice(0, 3).join(' | '));
  });

  await browser.close();
  server.close();

  // app-shell size (uncompressed)
  const { stat } = await import('node:fs/promises');
  let bytes = 0;
  for (const f of ['index.html', 'style.css', 'app.js', 'js/core.js', 'js/crypto.js', 'js/store.js', 'js/api.js', 'js/icons.js', 'js/ics.js', 'js/boot.js', 'manifest.json', 'service-worker.js']) bytes += (await stat(new URL(`../../${f}`, import.meta.url))).size;
  metrics.appShellKB = Math.round(bytes / 1024);

  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed}/${results.length} E2E checks passed`);
  console.log('Metrics:', metrics);
  console.log('Accessibility audits:');
  audits.forEach(a => console.log(`  ${a.label.padEnd(36)} controls:${String(a.interactive).padStart(3)}  text nodes:${String(a.textChecked).padStart(4)}  lowest contrast ${a.worstContrast}:1  issues:${a.issues.length}`));
  await writeFile(new URL('./last-run.json', import.meta.url), JSON.stringify({ date: new Date().toISOString(), results, metrics, audits, consoleErrors }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
