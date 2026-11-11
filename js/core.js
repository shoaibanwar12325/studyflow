/**
 * StudyFlow – core.js
 * Pure, side-effect-free logic (dates, tasks, stats, validation, API parsing).
 * Kept free of DOM / browser APIs so it can be unit-tested with `node --test`.
 */

export const PRIORITIES = ['high', 'medium', 'low'];
export const TASK_TYPES = ['assignment', 'exam', 'reading', 'lab', 'revision', 'personal'];
export const MODULE_COLOURS = ['#3B4CCA', '#C2410C', '#047857', '#9D174D', '#6D28D9', '#0E7490', '#A16207', '#475569'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------------------------------------------------------------- ids */
export function createId(prefix = 'id') {
  const rnd = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(16).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

/* -------------------------------------------------------------- dates */
/** Local calendar date → 'YYYY-MM-DD' (never UTC, avoids the off-by-one-day bug). */
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' → local Date at midnight. Returns null for invalid input. */
export function parseISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

export function addDays(iso, n) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Whole days from a to b (b - a), DST-safe. */
export function daysBetween(aIso, bIso) {
  const a = parseISODate(aIso), b = parseISODate(bIso);
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86400000);
}

/** Monday of the week containing iso. */
export function startOfWeek(iso) {
  const d = parseISODate(iso);
  const shift = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(iso, -shift);
}

export function weekDates(iso) {
  const start = startOfWeek(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function formatDate(iso, { weekday = true } = {}) {
  const d = parseISODate(iso);
  if (!d) return '';
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return weekday ? `${DAY_SHORT[d.getDay()]} ${base}` : base;
}

export function formatLongDate(iso) {
  const d = parseISODate(iso);
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatMinutes(min) {
  if (!min) return '0 min';
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function greeting(hour) {
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/* -------------------------------------------------------------- tasks */
export function isOverdue(task, today) {
  return !task.done && !!task.due && task.due < today;
}

/** Human, screen-reader-friendly due label. */
export function dueLabel(task, today) {
  if (!task.due) return 'No due date';
  const diff = daysBetween(today, task.due);
  const time = task.dueTime ? ` at ${task.dueTime}` : '';
  if (task.done) return `Done · was due ${formatDate(task.due)}`;
  if (diff < -1) return `Overdue by ${-diff} days`;
  if (diff === -1) return 'Overdue by 1 day';
  if (diff === 0) return `Due today${time}`;
  if (diff === 1) return `Due tomorrow${time}`;
  if (diff < 7) return `Due in ${diff} days`;
  return `Due ${formatDate(task.due)}`;
}

/** Urgency bucket used for colour + text cues. */
export function urgency(task, today) {
  if (task.done) return 'done';
  if (!task.due) return 'none';
  const diff = daysBetween(today, task.due);
  if (diff < 0) return 'overdue';
  if (diff <= 1) return 'soon';
  if (diff <= 7) return 'week';
  return 'later';
}

export function subtaskProgress(task) {
  const subs = task.subtasks || [];
  if (!subs.length) return null;
  const done = subs.filter(s => s.done).length;
  return { done, total: subs.length, pct: Math.round((done / subs.length) * 100) };
}

/**
 * Filter tasks by view, module and free-text query.
 * view: all | today | upcoming | overdue | done
 */
export function filterTasks(tasks, { view = 'all', moduleId = '', query = '' } = {}, today) {
  const q = query.trim().toLowerCase();
  return tasks.filter(t => {
    if (moduleId && t.moduleId !== moduleId) return false;
    if (q && !(`${t.title} ${t.notes || ''}`.toLowerCase().includes(q))) return false;
    switch (view) {
      case 'today': return !t.done && !!t.due && t.due <= today;
      case 'upcoming': return !t.done && !!t.due && t.due > today && daysBetween(today, t.due) <= 7;
      case 'overdue': return isOverdue(t, today);
      case 'done': return t.done;
      case 'all':
      default: return !t.done;
    }
  });
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/** Stable sort. mode: due | priority | module | created */
export function sortTasks(tasks, mode = 'due', modules = []) {
  const modName = id => modules.find(m => m.id === id)?.code || '';
  const byModule = (a, b) => {
    const x = modName(a.moduleId), y = modName(b.moduleId);
    if (!x !== !y) return x ? -1 : 1; // tasks without a module go last
    return x.localeCompare(y);
  };
  const byDue = (a, b) => (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99')
    || (a.dueTime || '99:99').localeCompare(b.dueTime || '99:99');
  const byPrio = (a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
  const cmp = {
    due: (a, b) => byDue(a, b) || byPrio(a, b),
    priority: (a, b) => byPrio(a, b) || byDue(a, b),
    module: (a, b) => byModule(a, b) || byDue(a, b),
    created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  }[mode] || (() => 0);
  return tasks.map((t, i) => [t, i]).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map(x => x[0]);
}

export function tasksForDate(tasks, iso) {
  return tasks.filter(t => t.due === iso);
}

export function classesForDate(classes, iso) {
  const day = parseISODate(iso).getDay();
  return classes.filter(c => Number(c.day) === day).sort((a, b) => a.start.localeCompare(b.start));
}

/** Consecutive days (ending today or yesterday) with ≥1 completed task or focus session. */
export function computeStreak(tasks, focusLog, today) {
  const active = new Set();
  tasks.forEach(t => t.done && t.completedAt && active.add(toISODate(new Date(t.completedAt))));
  focusLog.forEach(f => f.minutes > 0 && active.add(f.date));
  let day = active.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (active.has(day)) { streak++; day = addDays(day, -1); }
  return streak;
}

export function computeStats(tasks, focusLog, today) {
  const weekStart = startOfWeek(today);
  const open = tasks.filter(t => !t.done);
  const doneToday = tasks.filter(t => t.done && t.completedAt && toISODate(new Date(t.completedAt)) === today);
  const dueToday = open.filter(t => t.due === today);
  const plannedToday = dueToday.length + doneToday.length;
  return {
    open: open.length,
    overdue: open.filter(t => isOverdue(t, today)).length,
    dueToday: dueToday.length,
    doneToday: doneToday.length,
    todayPct: plannedToday ? Math.round((doneToday.length / plannedToday) * 100) : 0,
    dueThisWeek: open.filter(t => t.due && t.due >= today && daysBetween(today, t.due) <= 7).length,
    doneThisWeek: tasks.filter(t => t.done && t.completedAt && toISODate(new Date(t.completedAt)) >= weekStart).length,
    focusWeek: focusLog.filter(f => f.date >= weekStart && f.date <= today).reduce((s, f) => s + f.minutes, 0),
    streak: computeStreak(tasks, focusLog, today),
  };
}

/* --------------------------------------------------------- validation */
export function validateTask(input, today) {
  const errors = {};
  const title = (input.title || '').trim();
  if (!title) errors.title = 'Enter a task title.';
  else if (title.length > 120) errors.title = 'Keep the title under 120 characters.';
  if (input.due && !parseISODate(input.due)) errors.due = 'Enter a valid date.';
  if (input.dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.dueTime)) errors.dueTime = 'Enter a valid time.';
  if (input.priority && !PRIORITIES.includes(input.priority)) errors.priority = 'Choose a priority.';
  if ((input.notes || '').length > 2000) errors.notes = 'Notes are limited to 2000 characters.';
  return { valid: Object.keys(errors).length === 0, errors };
}

export function validateModule(input, modules = [], editingId = null) {
  const errors = {};
  const code = (input.code || '').trim().toUpperCase();
  if (!code) errors.code = 'Enter a module code, e.g. CS52001.';
  else if (code.length > 12) errors.code = 'Module code is too long.';
  else if (modules.some(m => m.code.toUpperCase() === code && m.id !== editingId)) errors.code = 'That module already exists.';
  if (!(input.name || '').trim()) errors.name = 'Enter the module name.';
  return { valid: Object.keys(errors).length === 0, errors };
}

export function validateClass(input) {
  const errors = {};
  if (!input.moduleId) errors.moduleId = 'Choose a module.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.start || '')) errors.start = 'Enter a start time.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.end || '')) errors.end = 'Enter an end time.';
  else if (input.start && input.end <= input.start) errors.end = 'End time must be after the start time.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Password policy (NCSC-style: length over complexity, block obvious choices). */
export function validatePassword(pw, confirm) {
  const errors = [];
  if (typeof pw !== 'string' || pw.length < 8) errors.push('Use at least 8 characters.');
  if (pw && pw.length > 128) errors.push('Use 128 characters or fewer.');
  const common = ['password', '12345678', 'qwertyui', 'iloveyou', 'studyflow', 'password1', '11111111'];
  if (pw && common.includes(pw.toLowerCase())) errors.push('That password is too common.');
  if (pw && /^(.)\1+$/.test(pw)) errors.push('Avoid repeating a single character.');
  if (confirm !== undefined && pw !== confirm) errors.push('Passwords do not match.');
  return { valid: errors.length === 0, errors };
}

export function passwordStrength(pw = '') {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const level = score <= 1 ? 'weak' : score <= 3 ? 'fair' : 'strong';
  return { score, level };
}

/* ------------------------------------------------------------ privacy */
/** Round coordinates to ~1 km before they leave the device (data minimisation). */
export function roundCoord(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/* ---------------------------------------------------- API: Open-Meteo */
const WMO = {
  0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm with hail', '⛈️'], 99: ['Thunderstorm with hail', '⛈️'],
};

export function weatherInfo(code) {
  const [label, icon] = WMO[code] || ['Unknown', '🌡️'];
  return { label, icon };
}

export function weatherUrl(lat, lon) {
  const p = new URLSearchParams({
    latitude: String(roundCoord(lat)),
    longitude: String(roundCoord(lon)),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '7',
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

export function geocodeUrl(name) {
  const p = new URLSearchParams({ name: name.trim(), count: '5', language: 'en', format: 'json' });
  return `https://geocoding-api.open-meteo.com/v1/search?${p}`;
}

/** Normalise the Open-Meteo response; throws on malformed data (caught by caller). */
export function parseWeather(json) {
  if (!json || !json.current || !json.daily || !Array.isArray(json.daily.time)) {
    throw new Error('Unexpected weather response');
  }
  const c = json.current;
  const days = json.daily.time.map((date, i) => ({
    date,
    code: json.daily.weather_code?.[i] ?? null,
    max: json.daily.temperature_2m_max?.[i] ?? null,
    min: json.daily.temperature_2m_min?.[i] ?? null,
    rain: json.daily.precipitation_probability_max?.[i] ?? null,
  }));
  return {
    temp: c.temperature_2m ?? null,
    feels: c.apparent_temperature ?? null,
    code: c.weather_code ?? null,
    wind: c.wind_speed_10m ?? null,
    days,
  };
}

/** Student-relevant advice from forecast + today's classes. */
export function weatherAdvice(weather, classesToday = []) {
  if (!weather || !weather.days?.length) return '';
  const today = weather.days[0];
  const firstClass = classesToday[0];
  const when = firstClass ? ` for your ${firstClass.start} class` : '';
  if (today.rain != null && today.rain >= 60) return `High chance of rain (${today.rain}%) – take a waterproof${when}.`;
  if (today.rain != null && today.rain >= 30) return `Possible showers (${today.rain}%) – an umbrella might be wise${when}.`;
  if (weather.temp != null && weather.temp <= 2) return `Near freezing – wrap up warm${when}.`;
  if (today.code != null && today.code <= 2) return `Dry and bright – a good day to study outside or walk to campus.`;
  return `Dry for now – no umbrella needed${when}.`;
}

/* ------------------------------------------ API: GOV.UK bank holidays */
export const BANK_HOLIDAY_REGIONS = {
  'scotland': 'Scotland',
  'england-and-wales': 'England & Wales',
  'northern-ireland': 'Northern Ireland',
};

export function parseBankHolidays(json, region = 'scotland') {
  const events = json?.[region]?.events;
  if (!Array.isArray(events)) throw new Error('Unexpected bank holiday response');
  return events
    .filter(e => e && typeof e.title === 'string' && parseISODate(e.date))
    .map(e => ({ date: e.date, title: e.title }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function upcomingHolidays(holidays, today, limit = 3) {
  return holidays.filter(h => h.date >= today).slice(0, limit);
}

/* ------------------------------------------------------ focus (timer) */
/** Remaining ms for a timer that stores its end timestamp (robust to tab throttling/sleep). */
export function timerRemaining(timer, now) {
  if (!timer) return 0;
  if (timer.paused) return timer.remainingMs;
  return Math.max(0, timer.endsAt - now);
}

export function formatClock(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* --------------------------------------------------------------- data */
export function defaultState(name = '') {
  return {
    version: 1,
    profile: { name: name.trim(), createdAt: Date.now() },
    settings: {
      textScale: 1, contrast: false, theme: 'system', reduceMotion: false,
      haptics: true, notifications: false, privateNotifications: false, installDismissed: false, autoLockMin: 5,
      focusMin: 25, breakMin: 5, region: 'scotland', location: null,
    },
    modules: [], classes: [], tasks: [], focusLog: [],
    notified: {}, cache: {},
  };
}

/** Fill in any missing keys (forward-compatible when the schema grows). */
export function migrateState(s) {
  const base = defaultState(s?.profile?.name || '');
  if (!s || typeof s !== 'object') return base;
  return {
    ...base, ...s,
    profile: { ...base.profile, ...(s.profile || {}) },
    settings: { ...base.settings, ...(s.settings || {}) },
    modules: Array.isArray(s.modules) ? s.modules : [],
    classes: Array.isArray(s.classes) ? s.classes : [],
    tasks: Array.isArray(s.tasks) ? s.tasks.map(t => ({ subtasks: [], photoIds: [], ...t })) : [],
    focusLog: Array.isArray(s.focusLog) ? s.focusLog : [],
    notified: s.notified && typeof s.notified === 'object' ? s.notified : {},
    cache: s.cache && typeof s.cache === 'object' ? s.cache : {},
  };
}

/** Tasks that should trigger a reminder now (due within 24 h, not yet notified). */
export function tasksToNotify(tasks, notified, now) {
  return tasks.filter(t => {
    if (t.done || !t.due || notified[t.id] === t.due) return false;
    const [h, m] = (t.dueTime || '23:59').split(':').map(Number);
    const due = parseISODate(t.due); due.setHours(h, m, 0, 0);
    const diff = due.getTime() - now;
    return diff > -3600000 && diff <= 24 * 3600000;
  });
}

/** Escape user content before inserting into HTML (XSS protection). */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
