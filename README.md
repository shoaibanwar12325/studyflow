# StudyFlow – Student Planner & Task Manager (PWA)

CS52001 Mobile Application Development – MAB001 Mobile App Development Project.

StudyFlow is an offline-first Progressive Web App that helps university students manage deadlines, a weekly timetable and focused study time. Everything is **encrypted on the device** with a key derived from the user's password.

**Live app:** https://shoaibanwar12325.github.io/studyflow/

## Features and how they map to the brief

| Brief / marking checklist | How StudyFlow meets it |
|---|---|
| **User authentication** | Local account with password sign-up and unlock. PBKDF2-SHA256 (310,000 iterations) derives an AES-256-GCM key. Password policy and strength meter. Lockout after 5 wrong attempts. Auto-lock after inactivity. Change password re-encrypts all data. |
| **API integration** | **Open-Meteo** forecast (current conditions + 7 days, with student advice such as "take a waterproof for your 11:00 class"). **Open-Meteo Geocoding** (city search). **GOV.UK Bank Holidays** (Scotland / England & Wales / NI), shown on Today and in the Week planner. |
| **Sensors & hardware** | **GPS** (Geolocation API) for local weather, rounded to ~1 km. **Camera** (`capture="environment"`) to photograph assignment briefs or whiteboards; photos are compressed and encrypted. **Vibration** feedback. **Screen Wake Lock** during focus sessions. **Notifications** for deadlines. Touch **swipe gestures** in the Week planner. App **badge** count. |
| **Calendar import / export** | Import the timetable and deadlines from a student portal, Blackboard, Outlook or Google as a standard **.ics** file. Weekly lectures and labs become timetable classes, due dates and exams become tasks, and module codes (e.g. CS52001) become modules. Everything is previewed before import, re-importing updates instead of duplicating, and the file never leaves the device. Open deadlines export back to any calendar app as .ics, with a reminder the day before. A built-in sample university calendar lets anyone try it. |
| **Local storage** | IndexedDB: one encrypted vault for tasks, modules, timetable, settings and focus log, plus individually encrypted photos. Encrypted backup export (Web Share on phones) and restore. |
| **Navigation** | Bottom tab bar (Today, Tasks, Week, Focus, More), which becomes a side rail on tablets. Floating action button for adding tasks. Stack navigation with back buttons. |
| **Responsive** | Mobile-first CSS. Tested at 360×740, 412×915, landscape 915×412 and tablet 1024×768 with no horizontal overflow. |
| **Performance** | No framework. App shell is about 200 KB uncompressed, with 14 requests. Cache-first service worker. Debounced search and saves. Partial re-rendering. Images downscaled to 1280 px (124 KB → 35 KB in tests). The timer uses end timestamps, so it stays accurate when the screen is off. |
| **Accessibility** | Semantic HTML and ARIA labels. Live regions announce changes. Focus moves to each new screen's heading. Skip link. 48 px touch targets. Text size from 90–150%. High-contrast and dark themes. Reduce-motion setting. Colour is never the only cue. Every screen is audited automatically and meets WCAG AA contrast (lowest measured: 4.86:1). |
| **Security** | AES-256-GCM encryption at rest. A strict Content Security Policy. All user content is escaped (an XSS test is included). No third-party scripts. The password is never stored. Location coordinates are rounded before being sent. |
| **Ethics / GDPR** | Data minimisation, informed consent at sign-up, a plain-English privacy notice, export (portability) and "Delete all my data" (erasure). No analytics or tracking. An option to hide task names on the lock screen. |
| **Testing** | 54 unit tests (`node --test`) and 26 end-to-end checks (Playwright on an emulated Pixel 7). These include offline, GPS, camera, API, calendar import, security and accessibility checks. See [docs/TESTING.md](docs/TESTING.md). |

## Project structure

```
index.html          app shell (CSP, manifest link, tab bar, dialog, live regions)
style.css           all styles – themes, responsive layout, accessibility
app.js              screens, router, events, auth, sensors, notifications
manifest.json       PWA manifest (name, icons, start URL, standalone, shortcuts)
service-worker.js   offline caching (cache-first shell, network-first APIs), notification clicks
js/core.js          pure logic: dates, filtering, stats, validation, API parsing (unit-tested)
js/crypto.js        Web Crypto: PBKDF2 key derivation, AES-GCM encrypt/decrypt (unit-tested)
js/store.js         IndexedDB wrapper
js/api.js           Open-Meteo + GOV.UK fetches with timeouts, Geolocation wrapper
js/icons.js         inline SVG icons
js/ics.js           calendar (.ics) import/export: parser, timetable/deadline detection (unit-tested)
js/boot.js          applies display preferences before first paint
icons/              app icons (any + maskable, Apple touch icon)
tests/unit/         unit tests
tests/e2e/          Playwright end-to-end tests + API fixtures
tools/serve.mjs     zero-dependency local web server
docs/               design proposal, testing evidence, demo script, diagrams
```

## How to try it (for reviewers)

1. Open the live app on a phone or desktop browser.
2. Tap **Get started**, choose any password and leave **"Add example modules and tasks"** ticked.
3. Explore **Today**, **Tasks**, **Week** and **Focus**. Use **Use my location** on the weather card (GPS) and **Take photo** on a task (camera).
4. Go to **More › Import calendar (.ics)** and tap **Try a sample university calendar**. Review the preview, then import it and see the Week planner fill up. You can also choose a real .ics export from a student portal.
5. Turn on airplane mode and reopen the app to see it working offline.

## Run it locally

You need Node.js 20 or newer. There are no npm packages to install.

```bash
npm start            # → http://localhost:8080
npm test             # 54 unit tests
npm run test:e2e     # 26 E2E checks (needs Playwright + Chrome: npm i -D playwright && npx playwright install chromium)
```

`localhost` counts as a secure context, so the service worker, Web Crypto, GPS and camera all work without HTTPS. Opening `index.html` directly from the file system will **not** work: service workers and IndexedDB need a server.

## Deploy (HTTPS is required for a PWA)

**GitHub Pages:** push this folder to a GitHub repository, then go to **Settings › Pages**, choose *Deploy from a branch* and pick `main` / root. The app will be at `https://<user>.github.io/<repo>/`.

**Netlify:** drag the folder onto <https://app.netlify.com/drop>.

All paths are relative, so the app works from a sub-folder (as on GitHub Pages).

## Install and demo on a phone

- **Android (Chrome):** open the URL, tap **Install** (on the Today card or under More), then launch from the home screen.
- **iPhone (Safari):** tap **Share › Add to Home Screen**. Notifications on iOS only work once the app is installed.
- **Emulator:** Chrome DevTools › Device toolbar (Ctrl+Shift+M). Simulate offline under Application › Service Workers › *Offline*.

See [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) for a timed 5-minute demo.

## APIs used

- Open-Meteo Forecast API – https://open-meteo.com/en/docs (free, no key, CC BY 4.0 data)
- Open-Meteo Geocoding API – https://open-meteo.com/en/docs/geocoding-api
- GOV.UK Bank Holidays – https://www.gov.uk/bank-holidays.json (Open Government Licence)
