# Testing & Debugging Evidence

## Strategy

| Level | Tool | What it covers |
|---|---|---|
| Unit | Node built-in test runner (`npm test`) | 54 tests of pure logic and security, including calendar import/export (folded lines, escaping, UTC/all-day/TZID dates, weekly RRULEs, grouping repeated timetable events, module-code detection, stable re-import keys, round-trip export). Also: dates (leap years, DST, week start), due labels, filtering/sorting, stats/streaks, validation, API parsing, coordinate rounding, timer maths, reminders, XSS escaping, and encryption (round-trip, wrong password, tamper detection, fresh salt/IV, non-extractable key) |
| End-to-end | Playwright + Chrome, emulated Pixel 7 (`npm run test:e2e`) | 26 user journeys in a real browser. GPS, camera upload and all three APIs are simulated so runs are repeatable |
| Accessibility | Custom audit inside the E2E run, on 16 screens/states | Accessible names, target sizes ≥ 24 px (WCAG 2.2), alt text, a single h1, `lang`, WCAG 1.4.3 contrast for every visible text node |
| Manual / device | Chrome DevTools device mode, Android phone, iPhone Safari | Install prompt, offline mode, camera, GPS permission prompts, notifications |
| User testing | Think-aloud sessions (template below) | Usability of the core journeys |

## Results (latest automated run)

- **Unit:** 54 / 54 pass.
- **E2E:** 26 / 26 pass (twice in a row, to check for flakiness). There were no JavaScript console errors during the run.
- **Accessibility:** 0 issues on all 16 audited screens. The lowest text contrast was **4.86:1** in the light theme (the AA minimum is 4.5:1), 6.5:1 in dark, and 8.1:1 in high contrast at 130% text.
- **Performance (local server):** first contentful paint ≈ 50 ms; DOMContentLoaded ≈ 60 ms; 14 requests; app shell ≈ 200 KB uncompressed. Deriving the key (unlock) took ≈ 130 ms on a desktop CPU; expect roughly 0.5–1 s on a mid-range phone, so a spinner is shown. A photo was reduced from 124 KB (2400×1800) to 35 KB (1280×960).
- Raw output: `tests/e2e/last-run.json`; screenshots: `screenshots/`.

### E2E checks
1. First launch shows the welcome screen
2. Sign-up validates the password (length, common passwords, mismatch) and consent
3. Account creation → Today dashboard
4. Weather API fetched and displayed with advice and a 7-day forecast
5. GOV.UK bank holidays fetched
6. GPS updates the forecast; coordinates sent are rounded (56.46, −2.98)
7. City search (geocoding API) changes the location
8. IndexedDB/localStorage contain **no plaintext** (name, task titles, module code, city, password)
9. Search, filter chips and module filter
10. Add a task through the FAB, with validation and focus moved to the invalid field
11. Complete a task with an Undo toast
12. Steps checklist, plus camera photo (compressed, stored encrypted, displayed)
13. Week planner: 7 days, today highlighted, classes, forecast, navigation
14. Focus timer start/pause/resume/finish → break
15. Text size 130%, high contrast and dark theme apply instantly
16. Modules: duplicate code rejected, class end-before-start rejected
17. **Calendar import:** a Blackboard-style .ics file (UTC times, all-day exam, weekly RRULE, nested alarm) is previewed as 1 module, 1 class and 2 deadlines, then imported. Re-importing the same file updates 3 items with no duplicates
18. **Sample calendar and export:** existing modules/classes are flagged "Already added"; open deadlines download as a valid .ics file
19. Deadline notifications shown through the service worker
20. Reload → password required; wrong password rejected; data persists
21. A deep link while locked returns to that screen after unlocking
22. Service worker active, manifest valid, shell cached, **unlock and add a task fully offline**
23. Responsive at 360×740, 915×412 landscape and 1024×768 tablet with no horizontal overflow
24. An XSS payload in a task title is shown as text and never executes
25. Performance metrics recorded
26. No console errors

## Bugs found and fixed

| # | Bug | Cause | Fix |
|---|---|---|---|
| 1 | Straight after signing up, a first-time user was thrown back to the unlock screen | On first install, `clients.claim()` fires `controllerchange`; the update handler reloaded the page and wiped the in-memory key | Reload only when the user taps **Update** on the "new version" toast (`S.updateRequested`) |
| 2 | Sorting by module put tasks *without* a module first | `localeCompare` sorts the placeholder `'~'` before letters | Explicitly sort tasks with no module last (unit test added) |
| 3 | Encrypting photos larger than 64 KB threw an error | `crypto.getRandomValues` is limited to 65,536 bytes per call | Fill the buffer in 64 KB chunks (unit test with 200–300 KB buffers) |
| 4 | Weather card could re-render and re-fetch repeatedly when offline or on API error | The screen's `after()` hook re-triggered `loadWeather()` after every refresh | Added a 60-second retry guard and a `locating` state |
| 5 | Ending a focus session in its first minute said "0 min logged" | Rounding to whole minutes | Show "Session ended early – nothing was logged" |
| 6 | "Failed to fetch" shown to users | Raw browser `TypeError` message | Mapped to a friendly "network error – check your connection" |
| 7 | Due dates could shift by a day around midnight | Using `toISOString()` converts to UTC | All dates use local `YYYY-MM-DD` helpers; DST-safe `daysBetween` (unit tests cover the UK clock changes) |
| 8 | Imported deadlines showed the reminder text instead of the real description | The .ics parser read properties inside nested `VALARM` blocks as if they belonged to the event | The parser now tracks nesting depth and ignores properties of nested components (found by the export round-trip unit test) |

Testing also exposed two flaky tests (not app bugs): the plaintext check sometimes matched the 3-letter name "Sam" by chance inside random base64 ciphertext (now it searches for `"Sam"` as a JSON value), and Playwright's `.check()` retried on the *next* row after a completed task left the list. It now uses a single click.

**Debugging tools used:** Chrome DevTools (Console, Application › Service Workers / Cache Storage / IndexedDB, Network offline throttling, device toolbar, Lighthouse), Playwright failure screenshots, and `node --test` output.

## User testing (to complete with real participants)

Run 3–5 short think-aloud sessions (10 min each) on a phone. Record observations honestly; don't change them to look better.

| Task given to participant | P1 | P2 | P3 | P4 | P5 |
|---|---|---|---|---|---|
| Create an account | | | | | |
| Add "Essay draft" due Friday for a module, high priority | | | | | |
| Find everything due this week | | | | | |
| Photograph a sheet of paper and attach it to a task | | | | | |
| Start a 25-minute focus session | | | | | |
| Make the text bigger | | | | | |
| Use the app with Wi-Fi off | | | | | |

Record time taken, success (Y / with help / N) and comments. Finish with the 10-question **System Usability Scale (SUS)** and report the average score. List the changes you made because of the feedback.
