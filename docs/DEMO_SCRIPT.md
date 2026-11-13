# 5-Minute Demo Script

The order follows the Presentation Marking Report. Practise it at least twice (Demo Checklist tip).

**Before the demo:** the app is deployed over HTTPS (GitHub Pages/Netlify) and installed on your phone. Create an account with the sample data on. Have a sheet of paper ready to photograph. Have DevTools open on a laptop as a backup. Charge the phone and turn on screen mirroring.

| Time | What to show | What to say |
|---|---|---|
| 0:00–0:30 | Home-screen icon → launch (full screen, no browser bar) | "StudyFlow is a student planner built as a PWA, installed like a native app. It works offline and encrypts everything on the device." |
| 0:30–1:15 | **Unlock**: type a wrong password, then the right one | "Authentication is local: PBKDF2 derives an AES-256 key from the password. A wrong password fails the GCM check, so the password is never stored. Five wrong tries trigger a lockout, and it auto-locks when idle." |
| 1:15–2:00 | **Today**: progress ring, stats, weather card → **Use my location** | "API integration: Open-Meteo forecast with advice tied to my first class. GPS is a sensor. I round coordinates to about 1 km before they leave the phone, which is data minimisation." Show **Change city** (geocoding API) and the bank holiday line (GOV.UK API). |
| 2:00–2:50 | **Tasks**: search, filter chip, **+** add a task (submit empty first to show validation), tick one → Undo. Open a task → add a step → **Take photo** | "Bottom tabs plus a floating action button follow Material Design. Errors appear inline and are read out by screen readers. The camera photo is downscaled to 1280 px and encrypted separately, so saving stays fast." |
| 2:50–3:20 | **More › Import calendar (.ics)** → *Try a sample university calendar* → preview → **Import**; the **Week** planner fills up. Swipe between weeks | "Students don't want to retype what the portal already has, so StudyFlow imports the portal's standard calendar file. It detects module codes, weekly classes and deadlines, flags duplicates, and processes the file entirely on the phone. It also exports deadlines back to Google or Outlook. The Week view combines classes, deadlines, bank holidays and the forecast, and swipe gestures have button alternatives." |
| 3:20–3:45 | **Focus**: start the timer | "Pomodoro timer. Screen Wake Lock keeps the display on, and it vibrates and notifies when done. It stores the end time, not a countdown, so it stays accurate even when the browser throttles timers while the phone sleeps." |
| 3:45–4:15 | **Offline**: airplane mode → reopen → add a task. **More**: text size, high contrast, dark mode | "The service worker caches the app shell cache-first and APIs network-first. Accessibility: text size up to 150%, high contrast, reduced motion, 48 px targets, and WCAG AA contrast verified on every screen." |
| 4:15–5:00 | Laptop: `npm test` and `npm run test:e2e` output, DevTools › Application › Service Workers / IndexedDB (show ciphertext) | "54 unit tests and 26 Playwright end-to-end tests, including offline, XSS and accessibility audits. Biggest challenge: a service worker `controllerchange` reload that logged new users out. I found it with E2E tests and fixed it." |

## Likely questions – prepare answers

- **Why a PWA, not Flutter or native?** One codebase, no app store and offline support. The module recommends it. The trade-offs are limited hardware access and iOS notification limits.
- **What if I forget my password?** It can't be recovered, by design. Restore an encrypted backup or reset. Users are told this at sign-up (informed consent).
- **Why PBKDF2 with 310,000 iterations?** It slows down brute-force attacks; this is the OWASP guidance for PBKDF2-SHA256. Argon2 isn't available in Web Crypto.
- **How do you stop XSS?** All user text is escaped before rendering, there's a strict CSP (`script-src 'self'`), and an automated test injects a payload.
- **How is it responsive?** Mobile-first CSS with rem units. Tabs become a side rail at 768 px. Tested at four sizes.
- **What does the service worker do on update?** Versioned cache, old caches deleted on activate, and a "new version" toast with an Update button.
- **GDPR?** No server and no tracking. Consent prompts for location, camera and notifications. Export (portability) and delete-all (erasure).
- **Why not connect directly to the university portal?** Official access needs the university to register the app (OAuth/LTI). Scraping with a student's password would be insecure and against IT policy. The standard .ics export gives the same data safely.
- **What would you add next?** Biometric unlock (WebAuthn), automatic refresh from a subscribed portal calendar link, optional end-to-end-encrypted sync, and push reminders while the app is closed.

## Backup plan

If the phone fails, use Chrome DevTools device emulation (Pixel 7) on the laptop with the Network tab set to *Offline*.
