// Unit tests for js/ics.js – calendar (.ics) import/export.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as ics from '../../js/ics.js';
import { addDays } from '../../js/core.js';

const T = '2026-11-11'; // Wednesday

const portal = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Blackboard//Calendar//EN',
  'BEGIN:VEVENT', 'UID:bb-1', 'DTSTART:20261118T170000Z', 'DTEND:20261118T170000Z',
  'SUMMARY:CS52001 - Mobile Application Development: MAB001 Report Due',
  'DESCRIPTION:Submit via Turnitin.\\nTwo pages\\, Calibri 11.', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:bb-2', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261121',
  'SUMMARY:Reading week', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:tt-1', 'DTSTART;TZID=Europe/London:20261111T110000', 'DTEND;TZID=Europe/London:20261111T120000',
  'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=10', 'SUMMARY:CS52001 Lecture', 'LOCATION:QMB Lab 0', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:tt-2a', 'DTSTART:20261112T140000', 'DTEND:20261112T150000', 'SUMMARY:AC 50001 Tutorial', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:tt-2b', 'DTSTART:20261119T140000', 'DTEND:20261119T150000', 'SUMMARY:AC 50001 Tutorial', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:old', 'DTSTART;VALUE=DATE:20260901', 'SUMMARY:Old essay due', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:cx', 'DTSTART;VALUE=DATE:20261125', 'SUMMARY:Cancelled quiz', 'STATUS:CANCELLED', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:long-desc', 'DTSTART:20261130T090000', 'DTEND:20261130T110000',
  'SUMMARY:CS52006 Software Engineering Exa', ' m', 'END:VEVENT', // folded line
  'END:VCALENDAR', '',
].join('\r\n');

describe('parseICS', () => {
  const events = ics.parseICS(portal);
  test('reads events, unfolds lines, unescapes text and drops cancelled events', () => {
    assert.equal(events.length, 7);
    assert.equal(events.find(e => e.uid === 'long-desc').summary, 'CS52006 Software Engineering Exam');
    assert.equal(events.find(e => e.uid === 'bb-1').description, 'Submit via Turnitin.\nTwo pages, Calibri 11.');
    assert.ok(!events.some(e => e.uid === 'cx'));
  });
  test('parses all-day, floating and TZID dates', () => {
    assert.deepEqual(events.find(e => e.uid === 'bb-2').start, { date: '2026-11-20', time: '', allDay: true });
    assert.deepEqual(events.find(e => e.uid === 'tt-1').start, { date: '2026-11-11', time: '11:00', allDay: false });
    assert.deepEqual(events.find(e => e.uid === 'tt-1').rrule.byday, [3]);
  });
  test('UTC times are converted to the local clock', () => {
    const d = ics.parseICSDate('20261118T170000Z');
    const local = new Date(Date.UTC(2026, 10, 18, 17, 0));
    assert.equal(d.time, `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`);
  });
  test('rejects files that are not calendars', () => {
    assert.throws(() => ics.parseICS('hello'), /not a calendar/);
    assert.throws(() => ics.parseICS(null), /not a calendar/);
    assert.equal(ics.parseICSDate('garbage'), null);
  });
});

describe('detectModule', () => {
  test('finds module codes (with or without a space) and names', () => {
    assert.deepEqual(ics.detectModule({ summary: 'CS52001 - Mobile Application Development: Report' }), { code: 'CS52001', name: 'Mobile Application Development' });
    assert.equal(ics.detectModule({ summary: 'AC 50001 Tutorial' }).code, 'AC50001');
    assert.equal(ics.detectModule({ summary: 'Lunch', categories: ['DS502 Data Science'] }).code, 'DS502');
    assert.equal(ics.detectModule({ summary: 'Gym session' }), null);
  });
});

describe('planImport', () => {
  const plan = ics.planImport(ics.parseICS(portal), T);
  test('turns weekly and repeated lecture/tutorial events into one class each', () => {
    assert.equal(plan.classes.length, 2);
    const lec = plan.classes.find(c => c.code === 'CS52001');
    assert.deepEqual([lec.kind, lec.day, lec.start, lec.end, lec.room], ['Lecture', 3, '11:00', '12:00', 'QMB Lab 0']);
    const tut = plan.classes.find(c => c.code === 'AC50001');
    assert.deepEqual([tut.kind, tut.day, tut.start], ['Tutorial', 4, '14:00']);
  });
  test('turns due dates and exams into tasks, skips old deadlines', () => {
    const titles = plan.deadlines.map(d => d.title);
    assert.ok(titles.some(t => /MAB001 Report Due/.test(t)));
    assert.ok(titles.includes('Reading week')); // all-day event
    assert.ok(!titles.some(t => /Old essay/.test(t)));
    const exam = plan.deadlines.find(d => d.code === 'CS52006');
    assert.equal(exam.type, 'exam');
    assert.equal(exam.priority, 'high');
    assert.ok(plan.skipped >= 1);
  });
  test('collects modules with names and strips the code from task titles', () => {
    assert.deepEqual(plan.modules.map(m => m.code), ['AC50001', 'CS52001', 'CS52006']);
    assert.equal(plan.modules.find(m => m.code === 'CS52001').name, 'Mobile Application Development');
    const report = plan.deadlines.find(d => d.code === 'CS52001');
    assert.equal(report.title, 'MAB001 Report Due'); // code and module name stripped
    assert.match(report.notes, /Turnitin/);
  });
  test('uses the UID as a stable key so re-importing updates instead of duplicating', () => {
    assert.ok(plan.deadlines.some(d => d.key === 'bb-1'));
    const again = ics.planImport(ics.parseICS(portal), T);
    assert.deepEqual(again.deadlines.map(d => d.key), plan.deadlines.map(d => d.key));
  });
});

describe('sample calendar and export', () => {
  test('the built-in sample calendar produces modules, classes and future deadlines', () => {
    const p = ics.planImport(ics.parseICS(ics.sampleICS(T)), T);
    assert.equal(p.modules.length, 3);
    assert.equal(p.classes.length, 4);
    assert.equal(p.deadlines.length, 5);
    assert.ok(p.deadlines.every(d => d.due >= T));
  });
  test('tasksToICS round-trips through the parser', () => {
    const tasks = [
      { id: 't1', title: 'Essay, part 1; draft', due: addDays(T, 3), dueTime: '17:00', notes: 'Line 1\nLine 2', moduleId: 'm1' },
      { id: 't2', title: 'Read chapter 4', due: addDays(T, 5), dueTime: '' },
      { id: 't3', title: 'Done already', due: T, done: true },
      { id: 't4', title: 'No date' },
    ];
    const out = ics.tasksToICS(tasks, [{ id: 'm1', code: 'CS52001', name: 'Mobile App Dev' }]);
    assert.match(out, /^BEGIN:VCALENDAR\r\n/);
    assert.match(out, /TRIGGER:-P1D/);
    const back = ics.parseICS(out);
    assert.equal(back.length, 2);
    assert.equal(back[0].summary, 'CS52001 – Essay, part 1; draft (due)');
    assert.equal(back[0].description, 'Line 1\nLine 2');
    assert.deepEqual(back[1].start, { date: addDays(T, 5), time: '', allDay: true });
    assert.ok(out.split('\r\n').every(l => l.length <= 75));
  });
});
