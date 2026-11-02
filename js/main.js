// OSMC Log Analyzer – main.js: Language switch, file loading and start-up. Loaded last.
// See the comment at the top of index.html for how the files fit together.
'use strict';

// ---------- language ----------
// The loaded log ({ log, name, size }), kept so the page can be re-rendered on a language switch.
let current = null;
// A newly loaded log always opens on the overview; a language switch keeps the current tab.
let activeTab = 'overview';
// The Kodi log shown in the Kodi log tab (current or previous), kept when the page is re-rendered.
let klLog = '';
// Translates the static texts (data-i18n / data-i18n-html) and re-renders the result view, if any.
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = T(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = T(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = T(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('#langsw button').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
  showTheme();
  if (current) render(current.log, current.name, current.size); else document.title = T('OSMC Log Analyzer');
}
// DA/EN buttons: load the language file first, then switch and remember the choice.
document.getElementById('langsw').onclick = async e => {
  const b = e.target.closest('button');
  if (!b || b.dataset.lang === lang) return;
  await loadLang(b.dataset.lang);
  lang = b.dataset.lang;
  try { localStorage.setItem('osmclog.lang', lang); } catch {}
  applyLang();
};

// ---------- light/dark ----------
// The page always starts dark (data-theme on <html>); the button switches to light and back for this visit.
// It shows the mode it switches to: a sun in dark mode, a moon in light mode.
const themeBtn = document.getElementById('theme');
function showTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeBtn.textContent = dark ? '☀' : '☾';
  themeBtn.title = T(dark ? 'Switch to light mode' : 'Switch to dark mode');
  themeBtn.setAttribute('aria-label', themeBtn.title);
}
themeBtn.onclick = () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  showTheme();
};
showTheme();

// ---------- loading ----------
const drop = document.getElementById('drop'), fileIn = document.getElementById('file'), pasteIn = document.getElementById('paste');
// Reads a log file (File object) and shows the result.
async function load(file) {
  const buf = await file.arrayBuffer();
  loadText(new TextDecoder('utf-8').decode(buf), file.name, file.size);
}
// Splits a log's text and shows the result (name and size are shown in the header). Waits for the language
// file and the banned list so the first render is complete.
async function loadText(text, name, size) {
  const log = parseLog(fixMojibake(text));
  await Promise.all([bannedReady, langReady]);
  if (!log.sections.length) {
    // a paste.osmc.tv link instead of the log: the site doesn't allow other pages to fetch from it
    const paste = /^\s*https?:\/\/paste\.osmc\.tv\/(?:raw\/)?(\w+)/.exec(text);
    alert(paste ? T('The page can’t open paste.osmc.tv links itself. Open {0}, select all the text (Ctrl+A), copy it and paste it here.', `https://paste.osmc.tv/raw/${paste[1]}`)
      : T('Could not find any OSMC log sections in the file. Is it a log from grab-logs?'));
    return;
  }
  try {
    activeTab = 'overview'; klLog = '';
    render(log, name, size);
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    alert(T('Error during analysis: {0}', err.message));
    return;
  }
  current = { log, name, size };
  document.getElementById('start').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('tabs').hidden = false;
  document.getElementById('reload').hidden = false;
  document.getElementById('repaste').hidden = false;
}
// File picker: the drop zone and the "Load another log" button both open it. The value is cleared so
// choosing the same file again still triggers a change.
drop.onclick = () => fileIn.click();
document.getElementById('reload').onclick = () => fileIn.click();
fileIn.onchange = () => { if (fileIn.files[0]) load(fileIn.files[0]); fileIn.value = ''; };
// Drag & drop works anywhere on the page; the drop zone is highlighted while a file is dragged over it.
['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) drop.classList.remove('over'); }));
document.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) load(f); });
// Pasting: into the field on the start screen, or with Ctrl+V anywhere on the page except in a search field
// (so another log can be pasted while one is shown). The text is not put into the field, as a log can be
// several MB; a pasted file (copied in a file manager) is loaded like a dropped one.
document.addEventListener('paste', e => {
  if (e.target !== pasteIn && e.target.closest?.('input, textarea, select')) return;
  e.preventDefault();
  const f = e.clipboardData.files[0], text = e.clipboardData.getData('text/plain');
  if (f) load(f);
  else if (text.trim()) loadText(text, T('Pasted log'), new Blob([text]).size);
  pasteIn.value = '';
});
// "Paste another log" button: reads the clipboard (the browser may ask for permission first). Where reading the
// clipboard isn't allowed, Ctrl+V still works.
document.getElementById('repaste').onclick = async () => {
  let text;
  try { text = await navigator.clipboard.readText(); } catch {}
  if (text == null) alert(T('The browser doesn’t let the page read the clipboard. Copy the log and press Ctrl+V on the page instead.'));
  else if (!text.trim()) alert(T('The clipboard is empty. Copy the whole log first.'));
  else loadText(text, T('Pasted log'), new Blob([text]).size);
};
// Start-up: load the banned list and the language file in parallel; load() waits for both.
const bannedReady = loadBanned();
const langReady = loadLang(lang).then(applyLang);
