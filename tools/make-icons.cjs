// Generates PNG app icons from SVG using sharp. Run: node tools/make-icons.cjs
const sharp = require('sharp'); // install first: npm i -D sharp
const path = require('path');
const out = p => path.join(__dirname, '..', 'icons', p);
const glyph = (s) => `
  <g transform="translate(${256 - 256 * s} ${256 - 256 * s}) scale(${s})">
    <rect x="128" y="112" width="256" height="304" rx="40" fill="#FFFFFF"/>
    <rect x="128" y="112" width="256" height="72" rx="36" fill="#F59E0B"/>
    <rect x="128" y="150" width="256" height="34" fill="#F59E0B"/>
    <circle cx="192" cy="112" r="18" fill="#3B4CCA" stroke="#FFFFFF" stroke-width="10"/>
    <circle cx="320" cy="112" r="18" fill="#3B4CCA" stroke="#FFFFFF" stroke-width="10"/>
    <path d="M186 292 l46 46 l94 -102" fill="none" stroke="#3B4CCA" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;
const icon = (rounded, s) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A5BE0"/><stop offset="1" stop-color="#2D3AA6"/></linearGradient></defs>
  <rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="url(#g)"/>${glyph(s)}</svg>`);
const badge = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><path d="M22 50 l16 16 l36 -38" fill="none" stroke="#000" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
(async () => {
  await sharp(icon(true, 1)).resize(512).png().toFile(out('icon-512.png'));
  await sharp(icon(true, 1)).resize(192).png().toFile(out('icon-192.png'));
  await sharp(icon(false, 0.78)).resize(512).png().toFile(out('maskable-512.png'));
  await sharp(icon(false, 0.9)).resize(180).png().toFile(out('apple-touch-icon.png'));
  await sharp(badge).png().toFile(out('badge-96.png'));
  console.log('icons written');
})();
