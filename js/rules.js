// OSMC Log Analyzer – rules.js: Problem checks (RULES) shown in the Problems tab and the overview, and the known harmless messages.
// See the comment at the top of index.html for how the files fit together.
'use strict';

// ---------- problems ----------
// Rule-based checks. The results are shown in the Problems tab, with advice and the log lines that triggered
// them, and as a short list in the overview's Observations card. Every rule has a category, and categories
// can be switched off in the Problems tab (remembered in this browser).
//
// A rule is { cat, check(d) }: check gets the data object from buildData() (js/render.js) and returns a finding, an array
// of findings (false/undefined entries are skipped) or nothing. A finding is { sev, text, hint, ev }:
//   sev   'bad' (red), 'warn' (amber), 'info' (blue) or 'ok' (green)
//   text  what was found          hint  what to do about it (optional)
//   ev    evidence from find(): { hits: [{ sec, line, n, text }], count } (optional)
// Many patterns are problems that OSMC forum helpers often point out in users' logs.
// To add a check: add a rule to RULES and its texts to lang/en.json and lang/da.json. A check that only counts
// matching lines is written as data with simple() (see below); one that needs more logic is a check function.

// problem categories in display order: id -> English label
const CATS = {
  addons: 'Add-ons', shares: 'Network shares', network: 'Network', crashes: 'Crashes & errors', storage: 'Storage & memory',
  hardware: 'Hardware & power', display: 'Display', audio: 'Audio', playback: 'Playback', updates: 'Updates & packages', database: 'Database',
  settings: 'Kodi settings', log: 'About the log',
};
const SEV_ORDER = { bad: 0, warn: 1, info: 2, ok: 3 };
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Kodi log sections, and the section with kernel/system messages (the journal includes the kernel's messages,
// so the kernel log is only used when there is no journal)
const KODI = ['Kodi Log', 'Kodi Old Log'];
const sysSec = d => d.log.sec('System Journal').trim() ? 'System Journal' : 'Kernel Message Log';
// matches Kodi log lines logged at error level (or worse) whose message matches re
const kodiErr = re => new RegExp(String.raw`\s(?:error|fatal) <[^>]+>: .*(?:` + re.source + ')', re.flags);

// Finds the lines of one or more sections that match test (a regex without the g flag, or a function)
// -> { hits (at most max), count }. line is the 0-based line within the section (for jumping to Raw sections),
// n the line number in the file. Missing sections are skipped. With perEntry, only the first matching line of
// each log entry counts (an entry is a line that doesn't start with whitespace plus its indented continuation lines).
function find(d, secs, test, max = 50, perEntry = false) {
  const ok = typeof test === 'function' ? test : l => test.test(l);
  const ev = { hits: [], count: 0 };
  for (const name of [].concat(secs)) {
    const s = d.log.byName[name];
    if (!s) continue;
    let entry = -1, counted = -1;
    s.lines.forEach((l, j) => {
      if (!/^\s/.test(l)) entry = j;
      if (!ok(l) || (perEntry && counted === entry)) return;
      counted = entry;
      ev.count++;
      if (ev.hits.length < max) ev.hits.push({ sec: name, line: j, n: s.startLine + j, text: l });
    });
  }
  return ev;
}
// finding from a find() result: nothing if no lines matched; text/hint get the number of matches as {0}
const found = (sev, ev, text, hint) => ev.count ? { sev, text: T(text, ev.count), hint: hint && T(hint), ev } : null;

// A simple check written as data instead of code: count the lines that match and report them with their count.
// simple(def) turns it into a rule; def stays on the rule (rule.def).
//   cat, sev   category and severity of the finding
//   in         sections to search: section names, 'kodi' (current and previous Kodi log) and/or 'system'
//              (the system journal, or the kernel log when there is no journal)
//   match      a regex, or a list of regexes of which one must match
//   not        lines that also match this regex don't count (optional)
//   kodiError  only Kodi log lines logged at error level or worse count (optional)
//   min        fewest matching lines for a finding (default 1)
//   perEntry   count a log entry with continuation lines once (see find())
//   text, hint English texts (keys in lang/*.json); {0} is the number of matching lines
const simple = def => ({ cat: def.cat, def, check: d => {
  const secs = [].concat(def.in).flatMap(s => s === 'kodi' ? KODI : s === 'system' ? [sysSec(d)] : [s]);
  const res = [].concat(def.match).map(re => def.kodiError ? kodiErr(re) : re);
  const ev = find(d, secs, l => res.some(re => re.test(l)) && !(def.not && def.not.test(l)), 50, def.perEntry);
  return ev.count >= (def.min || 1) && found(def.sev, ev, def.text, def.hint);
} });

// Python errors in add-ons -> { ev, ids }. Kodi logs one as "EXCEPTION Thrown …" followed by the traceback, where the
// add-on is named by a file path. The culprit is the first add-on in the traceback that is not a shared module
// (script.module.urllib3 …); the traceback ends at the next timestamped line.
function pythonErrors(d) {
  let ev = find(d, KODI, /EXCEPTION Thrown/);
  if (!ev.count) ev = find(d, KODI, /Traceback \(most recent call last\)/);
  const ids = new Set();
  for (const h of ev.hits) {
    const lines = d.log.byName[h.sec].lines, inTrace = [];
    for (let j = h.line; j < Math.min(lines.length, h.line + 60); j++) {
      if (j > h.line && /^\d{4}-\d\d-\d\d /.test(lines[j])) break;
      const m = /addons\/((?:plugin|script|service|skin|context|metadata|resource|repository|weather|screensaver)\.[\w.-]+)\//.exec(lines[j]);
      if (m) inTrace.push(m[1]);
    }
    const id = inTrace.find(x => !x.startsWith('script.module.')) || inTrace[0];
    if (id) ids.add(id);
  }
  return { ev, ids };
}

// Kodi's view modes (defaultvideosettings/viewmode)
const VIEWMODES = ['Normal', 'Zoom', 'Stretch 4:3', 'Wide zoom', 'Stretch 16:9', 'Original size', 'Custom', 'Stretch 16:9 (non-linear)', 'Zoom 120% width', 'Zoom 110% width'];

const RULES = [
  // --- add-ons ---
  { cat: 'addons', check: d => {
    const ev = list => find(d, KODI, new RegExp(`CAddonMgr::FindAddons: (?:${list.map(m => reEsc(m.id)).join('|')}) v`));
    const ids = d.bannedMatches.filter(m => m.how === 'id'), names = d.bannedMatches.filter(m => m.how === 'name');
    return [
      ids.length && { sev: 'bad', text: T('Banned add-ons installed: {0}.', ids.map(m => m.id).join(', ')),
        hint: T('No support is given on the Kodi and OSMC forums while they are installed. Remove them and make a new log.'), ev: ev(ids) },
      names.length && { sev: 'warn', text: T('Possibly banned add-ons (name matches the list): {0}.', names.map(m => m.id).join(', ')), ev: ev(names) },
    ];
  } },
  { cat: 'addons', check: d => d.kodi && d.kodi.repoErrors.size && { sev: 'warn', text: T('Outdated or broken repositories: {0}.', [...d.kodi.repoErrors].join(', ')),
    hint: T('Kodi could not update from these repositories. Remove repositories that are no longer maintained.'), ev: find(d, 'Kodi Log', kodiErr(/Repository add-on \S+ /)) } },
  { cat: 'addons', check: d => {
    const { ev, ids } = pythonErrors(d);
    if (!ev.count) return;
    return { sev: 'warn', text: ids.size ? T('Python errors in add-ons ({0}×): {1}.', ev.count, [...ids].join(', ')) : T('Python errors in add-ons ({0}×).', ev.count),
      hint: T('Update the add-on or ask its author for help. Errors in third-party add-ons are not OSMC problems.'), ev };
  } },

  // --- network shares ---
  { cat: 'shares', check: d => {
    const ev = find(d, KODI, kodiErr(/SMBDirectory.*Unable to open directory|CSMBFile::\w+.*(?:error|failed)|SMB: .*(?:error|failed)/i));
    if (!ev.count) return;
    // the reason is quoted at the end of the line, e.g. error : 'Permission denied'
    const why = [...new Set(ev.hits.map(h => (/error\s*:\s*'([^']+)'/i.exec(h.text) || [])[1]).filter(Boolean))];
    return { sev: 'bad', text: why.length ? T('Kodi could not open SMB (Windows) shares ({0}×): {1}.', ev.count, why.join('; ')) : T('Kodi could not open SMB (Windows) shares ({0}×).', ev.count),
      hint: T('Check the share path, user name and password. Newer NAS and Windows servers need SMB2 or SMB3: check the minimum and maximum protocol under Settings → Services → SMB client.'), ev };
  } },
  simple({ cat: 'shares', sev: 'bad', in: 'kodi', kodiError: true, match: /\bNFS\b|nfs:\/\//i,
    text: 'Kodi could not use NFS shares ({0}×).',
    hint: 'Check that the server is running, that the export path is right and that the export allows the IP address of this device.' }),
  simple({ cat: 'shares', sev: 'warn', in: 'system',
    match: /mount error\(\d+\)|failed to parse mount options|CIFS:? VFS: .*(?:error|fail)|Failed to mount|mount\.(?:nfs4?|cifs): |autofs.*(?:error|fail)/i,
    text: 'Errors when mounting file systems ({0}×).',
    hint: 'Check the mounts in fstab and autofs (see Sources & storage), and that the server is on before this device starts.' }),
  { cat: 'shares', check: d => {
    // a mounted NFS share whose server stopped answering: "nfs: server nas.lan not responding, still trying" (the device
    // waits) or "…, timed out" (it gave up); "nfs: server nas.lan OK" when it answers again
    const ev = find(d, sysSec(d), /nfs: server \S+ not responding/);
    if (!ev.count) return;
    const servers = [...new Set(ev.hits.map(h => (/nfs: server (\S+) not responding/.exec(h.text) || [])[1]))];
    return { sev: 'warn', text: T('The NFS server {0} stopped responding ({1}×).', servers.join(', '), ev.count), ev,
      hint: T('Playback and the library hang while the server doesn’t answer. Check that the server doesn’t go to sleep or lose its network connection, and that the mount (fstab or autofs) uses the server’s IP address.') };
  } },
  { cat: 'shares', check: d => {
    // folders Kodi could not read while scanning or cleaning the library: "GetDirectory - Error getting /mnt/Videos/…".
    // Usually the drive or the share behind a mount was not there at that moment. Only mounted drives (/mnt, /media):
    // add-ons look for their own folders in /home/osmc before they exist, and disc images and plugin paths are left out.
    const ev = find(d, KODI, / error <general>: GetDirectory - Error getting \/(?:mnt|media)\//);
    if (!ev.count) return;
    const paths = new Set(ev.hits.map(h => (/Error getting (\/.*?)\/?$/.exec(h.text) || [])[1]));
    // the mount points: the first two parts of each path (/mnt/Videos)
    const roots = [...new Set([...paths].map(p => p.split('/').slice(0, 3).join('/')))];
    return { sev: 'warn', text: T('Kodi could not read folders ({0}×) under: {1}.', ev.count, roots.join(', ')), ev,
      hint: T('Usually the drive or network share was not there when Kodi scanned or cleaned the library, or the folders were moved or renamed. Check the mounts under Sources & storage; a mount that starts on first use (x-systemd.automount, autofs) or a NAS that is asleep can be too late.') };
  } },

  // --- network ---
  // (errors on SMB and NFS shares are the network shares rules above)
  simple({ cat: 'network', sev: 'warn', in: 'kodi', kodiError: true, not: /SMB|NFS/i,
    match: /Software caused connection abort|Connection reset by peer|Connection timed out|Operation timed out|Network is unreachable|No route to host/i,
    text: 'Network connection errors in the Kodi log ({0}×).',
    hint: 'The connection to a server was lost, often during playback. Check cables, the Wi-Fi signal and the server. A wired connection is more reliable.' }),
  { cat: 'network', check: d => {
    // (counted once per log entry: a Python traceback repeats the same DNS error on several lines)
    const ev = find(d, [...KODI, sysSec(d)], /Could(?:n't| not) resolve|Failed to resolve|Unable to lookup host|Name or service not known|Temporary failure in name resolution/i, 50, true);
    if (!ev.count) return;
    // the names that could not be looked up, where the entry (the line and its indented continuation lines) says:
    // lookup host: 'MAIN', host='www.x.net', <http://www.x.com/…>
    const entry = h => [h.text, ...d.log.byName[h.sec].lines.slice(h.line + 1, h.line + 8).filter(l => /^\s/.test(l))].join(' ');
    const hosts = new Set();
    for (const h of ev.hits) {
      const t = entry(h), m =/lookup host: '([^']+)'|host='([^']+)'|<(?:https?|ftp):\/\/([^/:>]+)|resolve(?: host)?[: ]+'?([\w-]+(?:\.[\w-]+)+)/i.exec(t);
      const name = m && (m[1] || m[2] || m[3] || m[4]);
      if (name) hosts.add(name);
    }
    // a name without a dot (a computer name such as "MAIN") is usually looked up on the local network, which often fails
    const bare = [...hosts].some(n => !n.includes('.') && !/^\d/.test(n));
    return { sev: 'warn', ev,
      text: hosts.size ? T('Name lookup (DNS) errors ({0}×) for: {1}.', ev.count, [...hosts].slice(0, 6).join(', ')) : T('Name lookup (DNS) errors ({0}×).', ev.count),
      hint: (bare ? T('A computer name without a dot can often not be looked up: use the server’s IP address in the source or mount instead.') + ' ' : '')
        + T('Server names or internet addresses could not be looked up. Check the DNS server in the network settings, or use IP addresses for shares.') };
  } },
  { cat: 'network', check: d => {
    // TV (PVR) add-ons that can't log in to or reach their backend, e.g. "AddOnLog: pvr.hts: Command authenticate failed: Access denied"
    const ev = find(d, KODI, kodiErr(/AddOnLog: pvr\.[\w.]+: .*(?:authenticat\w* failed|Access denied|Login failed|unable to connect|connection refused|failed to connect)/i));
    if (!ev.count) return;
    const ids = [...new Set(ev.hits.map(h => (/AddOnLog: (pvr\.[\w.]+):/.exec(h.text) || [])[1]).filter(Boolean))];
    const login = ev.hits.some(h => /authenticat|Access denied|Login failed/i.test(h.text));
    return { sev: 'warn', text: T('The TV add-on {0} could not connect to its backend ({1}×).', ids.join(', '), ev.count), ev,
      hint: login ? T('The TV server (for example Tvheadend) refused the login. Check the user name and password in the add-on’s settings, and the user’s rights on the server.')
        : T('Check the server address and port in the add-on’s settings, and that the TV server is running.') };
  } },
  { cat: 'network', check: d => {
    const wl = d.ifaces.find(i => i.inet && /^wl/.test(i.name));
    if (wl && !d.ifaces.some(i => i.inet && /^(eth|en)/.test(i.name)))
      return { sev: 'info', text: T('Connected via Wi-Fi ({0}).', wl.name), hint: T('For high-bitrate video (4K, Blu-ray remuxes) a wired connection is more reliable.') };
  } },
  { cat: 'network', check: d => d.ifaces.filter(i => (+i.rxErr || 0) + (+i.txErr || 0) > 0).map(i => ({ sev: 'warn',
    text: T('Network errors on {0}: RX {1}, TX {2}.', i.name, i.rxErr, i.txErr), hint: T('Errors on a network interface often mean a bad cable, port or Wi-Fi signal.') })) },

  // --- crashes & errors ---
  { cat: 'crashes', check: d => {
    // Kodi crashes: OSMC's start script restarts Kodi and logs how it ended, e.g.
    //   mediacenter[2786]: /usr/bin/mediacenter: line 221:  2966 Segmentation fault      sudo -u osmc … kodi.bin …
    //   mediacenter[2786]: Kodi exited with return code 139 after 0 hours, 10 minutes and 16 seconds
    // A return code above 128 means Kodi was stopped by a signal (128 + the signal's number).
    const sec = sysSec(d), ev = find(d, sec, /mediacenter\[\d+\]: Kodi exited with return code (?:129|13\d|14\d)\b/);
    if (!ev.count) return;
    const SIGNALS = { 134: 'abort', 135: 'bus error', 136: 'arithmetic error', 137: 'killed', 139: 'segmentation fault' };
    const crashes = ev.hits.map(h => {
      const m = /return code (\d+) after (\d+) hours?, (\d+) minutes? and (\d+) seconds?/.exec(h.text) || [];
      return { h, why: T(SIGNALS[m[1]] || 'signal {0}', (m[1] || 0) - 128), after: m[2] != null ? fmtDuration(m[2] * 3600 + m[3] * 60 + +m[4]) : '?' };
    });
    // The previous Kodi log belongs to the crashed session when it ends at the time of the last crash. The Kodi log can
    // be in another time zone than the journal (a whole number of hours), so the times are compared within the hour.
    const old = d.oldKodi && d.oldKodi.last, last = crashes[crashes.length - 1].h.text;
    const sod = (h, m, s) => +h * 3600 + +m * 60 + +s;
    const tj = /^\w{3} +\d+ (\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(last), tk = old && /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(old.time);
    const gap = tj && tk ? (((sod(tj[1], tj[2], tj[3]) - sod(tk[1], tk[2], tk[3])) % 3600) + 3600) % 3600 : -1;
    const lastSession = gap >= 0 && gap <= 60;
    // playing at the crash: the session's last playback, if it never closed
    const lastPb = lastSession && d.oldKodi.playbacks[d.oldKodi.playbacks.length - 1], playing = lastPb && !lastPb.end && lastPb;
    const hits = ev.hits.slice();
    if (lastSession) { const s = d.log.byName['Kodi Old Log']; hits.push({ sec: 'Kodi Old Log', line: old.line, n: s.startLine + old.line, text: s.lines[old.line] }); }
    return { sev: 'bad', text: T('Kodi crashed and was restarted ({0}×): {1}.', crashes.length, crashes.map(c => T('{0} after {1}', c.why, c.after)).join('; '))
        + (playing ? ' ' + T('The last crash was during playback of “{0}”.', pbPath(playing).split('/').pop()) : ''),
      hint: (lastSession ? T('The previous Kodi log ends at the last crash, so its last lines show what Kodi was doing.') + ' '
          : T('The Kodi log of the crashed session is no longer in this log (grab-logs only keeps the last two Kodi logs).') + ' ')
        + T('A crash during playback often points to the file or the add-on that played it, a crash at start-up to an add-on or the skin. If it happens again, ask on the OSMC forum with a new log made straight after it.'),
      ev: { hits, count: hits.length } };
  } },
  simple({ cat: 'crashes', sev: 'bad', in: 'system', not: /mediacenter\[\d+\]:/, match: /segfault at|status=(?:11\/SEGV|7\/BUS|6\/ABRT)|SIGSEGV|SIGBUS|core dumped|code=dumped/i,
    text: 'Signs of a program crash ({0}×).',
    hint: 'If it is Kodi (kodi.bin), a recently installed add-on or skin is a common cause. Crashes during updates can point to a weak power supply or a failing SD card.' }),
  // the kernel itself crashed: at the next start-up systemd-pstore saves the crash report the kernel kept in memory
  // ("dmesg-ramoops"; "console-ramoops" is saved at every start-up and is not a crash)
  simple({ cat: 'crashes', sev: 'bad', in: 'system', match: /systemd-pstore\[\d+\]: PStore dmesg-ramoops-\d+ moved/,
    text: 'The kernel crashed before a restart and saved a crash report ({0}×).',
    hint: 'The device restarted by itself after a kernel crash. The report is not part of this log: show it with sudo cat /var/lib/systemd/pstore/dmesg-ramoops-0 and post it on the OSMC forum with this log, saying what was playing.' }),
  // a kernel error the system survived (an "oops")
  simple({ cat: 'crashes', sev: 'bad', in: 'system', perEntry: true,
    match: /Internal error: Oops|Kernel panic - not syncing|Unable to handle kernel (?:paging request|NULL pointer)/,
    text: 'The kernel reported an internal error ({0}×).',
    hint: 'A kernel error is a fault in a driver or the kernel, often around a piece of hardware or a video or audio format. Ask on the OSMC forum with this log and say what the device was doing.' }),
  { cat: 'crashes', check: d => [[d.kodi, 'Kodi Log', 'The Kodi log has {0} repeats of the error: “{1}”.'],
    [d.oldKodi, 'Kodi Old Log', 'The previous Kodi log has {0} repeats of the error: “{1}”.']].map(([k, sec, text]) => {
    // the most repeated error in each Kodi log (the counts include "Skipped N duplicate messages"), unless another
    // finding already covers it: TV add-ons that can't reach their backend, shares, name lookups, and errors that an
    // add-on with Python errors logs itself ("[plugin.video.youtube] …")
    const py = pythonErrors(d).ids;
    const covered = msg => /^AddOnLog: pvr\.|SMB|NFS|nfs:\/\/|resolve host|lookup host|name resolution/i.test(msg)
      || [...py].some(id => msg.startsWith(`[${id}]`) || msg.startsWith(`AddOnLog: ${id}:`));
    const top = k && [...k.groups.values()].filter(g => g.level === 'error' && !harmlessWhy(g.msg) && !covered(g.msg)).sort((a, b) => b.count - a.count)[0];
    if (!top || top.count < 50) return null;
    const s = d.log.byName[sec];
    return { sev: 'warn', text: T(text, top.count, top.msg.slice(0, 160)),
      hint: T('An error that repeats this often can slow Kodi down and fills the log. It usually points to an add-on, a source or a setting.'),
      ev: { hits: [{ sec, line: top.firstLine, n: s.startLine + top.firstLine, text: s.lines[top.firstLine] }], count: 1 } };
  }) },

  // --- storage & memory ---
  { cat: 'storage', check: d => d.df.filter(df => !/^(tmpfs|devtmpfs)$/.test(df.fs)).map(df => {
    // The system disk (and /boot) by how full it is. A media disk is only a problem when it has almost no space left:
    // 96 % full with 64 GB free is normal for a disk of films. Small partitions (the Vero's /tee, a Pi's SETTINGS and
    // RECOVERY …) are system partitions that are meant to be nearly full. df -h gives "64G", "5.2G", "512M" …
    const gb = v => parseFloat(v) * ({ K: 1e-6, M: 1e-3, G: 1, T: 1e3, P: 1e6 }[(/[KMGTP]/i.exec(v) || ['G'])[0].toUpperCase()]);
    const free = gb(df.avail), system = df.mnt === '/' || df.mnt === '/boot';
    const sev = system ? (df.pct >= 95 ? 'bad' : df.pct >= 85 ? 'warn' : '') : gb(df.size) < 8 ? '' : free < 0.5 ? 'bad' : free < 2 ? 'warn' : '';
    return sev && { sev, text: T('{0} is {1}% full ({2} free).', df.mnt, df.pct, df.avail),
      hint: system ? T('A full system disk can stop updates and stop Kodi from saving its library and thumbnails.') : T('New recordings and downloads to this disk will fail when it is full.') };
  }) },
  { cat: 'storage', check: d => d.mem.Mem && d.mem.Mem.avail / d.mem.Mem.total < 0.1 && { sev: 'warn', text: T('Low available memory: {0} MB of {1} MB.', d.mem.Mem.avail, d.mem.Mem.total) } },
  simple({ cat: 'storage', sev: 'bad', in: 'system', match: /Out of memory: Killed process|Memory cgroup out of memory/i,
    text: 'The system ran out of memory and stopped a program ({0}×).',
    hint: 'Often caused by an add-on or a large cache setting (cache memory size in advancedsettings.xml or under Settings → Services → Caching).' }),
  // (a FAT volume that "was not properly unmounted" is the unclean-shutdown rule below, not a disk error)
  simple({ cat: 'storage', sev: 'bad', in: 'system', not: /not properly unmounted/i,
    match: /EXT4-fs error|EXT4-fs \([^)]*\): (?:error|warning)|Buffer I\/O error|I\/O error, dev|blk_update_request: I\/O error|FAT-fs \([^)]*\): .*(?:error|corrupt)|Remounting filesystem read-only|remounted read-only/i,
    text: 'File system or disk errors ({0}×).',
    hint: 'The SD card, eMMC or USB disk may be failing or was not removed safely. Back up your data, check the disk and replace the SD card if the errors return.' }),
  simple({ cat: 'storage', sev: 'info', in: 'system', match: /not properly unmounted|was not cleanly unmounted|recovery complete|needs? fsck/i,
    text: 'A disk was not shut down cleanly ({0}×).',
    hint: 'Usually after a power cut or a USB disk that was pulled out. Shut down from the power menu, and check the disk if errors follow.' }),

  // --- hardware & power ---
  simple({ cat: 'hardware', sev: 'bad', in: 'system', match: /Under-?voltage detected/i,
    text: 'Under-voltage detected ({0}×).',
    hint: 'The power supply is too weak or its cable too thin. Use the official power supply, and power USB disks through a powered hub.' }),
  simple({ cat: 'hardware', sev: 'warn', in: 'system',
    match: /usb \S+: (?:device descriptor read\/\S+, error|device not accepting address|unable to enumerate|can't set config|Cannot enable)|over-current/i,
    text: 'USB errors ({0}×).',
    hint: 'A USB device is not responding properly. Try another port or cable. USB disks may need more power (a powered hub).' }),
  { cat: 'hardware', check: d => {
    // Short HDMI drops on the Vero: the HDMI driver logs "hdmitx: system: plugout" and "… plugin" (case-sensitive
    // "hdmitx:"; the eARC driver logs the same event again as "HDMITX cable is plugout"). One drop is a plugout (often
    // two in a row) until the next plugin. Drops are normal at start-up and when the display mode changes (the TV
    // re-syncs), so those are left out: within 40 s after the kernel starts, or within 6 s of "vout: setting vmode".
    // What's left is usually the TV or receiver being switched on or to another input, or a bad cable or switch.
    const sec = sysSec(d), s = d.log.byName[sec];
    if (!s) return;
    // time of a line in seconds: journal "Nov 03 10:48:39.300260 …" (days counted from the month and day), or the
    // kernel log's "[   12.345678]" (seconds since start-up)
    const time = l => {
      let m = /^(\w{3} +\d+) (\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(l);
      if (m) return Date.parse(`${m[1]} 2000`) / 1000 + m[2] * 3600 + m[3] * 60 + +m[4];
      m = /^\[\s*(\d+\.\d+)\]/.exec(l);
      return m ? +m[1] : null;
    };
    const boots = sec === 'Kernel Message Log' ? [0] : [], modes = [], seq = [];
    s.lines.forEach((l, j) => {
      const t = time(l);
      if (t == null) return;
      if (/kernel: Linux version /.test(l)) boots.push(t);
      else if (/vout: setting vmode to (?!null)/.test(l)) modes.push(t);
      else if (/hdmitx: .*\bplug ?(in|out)\b/.test(l)) seq.push({ t, j, out: /plug ?out/.test(l) });
    });
    const drops = [];
    for (let i = 0; i < seq.length; i++) {
      if (!seq[i].out) continue;
      let k = i;
      while (k + 1 < seq.length && seq[k + 1].out) k++;
      if (k + 1 >= seq.length) break;
      const from = seq[i].t, gap = seq[k + 1].t - from;
      const normal = boots.some(b => from - b >= 0 && from - b <= 40) || modes.some(m => Math.abs(from - m) <= 6);
      if (!normal) drops.push({ j: seq[i].j, gap });
      i = k + 1;
    }
    if (drops.length < 5) return;
    const gaps = drops.map(x => x.gap).sort((a, b) => a - b), typical = gaps[Math.floor(gaps.length / 2)];
    return { sev: 'info', text: T('The HDMI connection was briefly lost {0}× (about {1} s each), not at start-up or at a change of display mode.', drops.length, typical.toFixed(1)),
      hint: T('This is normal when the TV or receiver is switched on or to another input. If it happens while you are watching, try another HDMI cable or input, and avoid switches or adapters in between.'),
      ev: { hits: drops.slice(0, 50).map(x => ({ sec, line: x.j, n: s.startLine + x.j, text: s.lines[x.j] })), count: drops.length } };
  } },
  { cat: 'hardware', check: d => {
    // The Vero V's built-in remote receiver (USB 2017:xxxx "OSMC Remote Controller" / "OSMC RF Remote") sits on an
    // internal USB hub (usb 1-1). Only flagged when the log shows the devices were scanned: Kodi registered its
    // other input devices, or the kernel log covers the USB start-up.
    if (!d.kodi || !/Vero V\b/.test(d.kodi.info.runningOn || '')) return;
    const sys = [...new Set([sysSec(d), 'Kernel Message Log'])];
    const receiver = find(d, KODI, /new hid device registered.*\(2017:/).count || find(d, sys, /idVendor=2017\b|Product: OSMC R(?:emote Controller|F Remote)/).count;
    const kodiScan = find(d, 'Kodi Log', /Register - new (?:keyboard|cec) device registered/);
    const usbStart = find(d, sys, /hub 1-0:1\.0: \d+ ports detected/);
    if (receiver || (!kodiScan.count && !usbStart.count)) return;
    const hubMissing = usbStart.count && !find(d, sys, /\busb 1-1: /).count;
    return { sev: 'warn', text: T('The Vero V’s built-in remote receiver was not found.'),
      hint: (hubMissing ? T('The internal USB hub it is connected to is missing as well.') + ' ' : '')
        + T('The OSMC remote won’t work until it is found. Unplug the Vero from power for a minute and start it again; if it is still missing, ask on the OSMC forum with this log, as it can be a hardware fault. CEC (the TV remote) works in the meantime.'),
      ev: { hits: [...usbStart.hits, ...kodiScan.hits].slice(0, 6), count: usbStart.count + kodiScan.count } };
  } },
  { cat: 'hardware', check: d => {
    // CEC (TV remote and power on/off over HDMI): libCEC can't open the adapter, or its messages go unanswered.
    // Adapter failures only count in the current Kodi log: a one-off in the previous session is usually gone after a restart.
    // A failure at start-up that the connection gets over later ("connection to the CEC adapter opened", logged with
    // debug logging) is not counted.
    const open = find(d, 'Kodi Log', /could not open(?:ing)? a connection to the CEC adapter|failed to find a free logical address/i);
    const lastFail = open.count && open.hits[open.hits.length - 1].line;
    const recovered = open.count && d.log.byName['Kodi Log'].lines.slice(lastFail).some(l => /connection to the CEC adapter opened/.test(l));
    const notSent = find(d, KODI, /CecLogMessage - .*\bnot sent\b/);
    return [
      open.count && !recovered && { sev: 'warn', text: T('Kodi could not connect to the CEC adapter ({0}×).', open.count), ev: open,
        hint: T('CEC lets the TV remote control Kodi and turns the devices on and off. Check that CEC is on in the TV and in any soundbar or receiver (Anynet+, SimpLink, Bravia Sync …). Unplugging the TV and the other HDMI devices from power for a minute often resets it.') },
      notSent.count >= 50 && { sev: 'warn', text: T('Many CEC messages could not be sent ({0}×).', notSent.count), ev: notSent,
        hint: T('The TV or another HDMI device does not answer CEC. Check the CEC settings on the TV and on any soundbar or receiver in between, and try another HDMI input.') },
    ];
  } },
  { cat: 'hardware', check: d => {
    const ev = find(d, 'Pi config-user', /^\s*(?:arm_freq|over_voltage\w*|core_freq|gpu_freq|sdram_freq|h264_freq|v3d_freq|force_turbo)\s*=/i);
    return ev.count && { sev: 'warn', text: T('Overclocking settings in config-user.txt: {0}.', ev.hits.map(h => h.text.trim()).join(', ')),
      hint: T('Overclocking can cause freezes, crashes and SD card corruption. Remove these lines if the system is unstable.'), ev };
  } },

  // --- display ---
  { cat: 'display', check: d => {
    const ab = d.abridged.find(s => s.name === 'Adjust display refresh rate');
    if (ab && /^Off/i.test(ab.value)) return { sev: 'warn', text: T('Adjust display refresh rate is off. Films at 23.976/24 fps may stutter.'),
      hint: T('Turn it on under Settings → System → Display → Adjust display refresh rate (“On start/stop”).') };
  } },
  simple({ cat: 'display', sev: 'warn', in: 'kodi', match: /RES_DESKTOP.*640x480|640x480.*RES_DESKTOP/,
    text: 'Kodi only found 640x480: the display modes of the TV could not be read ({0}×).',
    hint: 'Check the HDMI cable and turn the TV or receiver on before this device. An AV receiver or HDMI switch in between can hide the modes of the TV.' }),
  { cat: 'display', check: d => {
    // video calibration per resolution: overscan other than the full screen, or a changed pixel ratio.
    // The full screen is the mode's own size or the GUI size (4K modes are stored in 1080p GUI coordinates),
    // and SD modes (720x480, 640x480 …) have a non-square pixel ratio by default, so only HD modes are checked for it.
    const gs = d.log.sec('guisettings.xml'), custom = [];
    for (const [, r] of gs.matchAll(/<resolution>([\s\S]*?)<\/resolution>/g)) {
      const g = tag => (new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(r) || [])[1];
      const desc = g('description') || '', wh = /(\d+)x(\d+)/.exec(desc);
      if (!wh) continue;
      const num = tag => parseFloat(g(tag));
      // 3D modes use half the height or width (720x480 → 720x240, 1920x2160 → pixel ratio 0.5), so the
      // pixel ratio is only checked for 16:9 modes
      const w = +wh[1], h = +wh[2];
      // (a shift of a pixel or two can't be seen, so it isn't counted)
      const full = [[w, h], [w, h / 2], [w / 2, h], [1280, 720], [1920, 1080], [3840, 2160]];
      const near = (a, b) => Math.abs(a - b) <= 2;
      const shifted = !near(num('left') || 0, 0) || !near(num('top') || 0, 0)
        || (g('right') && g('bottom') && !full.some(([fw, fh]) => near(num('right'), fw) && near(num('bottom'), fh)));
      const wide = w >= 1280 && Math.abs(w / h - 16 / 9) < 0.02;
      if (shifted || (wide && g('pixelratio') && Math.abs(num('pixelratio') - 1) > 0.001)) custom.push(desc);
    }
    if (!custom.length) return;
    return { sev: 'info', text: T('Custom video calibration (overscan or pixel ratio) for: {0}.', custom.join(', ')),
      hint: T('Can give a cropped, shifted or stretched picture. Reset it under Settings → System → Display → Video calibration.'),
      ev: find(d, 'guisettings.xml', new RegExp(`<description>(?:${custom.map(reEsc).join('|')})</description>`)) };
  } },
  { cat: 'display', check: d => {
    // default view mode for all videos (zoom, stretch, pixel ratio, vertical shift)
    const s = d.log.byName['guisettings.xml'];
    if (!s) return;
    const a = s.lines.findIndex(l => /<defaultvideosettings>/.test(l)), b = s.lines.findIndex(l => /<\/defaultvideosettings>/.test(l));
    if (a < 0 || b < a) return;
    const block = s.lines.slice(a, b).join('\n');
    const g = tag => (new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block) || [])[1];
    const changed = [], tags = [];
    const add = (tag, text) => { changed.push(text); tags.push(tag); };
    if (g('viewmode') && +g('viewmode') !== 0) add('viewmode', `${T('view mode')} ${VIEWMODES[+g('viewmode')] || g('viewmode')}`);
    if (g('zoomamount') && Math.abs(+g('zoomamount') - 1) > 0.001) add('zoomamount', `${T('zoom')} ${(+g('zoomamount')).toFixed(2)}`);
    if (g('pixelratio') && Math.abs(+g('pixelratio') - 1) > 0.001) add('pixelratio', `${T('pixel ratio')} ${(+g('pixelratio')).toFixed(2)}`);
    if (g('verticalshift') && Math.abs(+g('verticalshift')) > 0.001) add('verticalshift', `${T('vertical shift')} ${(+g('verticalshift')).toFixed(2)}`);
    if (g('nonlinstretch') === 'true') add('nonlinstretch', T('non-linear stretch'));
    if (!changed.length) return;
    // evidence: only the changed lines of the <defaultvideosettings> block
    const hits = [], tagRe = new RegExp(`<(?:${tags.join('|')})>`);
    for (let j = a + 1; j < b; j++) if (tagRe.test(s.lines[j])) hits.push({ sec: 'guisettings.xml', line: j, n: s.startLine + j, text: s.lines[j] });
    const ev = { hits, count: hits.length };
    return { sev: 'info', text: T('The default view for all videos is changed: {0}.', changed.join(', ')),
      hint: T('All videos are then zoomed, stretched or shifted. Play a video, set the view back under Settings → Video settings and choose “Set as default for all media”.'), ev };
  } },
  { cat: 'display', check: d => {
    const z = d.gui.find(s => s.id === 'lookandfeel.skinzoom');
    if (z && +z.value) return { sev: 'info', text: T('Skin zoom is set to {0}%.', z.value), hint: T('Makes the menus larger or smaller; large values can push the menus off the screen.'),
      ev: find(d, 'guisettings.xml', /"lookandfeel\.skinzoom"/) };
  } },
  { cat: 'display', check: d => {
    const ev = find(d, 'Pi config-user', /^\s*(?:hdmi_\w+|overscan_\w+|disable_overscan|framebuffer_\w+|config_hdmi_boost|display_(?:hdmi_)?rotate|sdtv_mode)\s*=/i);
    if (!ev.count) return;
    const kms = /vc4-kms-v3d/.test(d.log.sec('Pi config'));
    return { sev: 'info', text: T('Display settings in config-user.txt: {0}.', ev.hits.map(h => h.text.trim()).join(', ')),
      hint: kms ? T('OSMC uses the KMS display driver (vc4-kms-v3d), which ignores many of these older settings or lets them conflict with the display settings in Kodi.')
        : T('Forced display settings can stop Kodi from using the display modes of the TV.'), ev };
  } },
  { cat: 'display', check: d => {
    // refresh rate switching on and no pause for it, and a playback that switched the display started badly: the
    // display took more than 2 s to come back, the first picture took more than 5 s, or many frames were late.
    // (Many TVs switch fine without a pause, so the setting alone is not a problem.)
    const g = id => (d.gui.find(s => s.id === id) || {}).value;
    if (!+g('videoplayer.adjustrefreshrate') || g('videoscreen.delayrefreshchange') == null || +g('videoscreen.delayrefreshchange')) return;
    const bad = p => { const st = p.st; return (st.lost != null || st.hdmi) && ((st.reset - st.lost > 2000) || (st.av - p.t0 > 5000) || st.late > 10); };
    if (!d.kodi || !d.kodi.playbacks.some(bad)) return;
    return { sev: 'info', text: T('The display switches refresh rate when playback starts, but “Pause during refresh rate change” is off.'),
      hint: T('If the picture is black or stutters for the first seconds, set Settings → System → Display → Pause during refresh rate change to 2–4 seconds, so the TV has time to lock on to the new mode.'),
      ev: find(d, 'guisettings.xml', /"videoscreen\.delayrefreshchange"/) };
  } },
  // Vero's decoder logs "DOLBY ERROR: meta(…) -> parser process fail" and "-> metadata parser process fail" per frame; count one of them
  simple({ cat: 'display', sev: 'info', in: 'system', min: 20, match: /DOLBY ERROR: .*-> metadata parser process fail/,
    text: 'The video decoder reported Dolby Vision metadata errors ({0}×).',
    hint: 'The Dolby Vision data in a file could not be read, which can give wrong colours or brightness. Usually a problem with that file (for example a converted DV file). If it happens with all Dolby Vision files, ask on the OSMC forum with this log.' }),
  { cat: 'display', check: d => d.dvCap && /Support mode/.test(d.dvCap) && { sev: 'ok', text: T('The connected display reports Dolby Vision support.') } },
  { cat: 'display', check: d => d.kodi && d.kodi.playbacks.some(p => p.dovi) && { sev: 'ok', text: T('{0} playback(s) with Dolby Vision in the Kodi log.', d.kodi.playbacks.filter(p => p.dovi).length) } },

  // --- audio ---
  { cat: 'audio', check: d => {
    // audio settings by their English name, e.g. ab['Allow passthrough'] === 'false', and the formats the TV/receiver reports
    const ab = Object.fromEntries(d.abridged.map(s => [s.name, s.value]));
    const capTxt = d.audioCap.map(r => r[0]).join(' ');
    const hasAC3 = /AC-?3/i.test(capTxt), hasDDP = /Digital\+|E-?AC-?3|ATMOS/i.test(capTxt), hasMAT = /MAT|TrueHD/i.test(capTxt), hasDTS = /DTS/i.test(capTxt);
    // An AV receiver or soundbar connected directly (from the EDID: "DENON-AVR", "marantz-AVR", or a maker of
    // receivers). A TV reports the formats too, but with its own speakers passthrough off and 2 channels are fine.
    const rx = /AVR|receiver|soundbar|sonos|\bbose\b/i.test(d.edid['Rx Product Name'] || '') || /^(DON|MJI|YMH|ONK|PIO|HKA|NAD|ARC|ANT|INT)$/.test(d.edid['Rx Manufacturer Name'] || '');
    const out = [];
    if (ab['Allow passthrough'] === 'false' && (hasAC3 || hasDDP || hasMAT || hasDTS))
      out.push({ sev: rx ? 'warn' : 'info', text: T('Passthrough is disabled, but the connected device reports support for: {0}.', d.audioCap.map(r => r[0]).filter(f => !/^(PCM|OneBitAudio)/i.test(f)).join(', ')),
        hint: rx ? T('Turn on passthrough under Settings → System → Audio to send Dolby and DTS to the receiver unchanged.')
          : T('With the TV’s own speakers this is fine. If the sound goes on to a soundbar or receiver (also through the TV’s ARC or eARC), turn on passthrough under Settings → System → Audio to send Dolby and DTS to it unchanged.') });
    if (ab['Allow passthrough'] === 'true') {
      const miss = [];
      if (hasDDP && ab['Dolby Digital Plus (E-AC3) capable receiver'] === 'false') miss.push('Dolby Digital Plus (E-AC3)');
      if (hasMAT && ab['TrueHD capable receiver'] === 'false') miss.push('TrueHD (MAT)');
      if (hasDTS && ab['DTS capable receiver'] === 'false') miss.push('DTS');
      if (miss.length) out.push({ sev: 'info', text: T('Passthrough is enabled, but these formats reported by the device are not enabled in Kodi: {0}.', miss.join(', ')) });
    }
    const maxCh = Math.max(0, ...d.audioCap.map(r => parseInt(r[1]) || 0));
    if (rx && ab['Number of channels'] && parseFloat(ab['Number of channels']) <= 2 && maxCh > 2)
      out.push({ sev: 'info', text: T('Number of channels is set to {0}, but the device reports up to {1} channels.', ab['Number of channels'], maxCh),
        hint: T('Multichannel sound that is not passed through (for example TrueHD that is decoded, or 5.1 FLAC) is then mixed down to stereo. Set the number of channels to match the speakers under Settings → System → Audio.') });
    return out;
  } },

  // --- playback ---
  { cat: 'playback', check: d => {
    // slow start (more than 5 s to the first picture) or many late frames just after it; see startRows()
    const s = d.log.byName['Kodi Log'];
    if (!d.kodi || !s) return;
    return d.kodi.playbacks.map(p => {
      const st = p.st, slow = st.av != null && st.av - p.t0 > 5000, late = st.late > 10;
      if (!slow && !late) return null;
      const what = [slow && T('{0} until the first picture', secs(st.av - p.t0)), late && T('{0} late frames at the start', st.late)].filter(Boolean);
      const name = pbPath(p).split('/').pop();
      const hit = line => ({ sec: 'Kodi Log', line, n: s.startLine + line, text: s.lines[line] });
      return { sev: 'info', text: T('Slow or uneven start of “{0}”: {1}.', name, what.join(', ')),
        hint: T('See the start details under Kodi log → Playbacks. Long buffering points to the network or the source, late frames to A/V sync at the start. A log where the same file is resumed instead of started from the beginning is a useful comparison.'),
        ev: { hits: [hit(p.line), ...(st.avLine != null ? [hit(st.avLine)] : [])], count: st.avLine != null ? 2 : 1 } };
    });
  } },

  simple({ cat: 'playback', sev: 'info', in: 'kodi', min: 3, match: /ActiveAE - large audio sync error/,
    text: 'Large audio sync errors during playback ({0}×).',
    hint: 'Kodi had to correct a large gap between sound and picture, which can be heard as a drop-out or seen as a jump. It often comes from the source (network, damaged file) or from audio settings such as passthrough.' }),
  { cat: 'playback', check: d => [[d.kodi, 'Kodi Log'], [d.oldKodi, 'Kodi Old Log']].flatMap(([k, sec]) => {
    // jumps in the video timestamps the decoder reports (needs component logging for "Video"); see analyzeKodi()
    const s = d.log.byName[sec];
    if (!k || !s) return [];
    const hit = line => ({ sec, line, n: s.startLine + line, text: s.lines[line] });
    return k.playbacks.filter(p => p.st.gaps).map(p => ({ sev: 'warn',
      text: T('The video timestamps of “{0}” jump {1}× (up to {2}).', pbPath(p).split('/').pop(), p.st.gaps, secs(p.st.maxGap)),
      hint: T('The video decoder got pictures whose timestamps jump forward, which is seen as a jerk or a short freeze. This usually comes from the file itself (for example a badly remuxed or converted file), not from the device. Try another copy of the file; for help, upload the first 30 seconds of it to the OSMC forum together with this log.'),
      ev: { hits: [hit(p.line), ...p.st.gapLines.map(hit)], count: 1 + p.st.gaps } }));
  }) },

  // --- updates & packages ---
  { cat: 'updates', check: d => {
    const ev = find(d, ['OSMC Packages', 'All Other Packages'], /^[a-z][HUFWt]|^..R/);
    return ev.count && { sev: 'warn', text: T('Packages are not fully installed: {0}.', ev.hits.map(h => h.text.split(/\s+/)[1]).join(', ')),
      hint: T('An update was interrupted. Update again with My OSMC, or run: sudo apt-get update && sudo apt-get dist-upgrade'), ev };
  } },
  { cat: 'updates', check: d => {
    // kernel packages: OSMC's "<device>-image-<version>-osmc" (e.g. vero564-image-4.9.269-93-osmc) or Debian's
    // "linux-image-<version>"; other packages with "-image-" in the name (libsdl2-image-2.0-0) are not kernels
    const ev = find(d, ['OSMC Packages', 'All Other Packages'], /^ii\s+(?:[a-z0-9]+-image-\d[\w.+~-]*-osmc|linux-image-\d[\w.+~-]*)(?::\w+)?\s/);
    return ev.count > 2 && { sev: 'warn', text: T('{0} kernels are installed: {1}.', ev.count, ev.hits.map(h => h.text.split(/\s+/)[1].replace(/:\w+$/, '')).join(', ')),
      hint: T('Normally only the newest one or two are needed. Old kernels can fill up the boot partition and make updates fail.'), ev };
  } },
  simple({ cat: 'updates', sev: 'warn', in: 'APT history.log', match: /^Commandline: .*\bapt(?:-get)?\s+(?:-\S+\s+)*upgrade\b/,
    text: 'APT history shows {0} run(s) of “apt upgrade”.',
    hint: 'OSMC should be updated with My OSMC or “sudo apt-get dist-upgrade”. A plain “upgrade” can leave the system partly updated.' }),
  simple({ cat: 'updates', sev: 'warn', in: 'APT history.log', match: /^Error: /,
    text: 'Errors in the APT history ({0}×).',
    hint: 'An update failed. Update again with My OSMC and check that there is enough free space.' }),
  { cat: 'updates', check: d => {
    const runs = parseAptHistory(d.log.sec('APT history.log'));
    const created = Date.parse((d.log.created || '').slice(0, 10)), last = runs[0] && Date.parse(runs[0].start.slice(0, 10));
    const days = created && last ? Math.round((created - last) / 864e5) : 0;
    if (days > 180) return { sev: 'info', text: T('The last update in the APT history was {0} ({1} days before the log was made).', runs[0].start.slice(0, 10), days),
      hint: T('Update with My OSMC → Updater. Many problems are already fixed in newer versions.') };
  } },

  // --- database ---
  { cat: 'database', check: d => {
    const ev = find(d, KODI, kodiErr(/Unable to open database|Can't connect to (?:local )?(?:MySQL|MariaDB)|MySQL error|\[mysql\w*\]|Access denied for user|database disk image is malformed|SQLite error/i));
    if (!ev.count) return;
    const shared = /<(?:video|music)database>/.test(d.log.sec('advancedsettings.xml'));
    return { sev: 'bad', text: T('Database errors in the Kodi log ({0}×).', ev.count), ev,
      hint: shared ? T('Check the server address, user, password and database name in advancedsettings.xml, that the database server is running, and that all Kodi devices run the same Kodi version.')
        : T('The local library database may be damaged. Try cleaning the library, or restore a backup of the database.') };
  } },

  // --- Kodi settings ---
  { cat: 'settings', check: d => {
    // mistakes in the user's advancedsettings.xml: Kodi ignores the whole file if it isn't valid XML or its root isn't
    // <advancedsettings>, reads only the first of two blocks with the same name, and no longer uses <cache>
    const text = d.log.sec('advancedsettings.xml');
    if (!text.trim().startsWith('<') || /^An error occurred while grabbing/m.test(text)) return;
    const sec = 'advancedsettings.xml', tagLines = tags => find(d, sec, new RegExp(`^\\s*<(?:${tags.join('|')})[\\s>/]`));
    const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) {
      // the browser's parser names the line: Chrome "error on line 12 at column 5: Opening and ending tag mismatch: …",
      // Firefox "XML Parsing Error: mismatched tag … Line Number 12, Column 5"
      const e = err.textContent, c = /error on line (\d+) at column \d+: (.*?)(?:Below is a rendering|$)/s.exec(e), f = /XML Parsing Error: ([^\n]*)[\s\S]*?Line Number (\d+)/.exec(e);
      const line = c ? +c[1] : f ? +f[2] : 0, why = (c ? c[2] : f ? f[1] : '').trim();
      const s = d.log.byName[sec], kodi = find(d, KODI, /Error loading .*advancedsettings\.xml/);
      return { sev: 'bad', text: T('advancedsettings.xml is not valid XML, so Kodi ignores the whole file.') + (why ? ` ${T('Line {0}: {1}', line, why)}` : ''),
        hint: T('Check that every tag is closed and spelled the same at both ends, and that the file has no text outside the tags. A missing “/” is a common cause.'),
        ev: line && s.lines[line - 1] != null ? { hits: [{ sec, line: line - 1, n: s.startLine + line - 1, text: s.lines[line - 1] }, ...kodi.hits], count: 1 + kodi.count } : kodi };
    }
    const root = doc.documentElement.tagName;
    if (root !== 'advancedsettings') return { sev: 'bad', text: T('advancedsettings.xml starts with <{0}> instead of <advancedsettings>, so Kodi ignores the whole file.', root),
      hint: T('Put all the settings inside one <advancedsettings> … </advancedsettings> block.'), ev: tagLines([root]) };
    const out = [];
    const count = {};
    for (const c of doc.documentElement.children) count[c.tagName] = (count[c.tagName] || []).concat(c);
    const dups = Object.entries(count).filter(([, els]) => els.length > 1);
    if (dups.length) {
      // the settings that are lost: the child elements of the second and later blocks
      const lost = [...new Set(dups.flatMap(([, els]) => els.slice(1).flatMap(e => [...e.children].map(c => c.tagName))))];
      out.push({ sev: 'warn', text: T('advancedsettings.xml has the same block more than once: {0}. Kodi only reads the first one, so these settings are ignored: {1}.',
          dups.map(([t, els]) => `<${t}> (${els.length}×)`).join(', '), lost.join(', ') || '?'),
        hint: T('Merge the blocks with the same name into one.'), ev: tagLines(dups.map(([t]) => t)) });
    }
    if (count.cache) out.push({ sev: 'info', text: T('advancedsettings.xml has a <cache> block, which Kodi no longer uses.'),
      hint: T('Set the cache under Settings → Services → Caching instead (the Kodi log lists the values in use under “New Cache GUI Settings”).'), ev: tagLines(['cache']) });
    return out;
  } },

  { cat: 'settings', check: d => {
    // OSMC copies Kodi's time zone (Settings → Interface → Regional) to the system each time Kodi starts. With an invalid
    // one (the default "etc/localtime") the copy fails, and the Kodi log and the system journal then use different times.
    const ev = find(d, sysSec(d), /mediacenter\[\d+\]: \/bin\/cp: cannot stat '\/usr\/share\/zoneinfo\//);
    if (!ev.count) return;
    const tz = (d.gui.find(s => s.id === 'locale.timezone') || {}).value;
    return { sev: 'info', text: T('The time zone could not be set from Kodi’s setting “{0}”.', tz || '?'), ev,
      hint: T('Choose the time zone under Settings → Interface → Regional → Timezone. Until then the times in the Kodi log can differ from the system journal’s by whole hours.') };
  } },

  // --- about the log ---
  { cat: 'log', check: d => d.kodi && (d.kodi.debugLogging
    ? { sev: 'ok', text: T('Debug logging is enabled, so the Kodi log has full detail.') }
    : { sev: 'info', text: T('Debug logging is off.'), hint: T('For troubleshooting: enable it under Settings → System → Logging, reproduce the problem and make a new log with grab-logs -A.') }) },
  { cat: 'log', check: d => {
    // sections grab-logs failed to collect ("boot cmdline" always fails on Vero devices, and a file that doesn't
    // exist, like advancedsettings.xml on most systems, is not an error; a missing program, like ifconfig, is)
    const errSecs = d.log.sections.filter(s => /^An error occurred while grabbing/m.test(s.text) && s.name !== 'boot cmdline' && !/No such file or directory: '\//.test(s.text));
    const noIfconfig = errSecs.some(s => s.name === 'ifconfig');
    return errSecs.length && { sev: 'info', text: T('grab-logs could not collect: {0}.', errSecs.map(s => s.name).join(', ')),
      hint: noIfconfig ? T('The ifconfig program is missing, so the network details are taken from the system journal where possible. It is part of the net-tools package: sudo apt-get install net-tools') : '' };
  } },
  { cat: 'log', check: d => {
    const cut = d.log.sections.filter(s => s.truncated);
    return cut.length && { sev: 'warn', text: T('The log file is cut off in: {0}.', cut.map(s => s.name).join(', ')), hint: T('Load the whole file; parts of the log are missing.') };
  } },
];

// Runs all rules -> findings with their category, most serious first. A rule that throws is skipped,
// so one broken rule can't break the page.
function problems(d) {
  const out = [], cats = Object.keys(CATS);
  for (const r of RULES) {
    let res;
    try { res = r.check(d); } catch (e) { console.error('Problem rule failed', r, e); continue; }
    for (const f of [].concat(res || [])) if (f) out.push({ ...f, cat: r.cat });
  }
  return out.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || cats.indexOf(a.cat) - cats.indexOf(b.cat));
}
// categories switched off in the Problems tab, remembered in this browser
function catsOff() {
  try { return new Set(JSON.parse(localStorage.getItem('osmclog.cats.off') || '[]')); } catch { return new Set(); }
}
// One finding in the Problems tab: category badge, text, advice and the log lines behind it. The first 5 lines
// are shown; the rest are folded away. Each line links to the same line in Raw sections.
function problemHtml(f) {
  const line = h => {
    const lv = /\s(error|warning)\s</.exec(h.text);
    return `<div${lv ? ` class="lv-${lv[1]}"` : ''}><a href="#" class="plain" data-sec="${esc(h.sec)}" data-line="${h.line}" title="${esc(T('Show in Raw sections'))}"><span class="ln">${h.n}</span>${esc(h.text)}</a></div>`;
  };
  let ev = '';
  if (f.ev && f.ev.hits.length) {
    const first = f.ev.hits.slice(0, 5), rest = f.ev.hits.slice(5);
    ev = `<div class="lines">${first.map(line).join('')}</div>`;
    if (rest.length) ev += `<details><summary>${esc(T('Show {0} more lines', rest.length))}</summary><div class="lines">${rest.map(line).join('')}</div></details>`;
    if (f.ev.count > f.ev.hits.length) ev += `<p class="muted">${esc(T('Showing {0} of {1}. Search Raw sections for the rest.', f.ev.hits.length, f.ev.count))}</p>`;
  }
  return `<li class="${f.sev}"><div>${badge(T(CATS[f.cat]))} ${esc(f.text)}</div>${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}${ev}</li>`;
}

// ---------- known harmless messages ----------
// Errors and warnings that show up in almost every OSMC log, also from systems without problems, and that don't
// need any action. The error lists in the Kodi log and System tabs hide them unless "Show known harmless messages"
// is ticked, and the repeated-error rule ignores them. [regex, reason shown as a tooltip]
const EVERY_START = 'Logged on every start; not a problem.';
const HARMLESS = [
  // Kodi log
  [/DBus error: org\.freedesktop\.DBus\.Error\.ServiceUnknown - The name org\.freedesktop\.UPower/, 'OSMC has no UPower service; Kodi uses another way to shut down.'],
  [/\[xkb\] couldn't find a Compose file|CLibInputKeyboard: Failed to compile localized compose table/, 'Only affects composed characters typed on a USB keyboard.'],
  [/OSMCSecureOS(?:::getKeyId: unable to get key id|: key-id = <unknown>)/, EVERY_START],
  [/CAddonMgr::FindAddons: Addon '[^']+' already present with higher version/, 'Kodi uses the newer copy of the add-on.'],
  [/JSONRPC: Could not parse type "Setting\.Details\.SettingList"/, EVERY_START],
  [/CActiveAE::StateMachine - signal: \d+ from port: OutputControlPort not handled/, EVERY_START],
  [/missing version attribute/, EVERY_START],
  [/LoadTimers: Could not load timers file .*Timers\.xml/, 'The skin has no timers file.'],
  [/Skin has invalid include: Custom_Overlay_Debug_Grid_coords/, EVERY_START],
  [/\[GBM\] missing support for EGL_KHR_fence_sync/, EVERY_START],
  [/CDVDMessageQueue\(audio\)::Put MSGQ_NOT_INITIALIZED/, 'Logged when a playback starts; not a problem.'],
  [/Update3dResolutions: No valid 3D resolutions found/, 'The TV has no 3D modes.'],
  [/GetDirectory - Error getting udf:\/\/.*\/BDMV\/META\//, 'The disc image has no menu metadata; playback is not affected.'],
  [/is deprecated and might be removed in future Kodi versions/, 'A note for the add-on’s author; it does not affect playback.'],
  // skins and their helper add-ons asking for controls or windows the current skin doesn't have
  [/EXCEPTION: Non-Existent Control \d+|Control -?\d+ in window \d+ has been asked to focus, but it can't|Window Translator: Can't find window/,
    'The skin or an add-on refers to a control or window the skin doesn’t have; nothing visible goes wrong.'],
  [/EXCEPTION: Kodi is not playing any media file/, 'An add-on asked about the playing file while nothing was playing; not a problem.'],
  [/GetDirectory - Error getting \/home\/osmc\/\.kodi\/userdata\/(?:\.hts|auto\.master\.d)\//, 'An OSMC settings folder that doesn’t exist until it is used; not a problem.'],
  // system journal and kernel (Vero): drivers probing hardware the Vero doesn't have or use, at every start
  [/tee_client_open_session failed|meson-mmc: (?:sdio: resp_timeout|get temperature failed)|could not get clock \/(?:cvbsout|amhdmitx):|cvbsout_clktree_probe|aml_iomap: (?:read|write) cbus reg/, EVERY_START],
  [/Failed to add I2SIn CLK|failed add snd tdm controls|aml_tdm_get_pins error|failed to get vad wakeup sample rate|Failed to add audio effects v1 controls/, EVERY_START],
  [/failed to get msr ring reg0|platform get irq earc_tx failed|dmi: Firmware registration failed|verity-avb: AVB error handler|ion-dev: failed get|failed to init DMA memory pool/, EVERY_START],
  [/picdec: probe of picdec failed|request_irq error ret=-22|dev_pm_set_wake_irq failed|page_trace_module_init, create sysfs failed|get gate \w+ control failed/, EVERY_START],
  [/Failed to query device driver: Device or resource busy|Unable to detect cache hierarchy|read auto_cali_idx fail|get fclk_div5 fail|fail to init PTP|RX aggregation threshold/, EVERY_START],
  [/evrepeat .* failed with exit code|Failed to call EVIOCSKEYCODE|mpd_setminalloc: ignoring request/, EVERY_START],
  [/RTW: WARN Invalid rate/, 'A message from the Wi-Fi driver; not a problem.'],
  [/hdmitx: \[load_edid_data\] failed to open file/, 'No custom EDID file is used, which is normal.'],
  // system journal and kernel (Raspberry Pi)
  [/module is from the staging directory, the quality is unknown|ignored null byte in input|connman-vpn\.service not found|urandom warning\(s\) missed/, EVERY_START],
  [/kernel reports TIME_ERROR: .*Clock Unsynchronized/, 'The clock is not set yet just after start.'],
];
// The reason a message is known to be harmless (English, for T()), or undefined.
const harmlessWhy = s => (HARMLESS.find(([re]) => re.test(s)) || [])[1];
// Whether the error lists show the known harmless messages (remembered in this browser; hidden by default).
function showHarmless() {
  try { return localStorage.getItem('osmclog.harmless') === 'show'; } catch { return false; }
}
// Table rows for grouped messages ([{ text, … }]) with the known harmless ones left out, or dimmed with a badge
// when they are shown. cells(g) gives the row's cells; its last cell is the message. -> { rows, hidden }
function harmlessRows(groups, cells) {
  const show = showHarmless();
  let hidden = 0;
  const rows = [];
  for (const g of groups) {
    const why = harmlessWhy(g.text);
    if (why && !show) { hidden++; continue; }
    const c = cells(g);
    if (why) {
      c[c.length - 1] = raw(val(c[c.length - 1]) + ` <span class="badge" title="${esc(T(why))}">${esc(T('known harmless'))}</span>`);
      c.cls = 'harmless';
    }
    rows.push(c);
  }
  return { rows, hidden };
}
// Checkbox that shows or hides the known harmless messages in all error lists (handled in render()).
const harmlessToggle = n => `<div class="toolbar"><label class="chk"><input type="checkbox" data-harmless${showHarmless() ? ' checked' : ''}> ${esc(T('Show known harmless messages ({0})', n))}</label></div>`;
// An error list: the toggle, then the table, or a note when every message is a hidden harmless one.
function harmlessTable(groups, headers, cells, opts) {
  const { rows, hidden } = harmlessRows(groups, cells);
  return harmlessToggle(groups.filter(g => harmlessWhy(g.text)).length)
    + (!rows.length && hidden ? `<p class="empty">${esc(T('Only known harmless messages.'))}</p>` : table(headers, rows.slice(0, opts.max || rows.length), opts));
}
