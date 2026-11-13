/**
 * StudyFlow – ics.js
 * Import/export of iCalendar (.ics, RFC 5545) files – the format student portals (Blackboard,
 * MyDundee/timetable systems), Outlook and Google Calendar use for "Export / Subscribe / Add to calendar".
 * Pure functions, no DOM: unit-tested in tests/unit/ics.test.js.
 */
import { toISODate, parseISODate, addDays, daysBetween, startOfWeek } from './core.js';

const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const CODE_RE = /\b([A-Z]{2,4})\s?(\d{3,5}[A-Z]?)\b/;
const DEADLINE_RE = /\b(due|deadline|submi(t|ssion)|hand[- ]?in|assignment|coursework|exam|examination|test|quiz|report|essay|presentation|demo|portfolio|project)\b/i;
const CLASS_RE = /\b(lecture|lab|laboratory|tutorial|seminar|workshop|practical|class)\b/i;

const pad = n => String(n).padStart(2, '0');
const unescapeText = s => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const escapeText = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** Parse an iCalendar date/date-time into local { date, time, allDay }. */
export function parseICSDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (h === undefined || params.VALUE === 'DATE') return { date: `${y}-${mo}-${d}`, time: '', allDay: true };
  if (z) { // UTC → the device's local time
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    return { date: toISODate(dt), time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`, allDay: false };
  }
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, allDay: false }; // floating / TZID wall-clock time
}

function parseRRule(v) {
  const r = Object.fromEntries(v.split(';').map(p => p.split('=')).filter(p => p.length === 2).map(([k, x]) => [k.toUpperCase(), x]));
  return {
    freq: r.FREQ || '',
    byday: r.BYDAY ? r.BYDAY.split(',').map(x => DAY_CODES[x.slice(-2).toUpperCase()]).filter(x => x !== undefined) : [],
    until: r.UNTIL ? parseICSDate(r.UNTIL)?.date || '' : '',
    count: r.COUNT ? Number(r.COUNT) : null,
  };
}

/** Parse .ics text into a list of plain event objects. Tolerant of CRLF/LF and folded lines. */
export function parseICS(text) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) throw new Error('This is not a calendar (.ics) file.');
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let ev = null, nested = 0; // nested = depth inside VALARM etc., whose properties must not overwrite the event's
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) { ev = { categories: [] }; nested = 0; continue; }
    if (/^END:VEVENT$/i.test(line)) { if (ev?.start) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    if (/^BEGIN:/i.test(line)) { nested++; continue; }
    if (/^END:/i.test(line)) { nested = Math.max(0, nested - 1); continue; }
    if (nested) continue;
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const [name, ...rawParams] = line.slice(0, idx).split(';');
    const params = Object.fromEntries(rawParams.map(p => p.split('=')).map(([k, v = '']) => [k.toUpperCase(), v.replace(/"/g, '')]));
    const value = line.slice(idx + 1);
    switch (name.toUpperCase()) {
      case 'UID': ev.uid = value.trim(); break;
      case 'SUMMARY': ev.summary = unescapeText(value).trim(); break;
      case 'DESCRIPTION': ev.description = unescapeText(value).trim(); break;
      case 'LOCATION': ev.location = unescapeText(value).trim(); break;
      case 'CATEGORIES': ev.categories.push(...unescapeText(value).split(',').map(s => s.trim()).filter(Boolean)); break;
      case 'DTSTART': ev.start = parseICSDate(value, params); break;
      case 'DTEND': ev.end = parseICSDate(value, params); break;
      case 'DUE': ev.start = ev.start || parseICSDate(value, params); break;
      case 'RRULE': ev.rrule = parseRRule(value); break;
      case 'STATUS': ev.status = value.trim().toUpperCase(); break;
      default:
    }
  }
  return events.filter(e => e.start && e.status !== 'CANCELLED');
}

/** Find a module code like CS52001 or "CS 52001" and, if present, a module name. */
export function detectModule(ev) {
  const fields = [ev.summary || '', ...(ev.categories || []), ev.description || ''];
  for (const f of fields) {
    const m = CODE_RE.exec(f);
    if (!m) continue;
    const code = (m[1] + m[2]).toUpperCase();
    const after = f.slice(m.index + m[0].length).match(/^\s*[-–:|]\s*([^\n\-–|(:]+?)(?:\s*[-–|(:]|$)/);
    let name = after ? after[1].trim() : '';
    if (CLASS_RE.test(name) || DEADLINE_RE.test(name) || name.length < 3) name = '';
    return { code, name };
  }
  return null;
}

const minutes = t => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : 0);

function taskType(text) {
  if (/\b(exam|examination|test|quiz)\b/i.test(text)) return 'exam';
  if (/\b(lab|practical)\b/i.test(text)) return 'lab';
  if (/\b(read|reading)\b/i.test(text)) return 'reading';
  if (/\b(revise|revision)\b/i.test(text)) return 'revision';
  return 'assignment';
}

/**
 * Turn parsed events into an import plan: modules, weekly classes and deadlines.
 *  - Weekly repeating events (RRULE) and lecture/lab/tutorial events become timetable classes;
 *    portals that export every occurrence separately are grouped into one weekly class.
 *  - Due dates, exams and submissions become tasks. Very old deadlines are skipped.
 */
export function planImport(events, today, { keepPastDays = 7 } = {}) {
  const modules = new Map();
  const classes = new Map();
  const deadlines = new Map();
  let skipped = 0;

  for (const ev of events) {
    const text = `${ev.summary || ''} ${ev.description || ''} ${(ev.categories || []).join(' ')}`;
    const mod = detectModule(ev);
    if (mod && (!modules.has(mod.code) || (!modules.get(mod.code).name && mod.name))) modules.set(mod.code, mod);
    const code = mod?.code || '';
    const summary = (ev.summary || 'Untitled').trim();
    let title = code ? summary.replace(new RegExp(`^${code.replace(/(\d)/, '\\s?$1')}\\s*[-–:|]?\\s*`, 'i'), '').trim() || summary : summary;
    if (mod?.name && title.toLowerCase().startsWith(mod.name.toLowerCase())) title = title.slice(mod.name.length).replace(/^\s*[-–:|]\s*/, '').trim() || title;
    const duration = ev.end && !ev.start.allDay && ev.end.date === ev.start.date ? minutes(ev.end.time) - minutes(ev.start.time) : 0;
    const weekly = ev.rrule?.freq === 'WEEKLY';
    const looksLikeClass = !ev.start.allDay && duration >= 30 && CLASS_RE.test(summary) && !/\b(exam|test|quiz|due|deadline)\b/i.test(summary);

    if ((weekly && !ev.start.allDay) || looksLikeClass) {
      const days = weekly && ev.rrule.byday.length ? ev.rrule.byday : [parseISODate(ev.start.date).getDay()];
      const lastDate = weekly ? (ev.rrule.until || (ev.rrule.count ? addDays(ev.start.date, 7 * ev.rrule.count) : '9999-12-31')) : ev.start.date;
      if (lastDate < addDays(today, -keepPastDays) && !weekly) { skipped++; continue; }
      const kind = (summary.match(CLASS_RE)?.[1] || 'Class').replace(/^\w/, c => c.toUpperCase()).replace(/^Laboratory$/, 'Lab');
      for (const day of days) {
        const end = ev.end?.time && duration > 0 ? ev.end.time : `${pad(Math.min(23, Math.floor((minutes(ev.start.time) + 60) / 60)))}:${ev.start.time.slice(3)}`;
        const key = `${code || summary.toLowerCase()}|${day}|${ev.start.time}|${end}`;
        if (!classes.has(key)) classes.set(key, { key, code, title, kind, day, start: ev.start.time, end, room: ev.location || '', firstDate: ev.start.date, lastDate });
      }
      continue;
    }

    if (DEADLINE_RE.test(text) || ev.start.allDay || duration === 0) {
      if (ev.start.date < addDays(today, -keepPastDays)) { skipped++; continue; }
      const due = ev.start.date;
      const dueTime = ev.start.allDay || ev.start.time === '00:00' ? '' : ev.start.time;
      const type = taskType(text);
      const soon = daysBetween(today, due) <= 3;
      const key = ev.uid || `${code}|${title}|${due}`;
      deadlines.set(key, {
        key, code, title, type, due, dueTime,
        priority: type === 'exam' || /\b(final|project|dissertation)\b/i.test(text) || soon ? 'high' : 'medium',
        notes: [ev.description, ev.location ? `Location: ${ev.location}` : ''].filter(Boolean).join('\n').slice(0, 2000),
      });
      continue;
    }
    skipped++;
  }
  return {
    modules: [...modules.values()].sort((a, b) => a.code.localeCompare(b.code)),
    classes: [...classes.values()].sort((a, b) => ((a.day + 6) % 7) - ((b.day + 6) % 7) || a.start.localeCompare(b.start)),
    deadlines: [...deadlines.values()].sort((a, b) => a.due.localeCompare(b.due) || (a.dueTime || '99').localeCompare(b.dueTime || '99')),
    skipped,
  };
}

/* ------------------------------------------------------------------ export */
const icsStamp = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const fold = line => { const out = []; for (let i = 0; i < line.length; i += 73) out.push((i ? ' ' : '') + line.slice(i, i + 73)); return out.join('\r\n'); };

/** Export open tasks with a due date as an .ics file (with a reminder the day before). */
export function tasksToICS(tasks, modules = [], now = new Date()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//StudyFlow//Student Planner//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:StudyFlow deadlines'];
  for (const t of tasks.filter(x => !x.done && x.due)) {
    const mod = modules.find(m => m.id === t.moduleId);
    const d = t.due.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${t.id}@studyflow`, `DTSTAMP:${icsStamp(now)}`);
    if (t.dueTime) {
      const tm = t.dueTime.replace(':', '');
      lines.push(`DTSTART:${d}T${tm}00`, `DTEND:${d}T${tm}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(t.due, 1).replace(/-/g, '')}`);
    }
    lines.push(`SUMMARY:${escapeText(`${mod ? `${mod.code} – ` : ''}${t.title} (due)`)}`);
    if (t.notes) lines.push(`DESCRIPTION:${escapeText(t.notes)}`);
    if (mod) lines.push(`CATEGORIES:${escapeText(`${mod.code} ${mod.name}`)}`);
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(t.title)}`, 'TRIGGER:-P1D', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** A realistic sample university calendar (dates relative to today) for demos and testing. */
export function sampleICS(today) {
  const mon = startOfWeek(today);
  const dt = (iso, t) => `${iso.replace(/-/g, '')}T${t.replace(':', '')}00`;
  const until = addDays(mon, 7 * 10).replace(/-/g, '');
  const ev = (uid, summary, start, end, extra = []) => ['BEGIN:VEVENT', `UID:${uid}@sample.studyflow`, 'DTSTAMP:20260101T000000Z', `DTSTART;TZID=Europe/London:${start}`, `DTEND;TZID=Europe/London:${end}`, `SUMMARY:${summary}`, ...extra, 'END:VEVENT'];
  const due = (uid, summary, iso, time, desc) => ['BEGIN:VEVENT', `UID:${uid}@sample.studyflow`, 'DTSTAMP:20260101T000000Z', `DTSTART;TZID=Europe/London:${dt(iso, time)}`, `DTEND;TZID=Europe/London:${dt(iso, time)}`, `SUMMARY:${summary}`, `DESCRIPTION:${desc}`, 'END:VEVENT'];
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//University Student Portal//Timetable Export//EN', 'X-WR-CALNAME:My timetable and deadlines',
    ...ev('lec-cs52001', 'CS52001 - Mobile Application Development - Lecture', dt(addDays(mon, 2), '11:00'), dt(addDays(mon, 2), '12:00'), [`RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=${until}T235900Z`, 'LOCATION:Queen Mother Building\\, Lab 0']),
    ...ev('lab-cs52001', 'CS52001 - Mobile Application Development - Lab', dt(addDays(mon, 2), '12:00'), dt(addDays(mon, 2), '14:00'), [`RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=${until}T235900Z`, 'LOCATION:Queen Mother Building\\, Labs 0-2']),
    ...ev('sem-cs52004', 'CS52004 - Research Methods - Seminar', dt(mon, '10:00'), dt(mon, '12:00'), [`RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=${until}T235900Z`, 'LOCATION:Dalhousie Building\\, Room 2F13']),
    ...ev('tut-cs52006-1', 'CS52006 - Software Engineering - Tutorial', dt(addDays(mon, 3), '14:00'), dt(addDays(mon, 3), '15:00'), ['LOCATION:Fulton Building\\, Room 1.12']),
    ...ev('tut-cs52006-2', 'CS52006 - Software Engineering - Tutorial', dt(addDays(mon, 10), '14:00'), dt(addDays(mon, 10), '15:00'), ['LOCATION:Fulton Building\\, Room 1.12']),
    ...due('due-mab001-report', 'CS52001 MAB001 Project Report due', addDays(today, 12), '17:00', 'Submit a 2-page PDF report via the portal.'),
    ...due('due-mab001-demo', 'CS52001 MAB001 App Demo (5 minutes)', addDays(today, 13), '11:00', 'Live demonstration of your app on a device.'),
    ...due('due-cs52004-proposal', 'CS52004 Research Proposal submission', addDays(today, 5), '23:59', 'Upload your 1500-word research proposal.'),
    ...due('due-cs52006-quiz', 'CS52006 Online Quiz 2', addDays(today, 2), '09:00', 'Covers weeks 4-6. 30 minutes.'),
    ...due('due-cs52006-exam', 'CS52006 Software Engineering Exam', addDays(today, 30), '09:30', 'Main exam hall. Bring student ID.'),
    'END:VCALENDAR', '',
  ].join('\r\n');
}
