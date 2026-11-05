// OSMC Log Analyzer – banned.js: Kodi's banned add-ons list: loading, matching installed add-ons and the overview card.
// See the comment at the top of index.html for how the files fit together.
'use strict';

// ---------- banned add-ons (kodi.wiki) ----------
// Kodi keeps an example list of banned builds, repositories and add-ons on its wiki. The page's wikitext is
// fetched through the MediaWiki API, which sends Access-Control-Allow-Origin: *, so the browser can fetch it
// directly. Two copies can exist: banned-wiki.json on the server (fetched from the wiki when the page is updated there) and one saved in
// this browser by the "Update from kodi.wiki" button; whichever has the newest wiki edit is used.
const BANNED_PAGE = 'https://kodi.wiki/view/Official:Forum_rules/Banned_add-ons';
const BANNED_API = 'https://kodi.wiki/api.php?action=query&prop=revisions&titles=Official:Forum_rules/Banned_add-ons&rvprop=content|timestamp&rvslots=main&format=json&formatversion=2&origin=*';
// Parsed list in use: { ids: Map, names: Map, count, changed, fetched, source } or null when none is loaded.
let banned = null;
// Lower-case letters and digits only, so "Universal Scrapers" and "universalscrapers" compare equal.
const normName = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Wikitext lines look like "* Name <!-- ID: repository.x|plugin.video.x -->" under "== Section ==" headings.
// Some names are written as "<Name>" and some ID comments are malformed (e.g. ending in "?>"); both are tolerated.
// json: MediaWiki API response; fetched: ISO date of download; source: 'server' or 'browser'.
function parseBanned(json, fetched, source) {
  const rev = json.query.pages[0].revisions[0];
  const ids = new Map(), names = new Map();
  let sec = '', count = 0;
  for (const l of rev.slots.main.content.split('\n')) {
    let m;
    if ((m = /^==+\s*(.*?)\s*==+/.exec(l))) { sec = m[1]; continue; }
    if (!l.startsWith('*')) continue;
    const name = l.slice(1).replace(/<!--.*$/, '').trim().replace(/^<|>$/g, '').trim();
    if (!name) continue;
    const e = { section: sec, name };
    count++;
    // the comment usually starts with "ID:", but some entries have the IDs alone ("<!-- script.module.cocoscrapers -->"),
    // so anything in the comment that looks like an add-on ID counts
    const idm = /<!--\s*(?:ID:\s*)?(.*?)\s*(?:-->|\?>|$)/.exec(l);
    if (idm) for (const id of idm[1].split('|')) { const k = id.trim().toLowerCase(); if (/^[\w-]+(?:\.[\w-]+)+$/.test(k)) ids.set(k, e); }
    // forks and wizards are not add-on names, so they are not used for name matching
    const n = normName(name);
    if (n.length >= 3 && !/fork|wizard/i.test(sec)) names.set(n, e);
  }
  return { ids, names, count, changed: rev.timestamp, fetched, source };
}
// addons: Map id -> { ver, logs }. Exact ID hit = banned; name of the add-on matching a list entry = possibly banned.
// For the name match the type prefix is dropped: "plugin.video.pov" -> "pov", "repository.umbrella" -> "umbrella".
// -> [{ id, ver, logs, entry: { section, name }, how: 'id' | 'name' }], ID hits first.
function matchBanned(addons) {
  const out = [];
  if (!banned) return out;
  for (const [id, info] of addons) {
    const hit = banned.ids.get(id.toLowerCase());
    if (hit) { out.push({ id, ...info, entry: hit, how: 'id' }); continue; }
    const p = id.split('.');
    if (!['plugin', 'repository', 'script', 'program'].includes(p[0]) || p.length < 2) continue;
    const rest = normName((p[0] === 'repository' || p.length === 2 ? p.slice(1) : p.slice(2)).join(''));
    const e = banned.names.get(rest);
    if (e) out.push({ id, ...info, entry: e, how: 'name' });
  }
  return out.sort((a, b) => (a.how === b.how ? a.id.localeCompare(b.id) : a.how === 'id' ? -1 : 1));
}
// Called once at start-up: reads the browser copy (localStorage) and the server copy (banned-wiki.json).
async function loadBanned() {
  const cand = [];
  try {
    const c = JSON.parse(localStorage.getItem('osmclog.banned') || 'null');
    if (c) cand.push(parseBanned(c.json, c.fetched, 'browser'));
  } catch {}
  try {
    const r = await fetch('banned-wiki.json', { cache: 'no-cache' });
    if (r.ok) {
      const lm = r.headers.get('Last-Modified');
      cand.push(parseBanned(await r.json(), lm ? new Date(lm).toISOString() : '', 'server'));
    }
  } catch {}
  // use whichever copy has the newest wiki edit
  cand.sort((a, b) => (b.changed || '').localeCompare(a.changed || ''));
  banned = cand[0] || null;
}
// "Update from kodi.wiki" button: fetches the live list and saves it in this browser. Throws on failure.
async function refreshBanned() {
  const r = await fetch(BANNED_API, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const json = await r.json();
  const fetched = new Date().toISOString();
  banned = parseBanned(json, fetched, 'browser');
  try { localStorage.setItem('osmclog.banned', JSON.stringify({ json, fetched })); } catch {}
}
// Red "Banned" / amber "Possibly banned" badge for a match, '' for no match.
const bannedBadge = m => m ? (m.how === 'id' ? badge(T('Banned'), 'bad') : badge(T('Possibly banned'), 'warn')) : '';
// The "Banned add-ons" card on the overview: matches, list source/date and the update button.
// The button is handled by the click handler on #panels in render() (data-action="refresh-banned").
function bannedCard(matches, total) {
  let body;
  if (!banned) body = `<p class="empty">${esc(T('The banned add-ons list is not loaded.'))}</p>`;
  else if (!matches.length) body = `<ul class="obs"><li class="ok">${esc(T('No known banned add-ons among the {0} installed.', total))}</li></ul>`;
  else body = table([T('Add-on'), T('Version'), T('Status'), T('List entry')], matches.map(m => [
    raw(`<code>${esc(m.id)}</code>`), m.ver, raw(bannedBadge(m) + (m.how === 'name' ? ` <span class="muted">${esc(T('name match'))}</span>` : '')),
    `${m.entry.name} (${m.entry.section})`,
  ]), { cols: ['36%', '14%', '22%', '28%'] });
  const src = banned ? T('Source: {0} · {1} entries, {2} IDs · list changed {3} · fetched {4} ({5})',
    `<a href="${BANNED_PAGE}" target="_blank" rel="noopener">kodi.wiki</a>`, banned.count, banned.ids.size, esc(fmtDate(banned.changed)),
    esc(fmtDate(banned.fetched) || '?'), esc(banned.source === 'server' ? T('copy on the server') : T('in this browser'))) : '';
  return card(T('Banned add-ons'), body + `<div class="toolbar" style="margin:10px 0 0">
      <button data-action="refresh-banned">${esc(T('Update from kodi.wiki'))}</button><span class="muted" id="banned-status">${src}</span></div>
      <p class="muted" style="margin:6px 0 0;font-size:12.5px">${esc(T('The list is only examples. An add-on not being on the list does not mean it is allowed.'))}</p>`,
    esc(T('according to the Kodi forum rules')));
}
// ISO date -> local date and time in the current language.
const fmtDate = s => s ? new Date(s).toLocaleString(lang === 'da' ? 'da-DK' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
