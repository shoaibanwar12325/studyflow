/* StudyFlow – boot.js
 * Runs before first paint: applies the user's display preferences (text size, contrast,
 * theme, reduced motion) so even the lock screen is accessible and there is no flash.
 * Only these non-sensitive preferences are kept unencrypted. */
(function () {
  try {
    var p = JSON.parse(localStorage.getItem('sf_prefs') || '{}');
    var root = document.documentElement;
    if (p.textScale) root.style.fontSize = (p.textScale * 100) + '%';
    if (p.theme) root.setAttribute('data-theme', p.theme);
    if (p.contrast) root.classList.add('high-contrast');
    if (p.reduceMotion) root.classList.add('reduce-motion');
  } catch (e) { /* storage unavailable – use defaults */ }
})();
