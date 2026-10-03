'use strict';

// Line glyphs keyed by the producer's /assets/*.svg names, drawn in currentColor
// so they follow the theme.
const GLYPHS = {
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9v3h-2v3h-3v-3"/>',
  github: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10"/><path d="M18 17V9a3 3 0 0 0-3-3h-4"/><path d="m13 4-2 2 2 2"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  mail: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="m3 8 9 6 9-6"/>',
  chat: '<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>',
  rocket: '<path d="M12 3c3 2 5 6 5 10l-2 3H9l-2-3c0-4 2-8 5-10z"/><circle cx="12" cy="10" r="1.6"/><path d="m9 16-2 4 3-1M15 16l2 4-3-1"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  quiet: '<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>',
};

function glyphName(item) {
  const m = /\/assets\/([a-z0-9-]+)\.svg$/i.exec((item && item.image) || '');
  if (m && GLYPHS[m[1]]) return m[1];
  if (item && item.lane === 'need-you') return 'key';
  if (item && item.lane === 'worth-knowing') return 'rocket';
  return 'quiet';
}

function glyph(item) {
  const span = document.createElement('span');
  span.className = 'glyph';
  span.setAttribute('aria-hidden', 'true');
  const img = (item && item.image) || '';
  if (img && !/^\/assets\//.test(img) && /^(https?:)?\//.test(img)) {
    const i = document.createElement('img');
    i.src = img;
    i.alt = '';
    span.appendChild(i);
  } else {
    span.innerHTML = `<svg viewBox="0 0 24 24">${GLYPHS[glyphName(item)]}</svg>`;
  }
  return span;
}
