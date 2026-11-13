// Unit tests for js/core.js – run with `npm test` (Node's built-in test runner, no dependencies).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../js/core.js';

const T = '2026-11-11'; // a Wednesday
const task = (o = {}) => ({ id: o.id || c.createId('t'), title: 'Task', priority: 'medium', done: false, due: T, subtasks: [], photoIds: [], ...o });

describe('dates', () => {
  test('toISODate uses the local calendar day (no UTC off-by-one)', () => {
    assert.equal(c.toISODate(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
    assert.equal(c.toISODate(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  });
  test('parseISODate rejects invalid dates', () => {
    assert.equal(c.parseISODate('2026-02-30'), null);
    assert.equal(c.parseISODate('not a date'), null);
    assert.equal(c.parseISODate(undefined), null);
    assert.ok(c.parseISODate('2028-02-29')); // leap year
  });
  test('addDays crosses months, years and DST changes', () => {
    assert.equal(c.addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(c.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(c.addDays('2026-03-28', 2), '2026-03-30'); // UK clocks change 29 Mar 2026
    assert.equal(c.addDays('2026-10-24', 2), '2026-10-26'); // and 25 Oct 2026
  });
  test('daysBetween is DST-safe and signed', () => {
    assert.equal(c.daysBetween('2026-03-28', '2026-03-30'), 2);
    assert.equal(c.daysBetween('2026-11-11', '2026-11-04'), -7);
  });
  test('startOfWeek returns Monday, also for Sundays', () => {
    assert.equal(c.startOfWeek(T), '2026-11-09');
    assert.equal(c.startOfWeek('2026-11-15'), '2026-11-09'); // Sunday
    assert.equal(c.startOfWeek('2026-11-16'), '2026-11-16'); // Monday
    assert.equal(c.weekDates(T).length, 7);
  });
  test('formatting helpers', () => {
    assert.equal(c.formatDate(T), 'Wed 11 Nov');
    assert.equal(c.formatLongDate(T), 'Wednesday 11 Nov 2026');
    assert.equal(c.formatMinutes(0), '0 min');
    assert.equal(c.formatMinutes(25), '25 min');
    assert.equal(c.formatMinutes(120), '2 h');
    assert.equal(c.formatMinutes(95), '1 h 35 min');
    assert.equal(c.greeting(9), 'Good morning');
    assert.equal(c.greeting(15), 'Good afternoon');
    assert.equal(c.greeting(21), 'Good evening');
  });
});

describe('due labels & urgency', () => {
  test('dueLabel covers every case', () => {
    assert.equal(c.dueLabel(task({ due: '' }), T), 'No due date');
    assert.equal(c.dueLabel(task({ due: '2026-11-08' }), T), 'Overdue by 3 days');
    assert.equal(c.dueLabel(task({ due: '2026-11-10' }), T), 'Overdue by 1 day');
    assert.equal(c.dueLabel(task({ due: T, dueTime: '17:00' }), T), 'Due today at 17:00');
    assert.equal(c.dueLabel(task({ due: '2026-11-12' }), T), 'Due tomorrow');
    assert.equal(c.dueLabel(task({ due: '2026-11-15' }), T), 'Due in 4 days');
    assert.equal(c.dueLabel(task({ due: '2026-11-25' }), T), 'Due Wed 25 Nov');
    assert.match(c.dueLabel(task({ due: '2026-11-08', done: true }), T), /^Done/);
  });
  test('urgency buckets', () => {
    assert.equal(c.urgency(task({ due: '2026-11-01' }), T), 'overdue');
    assert.equal(c.urgency(task({ due: '2026-11-12' }), T), 'soon');
    assert.equal(c.urgency(task({ due: '2026-11-16' }), T), 'week');
    assert.equal(c.urgency(task({ due: '2026-12-25' }), T), 'later');
    assert.equal(c.urgency(task({ done: true }), T), 'done');
  });
  test('isOverdue ignores completed tasks', () => {
    assert.equal(c.isOverdue(task({ due: '2026-11-01' }), T), true);
    assert.equal(c.isOverdue(task({ due: '2026-11-01', done: true }), T), false);
  });
  test('subtaskProgress', () => {
    assert.equal(c.subtaskProgress(task()), null);
    assert.deepEqual(c.subtaskProgress(task({ subtasks: [{ done: true }, { done: false }, { done: true }] })), { done: 2, total: 3, pct: 67 });
  });
});

describe('filtering & sorting', () => {
  const tasks = [
    task({ id: 'a', title: 'Essay draft', due: '2026-11-10', priority: 'high', moduleId: 'm1' }),
    task({ id: 'b', title: 'Read chapter 4', due: T, priority: 'low', moduleId: 'm2', notes: 'statistics' }),
    task({ id: 'c', title: 'Lab report', due: '2026-11-14', priority: 'medium', moduleId: 'm1' }),
    task({ id: 'd', title: 'Exam revision', due: '2026-12-20', priority: 'high' }),
    task({ id: 'e', title: 'Old task', due: '2026-11-01', done: true }),
  ];
  const ids = l => l.map(t => t.id);
  test('views', () => {
    assert.deepEqual(ids(c.filterTasks(tasks, { view: 'all' }, T)), ['a', 'b', 'c', 'd']);
    assert.deepEqual(ids(c.filterTasks(tasks, { view: 'today' }, T)), ['a', 'b']);
    assert.deepEqual(ids(c.filterTasks(tasks, { view: 'upcoming' }, T)), ['c']);
    assert.deepEqual(ids(c.filterTasks(tasks, { view: 'overdue' }, T)), ['a']);
    assert.deepEqual(ids(c.filterTasks(tasks, { view: 'done' }, T)), ['e']);
  });
  test('module filter and case-insensitive search (title + notes)', () => {
    assert.deepEqual(ids(c.filterTasks(tasks, { moduleId: 'm1' }, T)), ['a', 'c']);
    assert.deepEqual(ids(c.filterTasks(tasks, { query: 'LAB' }, T)), ['c']);
    assert.deepEqual(ids(c.filterTasks(tasks, { query: 'statis' }, T)), ['b']);
    assert.deepEqual(ids(c.filterTasks(tasks, { query: '   ' }, T)), ['a', 'b', 'c', 'd']);
  });
  test('sortTasks by due, priority, module; is stable and non-mutating', () => {
    const copy = [...tasks];
    assert.deepEqual(ids(c.sortTasks(tasks, 'due')), ['e', 'a', 'b', 'c', 'd']);
    assert.deepEqual(ids(c.sortTasks(tasks, 'priority')).slice(0, 2), ['a', 'd']);
    const mods = [{ id: 'm1', code: 'CS52001' }, { id: 'm2', code: 'AB100' }];
    assert.deepEqual(ids(c.sortTasks(tasks, 'module', mods)).slice(0, 3), ['b', 'a', 'c']);
    assert.deepEqual(tasks, copy);
  });
  test('tasks without a due date sort last', () => {
    const l = c.sortTasks([task({ id: 'x', due: '' }), task({ id: 'y', due: T })], 'due');
    assert.deepEqual(ids(l), ['y', 'x']);
  });
  test('classesForDate matches weekday and sorts by time', () => {
    const classes = [{ day: 3, start: '12:00' }, { day: 3, start: '11:00' }, { day: 1, start: '09:00' }];
    assert.deepEqual(c.classesForDate(classes, T).map(x => x.start), ['11:00', '12:00']);
  });
});

describe('stats & streaks', () => {
  const at = (iso, h = 12) => { const d = c.parseISODate(iso); d.setHours(h); return d.getTime(); };
  test('computeStats', () => {
    const tasks = [
      task({ due: T }), task({ due: T, done: true, completedAt: at(T) }),
      task({ due: '2026-11-09' }), task({ due: '2026-11-13' }),
    ];
    const s = c.computeStats(tasks, [{ date: T, minutes: 25 }, { date: '2026-11-09', minutes: 50 }, { date: '2026-11-02', minutes: 99 }], T);
    assert.equal(s.dueToday, 1);
    assert.equal(s.doneToday, 1);
    assert.equal(s.todayPct, 50);
    assert.equal(s.overdue, 1);
    assert.equal(s.dueThisWeek, 2);
    assert.equal(s.focusWeek, 75); // last week's 99 excluded
  });
  test('streak counts consecutive active days and tolerates today being empty', () => {
    const log = [{ date: '2026-11-10', minutes: 25 }, { date: '2026-11-09', minutes: 25 }, { date: '2026-11-07', minutes: 25 }];
    assert.equal(c.computeStreak([], log, T), 2);
    assert.equal(c.computeStreak([task({ done: true, completedAt: at(T) })], log, T), 3);
    assert.equal(c.computeStreak([], [], T), 0);
  });
  test('todayPct is 0 with nothing planned (no divide-by-zero)', () => {
    assert.equal(c.computeStats([], [], T).todayPct, 0);
  });
});

describe('validation', () => {
  test('validateTask', () => {
    assert.equal(c.validateTask({ title: 'OK', due: T }).valid, true);
    assert.equal(c.validateTask({ title: '   ' }).errors.title, 'Enter a task title.');
    assert.ok(c.validateTask({ title: 'x'.repeat(121) }).errors.title);
    assert.ok(c.validateTask({ title: 'a', due: '2026-13-01' }).errors.due);
    assert.ok(c.validateTask({ title: 'a', dueTime: '25:00' }).errors.dueTime);
    assert.ok(c.validateTask({ title: 'a', priority: 'urgent' }).errors.priority);
  });
  test('validateModule blocks duplicates (case-insensitive) but allows editing itself', () => {
    const mods = [{ id: 'm1', code: 'CS52001' }];
    assert.ok(c.validateModule({ code: 'cs52001', name: 'x' }, mods).errors.code);
    assert.equal(c.validateModule({ code: 'CS52001', name: 'x' }, mods, 'm1').valid, true);
    assert.ok(c.validateModule({ code: '', name: '' }, mods).errors.name);
  });
  test('validateClass requires end after start', () => {
    assert.equal(c.validateClass({ moduleId: 'm', start: '09:00', end: '10:00' }).valid, true);
    assert.ok(c.validateClass({ moduleId: 'm', start: '10:00', end: '09:00' }).errors.end);
    assert.ok(c.validateClass({ start: '10:00', end: '11:00' }).errors.moduleId);
  });
  test('validatePassword follows length-first policy', () => {
    assert.equal(c.validatePassword('correct horse', 'correct horse').valid, true);
    assert.ok(c.validatePassword('short').errors.length);
    assert.ok(c.validatePassword('password').errors.includes('That password is too common.'));
    assert.ok(c.validatePassword('aaaaaaaaa').errors.includes('Avoid repeating a single character.'));
    assert.ok(c.validatePassword('longenough1', 'different1').errors.includes('Passwords do not match.'));
  });
  test('passwordStrength levels', () => {
    assert.equal(c.passwordStrength('abc').level, 'weak');
    assert.equal(c.passwordStrength('abcdefgh1').level, 'fair');
    assert.equal(c.passwordStrength('Tr0ub4dor&3xtra').level, 'strong');
  });
});

describe('APIs (parsing, privacy)', () => {
  test('roundCoord limits precision to ~1 km', () => {
    assert.equal(c.roundCoord(56.458123), 56.46);
    assert.equal(c.roundCoord(-2.970456), -2.97);
  });
  test('weatherUrl sends rounded coordinates only', () => {
    const u = new URL(c.weatherUrl(56.458123, -2.970456));
    assert.equal(u.hostname, 'api.open-meteo.com');
    assert.equal(u.searchParams.get('latitude'), '56.46');
    assert.equal(u.searchParams.get('longitude'), '-2.97');
  });
  test('parseWeather normalises the response and rejects bad data', () => {
    const json = { current: { temperature_2m: 7.4, apparent_temperature: 4.1, weather_code: 61, wind_speed_10m: 18 },
      daily: { time: ['2026-11-11', '2026-11-12'], weather_code: [61, 3], temperature_2m_max: [9, 8], temperature_2m_min: [3, 2], precipitation_probability_max: [80, 10] } };
    const w = c.parseWeather(json);
    assert.equal(w.temp, 7.4);
    assert.equal(w.days.length, 2);
    assert.equal(w.days[0].rain, 80);
    assert.throws(() => c.parseWeather({}), /Unexpected/);
    assert.throws(() => c.parseWeather(null), /Unexpected/);
  });
  test('weatherInfo maps WMO codes with a safe fallback', () => {
    assert.equal(c.weatherInfo(0).label, 'Clear sky');
    assert.equal(c.weatherInfo(63).label, 'Rain');
    assert.equal(c.weatherInfo(1234).label, 'Unknown');
  });
  test('weatherAdvice mentions the first class when it is wet', () => {
    const w = { temp: 8, days: [{ rain: 75, code: 63 }] };
    assert.match(c.weatherAdvice(w, [{ start: '11:00' }]), /waterproof for your 11:00 class/);
    assert.match(c.weatherAdvice({ temp: 1, days: [{ rain: 0, code: 3 }] }), /freezing/);
    assert.equal(c.weatherAdvice(null), '');
  });
  test('parseBankHolidays picks region, validates and sorts', () => {
    const json = { scotland: { events: [{ title: 'St Andrew’s Day', date: '2026-11-30' }, { title: 'Christmas Day', date: '2026-12-25' }, { title: 'Bad', date: 'nope' }, { title: 'New Year’s Day', date: '2026-01-01' }] } };
    const h = c.parseBankHolidays(json, 'scotland');
    assert.deepEqual(h.map(x => x.date), ['2026-01-01', '2026-11-30', '2026-12-25']);
    assert.deepEqual(c.upcomingHolidays(h, T, 1).map(x => x.title), ['St Andrew’s Day']);
    assert.throws(() => c.parseBankHolidays(json, 'england-and-wales'));
  });
});

describe('focus timer', () => {
  test('timerRemaining is based on the end timestamp (survives throttled tabs)', () => {
    assert.equal(c.timerRemaining({ endsAt: 10000, paused: false }, 4000), 6000);
    assert.equal(c.timerRemaining({ endsAt: 10000, paused: false }, 99999), 0);
    assert.equal(c.timerRemaining({ paused: true, remainingMs: 1234 }, 99999), 1234);
    assert.equal(c.timerRemaining(null, 0), 0);
  });
  test('formatClock', () => {
    assert.equal(c.formatClock(25 * 60000), '25:00');
    assert.equal(c.formatClock(61000), '01:01');
    assert.equal(c.formatClock(999), '00:01'); // rounds up so 00:00 only shows at the end
  });
});

describe('state, reminders & security helpers', () => {
  test('migrateState fills missing keys and keeps data', () => {
    const s = c.migrateState({ profile: { name: 'Sam' }, tasks: [{ id: 't1', title: 'x' }], settings: { textScale: 1.2 } });
    assert.equal(s.profile.name, 'Sam');
    assert.equal(s.settings.textScale, 1.2);
    assert.equal(s.settings.autoLockMin, 5);
    assert.deepEqual(s.tasks[0].subtasks, []);
    assert.deepEqual(c.migrateState(null).tasks, []);
  });
  test('tasksToNotify: due within 24 h, once per due date', () => {
    const now = new Date(2026, 10, 11, 9, 0).getTime();
    const tasks = [
      task({ id: 'soon', due: T, dueTime: '17:00' }),
      task({ id: 'tomorrow-late', due: '2026-11-12', dueTime: '18:00' }),
      task({ id: 'done', due: T, done: true }),
      task({ id: 'already', due: T }),
    ];
    const res = c.tasksToNotify(tasks, { already: T }, now).map(t => t.id);
    assert.deepEqual(res, ['soon']);
  });
  test('escapeHtml neutralises markup (XSS)', () => {
    assert.equal(c.escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    assert.equal(c.escapeHtml(null), '');
  });
  test('createId is unique', () => {
    const set = new Set(Array.from({ length: 1000 }, () => c.createId()));
    assert.equal(set.size, 1000);
  });
});
