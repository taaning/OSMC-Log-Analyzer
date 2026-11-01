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
const drop = document.getElementById('drop'), fileIn = document.getElementById('file');
// Reads a log file (File object), splits it and shows the result. Waits for the language file and the
// banned list so the first render is complete.
async function load(file) {
  const buf = await file.arrayBuffer();
  const text = fixMojibake(new TextDecoder('utf-8').decode(buf));
  const log = parseLog(text);
  await Promise.all([bannedReady, langReady]);
  if (!log.sections.length) { alert(T('Could not find any OSMC log sections in the file. Is it a log from grab-logs?')); return; }
  try {
    activeTab = 'overview'; klLog = '';
    render(log, file.name, file.size);
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    alert(T('Error during analysis: {0}', err.message));
    return;
  }
  current = { log, name: file.name, size: file.size };
  drop.hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('tabs').hidden = false;
  document.getElementById('reload').hidden = false;
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
// Start-up: load the banned list and the language file in parallel; load() waits for both.
const bannedReady = loadBanned();
const langReady = loadLang(lang).then(applyLang);
