// OSMC Log Analyzer – core.js: Translations (T) and small helpers that build HTML strings and format values.
// See the comment at the top of index.html for how the files fit together.
'use strict';

// ---------- i18n ----------
// English source text is the key; lang/<code>.json maps it to the shown text. {0}, {1}… are placeholders.
// A missing key falls back to the English text, so a missing or broken file never breaks the page.
const LANGS = {};   // loaded language files: { en: {...}, da: {...} }
// English is the default; a language picked with the DA/EN buttons is remembered. To add a language,
// add it here, add a button in the header and create lang/<code>.json.
let lang = 'en';
try { lang = localStorage.getItem('osmclog.lang') || 'en'; } catch {}
if (!['en', 'da'].includes(lang)) lang = 'en';
// Fetches lang/<code>.json once; a failed fetch is stored as {} so T() falls back to English.
async function loadLang(code) {
  if (LANGS[code]) return;
  try {
    const r = await fetch(`lang/${code}.json`, { cache: 'no-cache' });
    LANGS[code] = r.ok ? await r.json() : {};
  } catch { LANGS[code] = {}; }
}
// T('English text', arg0, arg1 …) -> translated text with {0}, {1} … filled in. Returns plain text (not HTML-escaped).
const T = (s, ...a) => ((LANGS[lang] && LANGS[lang][s]) || s).replace(/\{(\d)\}/g, (_, i) => a[i]);

// ---------- helpers ----------
// Most of the page is built as HTML strings. Values from the log are untrusted, so they are always
// passed through esc() — or wrapped in raw() when a value is HTML we built ourselves.

// Text that grab-logs puts in place of passwords and other private values.
const MASK = '**masked*by*grab-logs**';
// Escapes text for safe use inside HTML.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Marks a string as ready-made HTML so kv()/table() insert it as-is instead of escaping it.
class Raw { constructor(h) { this.h = h; } }
const raw = h => new Raw(h);
// Cell content: raw HTML stays, anything else is escaped.
const val = v => v instanceof Raw ? v.h : esc(v);
// Small pill label. cls: '' (grey), 'ok' (green), 'warn' (amber), 'bad' (red), 'acc' (blue).
const badge = (t, cls = '') => `<span class="badge ${cls}">${esc(t)}</span>`;
// Shows true/'true' and false/'false' as Yes/No badges; other values are passed through unchanged.
const yesNo = v => v === true || v === 'true' ? raw(badge(T('Yes'), 'ok')) : v === false || v === 'false' ? raw(badge(T('No'))) : v;
// Replaces a value masked by grab-logs with a "masked" badge.
const unmask = v => String(v ?? '').includes(MASK) ? raw(badge(T('masked by grab-logs'))) : v;

// Two-column key/value table from [[label, value], …]. Rows with an empty value are skipped.
function kv(rows) {
  rows = rows.filter(r => r && r[1] !== undefined && r[1] !== null && r[1] !== '');
  if (!rows.length) return `<p class="empty">${esc(T('No data'))}</p>`;
  return '<div class="tw"><table class="kv">' + rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${val(v)}</td></tr>`).join('') + '</table></div>';
}
// Data table. rows: arrays of cell values; a row may carry a .cls property for a CSS class on the <tr>
// (e.g. 'changed' for the blue left border). opts.scroll: limit the height and scroll inside the card.
// The table is wrapped in .tw so wide tables scroll sideways on phones instead of widening the page.
function table(headers, rows, opts = {}) {
  if (!rows.length) return `<p class="empty">${esc(T('No data'))}</p>`;
  const body = rows.map(r => {
    const cls = r.cls ? ` class="${r.cls}"` : '';
    return `<tr${cls}>` + r.map(c => `<td>${val(c)}</td>`).join('') + '</tr>';
  }).join('');
  // opts.cols: fixed column widths (e.g. ['45%', '35%', '20%']) so rows line up and long values wrap
  const cols = opts.cols ? `<colgroup>${opts.cols.map(w => `<col style="width:${w}">`).join('')}</colgroup>` : '';
  const t = `<table${opts.cols ? ' class="fixed"' : ''}>${cols}<thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  return `<div class="tw${opts.scroll ? ' scroll' : ''}">${t}</div>`;
}
// A boxed section with a title. body is HTML; sub is a small grey HTML note after the title (escape it yourself).
const card = (title, body, sub = '') => `<section class="card"><h3>${esc(title)}${sub ? ` <span class="sub">${sub}</span>` : ''}</h3>${body}</section>`;
// Usage bar; turns amber from 80 % and red from 90 %.
const bar = pct => `<div class="bar"><span class="${pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : ''}" style="width:${Math.min(100, pct)}%"></span></div>`;
// Decodes the basic XML entities found in setting values.
const xmlDecode = s => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Seconds -> "2 d 3 h 15 min" ("t" for hours in Danish; seconds are only shown for durations under an hour).
function fmtDuration(sec) {
  sec = Math.round(sec);
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const hu = lang === 'en' ? ' h' : ' t';
  return [d && d + ' d', h && h + hu, m && m + ' min', (!d && !h) && s + ' s'].filter(Boolean).join(' ');
}
// Bytes -> "1.3 MB".
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

// grab-logs sometimes double-encodes UTF-8 (e.g. "OvervÃ¥gning"); repair those lines.
function fixMojibake(text) {
  const dec = new TextDecoder('utf-8', { fatal: true });
  return text.replace(/[^\n]*[\u00c2-\u00df][\u0080-\u00bf][^\n]*/g, line => {
    if (/[^\u0000-\u00ff]/.test(line)) return line;
    try { return dec.decode(Uint8Array.from(line, c => c.charCodeAt(0))); } catch { return line; }
  });
}
