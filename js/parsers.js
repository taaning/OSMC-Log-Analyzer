// OSMC Log Analyzer – parsers.js: Cuts the log file into sections, and one parser per section type; Kodi log analysis (playbacks, errors).
// See the comment at the top of index.html for how the files fit together.
'use strict';

// ---------- splitting ----------
// A grab-logs file starts with a header ("Logs created on: … (Uptime = …)" and a table of contents),
// followed by sections wrapped in markers that share a random id:
//   ====================== Kodi Log =================== HyhIT4UP
//   …section content…
//   ---------------------- Kodi Log END --------------- HyhIT4UP
// Returns { sections: [{ name, id, startLine, lines, text, truncated? }], byName, created, uptime, sec(name) }.
// sec(name) returns a section's text, or '' if the section is missing, so callers never need null checks.
function parseLog(text) {
  const lines = text.split(/\r?\n/);
  const startRe = /^={6,} (.+?) ={6,} (\S+)\s*$/;
  const endRe = /^-{6,} (.+?) END -{6,} (\S+)\s*$/;
  const sections = [], byName = {}, header = [];
  let cur = null;
  const close = () => {
    while (cur.lines.length && !cur.lines[cur.lines.length - 1].trim()) cur.lines.pop();
    cur.text = cur.lines.join('\n');
    sections.push(cur);
    byName[cur.name] = cur;
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; let m;
    if (cur) {
      if ((m = endRe.exec(l)) && m[2] === cur.id) { close(); continue; }
      cur.lines.push(l);
    } else if ((m = startRe.exec(l))) {
      // startLine is the 1-based line number of the section's first content line in the original file
      cur = { name: m[1], id: m[2], startLine: i + 2, lines: [] };
    } else if (!sections.length) header.push(l);
  }
  // a section without an END marker means the file was cut off
  if (cur) { cur.truncated = true; close(); }
  const h = header.join('\n');
  const created = /Logs created on:\s*(.+?)\s*-\s*\(Uptime\s*=\s*([\d.]+)\)/.exec(h);
  return {
    sections, byName,
    created: created && created[1],
    uptime: created && parseFloat(created[2]),
    sec: name => byName[name] ? byName[name].text : '',
  };
}

// ---------- parsers ----------
// Each parser takes the text of one section (log.sec('…')) and returns plain data; no HTML is built here.
// They are forgiving: unexpected lines are skipped rather than throwing.

// "UNAME": `uname -a` -> { host, kernel, arch }.
function parseUname(t) {
  const p = t.trim().split(/\s+/);
  return { host: p[1], kernel: p[2], arch: p[p.length - 2] };
}
// "cmdline": kernel command line -> { key: value } (flags without '=' get the value true).
function parseCmdline(t) {
  const o = {};
  for (const tok of t.trim().split(/\s+/)) {
    const i = tok.indexOf('=');
    if (i > 0) o[tok.slice(0, i)] = tok.slice(i + 1); else if (tok) o[tok] = true;
  }
  return o;
}
// "GUI Settings (abridged)": lines like "Name: value" or "Name: value ===> Default: x".
// The "===> Default" part only appears when the setting differs from its default.
// -> [{ name, value, def, changed }]
function parseAbridged(t) {
  // split on ": " so names like "Display 4:3 videos as" stay intact
  return t.split('\n').filter(l => l.includes(': ')).map(l => {
    const i = l.indexOf(': ');
    const name = l.slice(0, i).trim();
    let value = l.slice(i + 2).trim(), def = null;
    const m = /^(.*?)\s*===>\s*Default:\s*(.*)$/.exec(value);
    if (m) { value = m[1]; def = m[2]; }
    return { name, value, def, changed: def !== null };
  });
}
// "guisettings.xml": every <setting id="…">. Kodi adds default="true" to settings left at their default,
// so a setting without it has been changed. A regex is used instead of DOMParser because grab-logs'
// masking can leave the XML slightly broken. -> [{ id, isDefault, value }]
function parseGuiSettings(t) {
  const out = [];
  const re = /<setting id="([^"]+)"((?:\s+\w+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/setting>)/g;
  let m;
  while ((m = re.exec(t))) {
    out.push({ id: m[1], isDefault: /default="true"/.test(m[2]), value: xmlDecode(m[3] ?? '') });
  }
  return out;
}
// Child elements of one <tag>…</tag> block as [[name, value], …] (used for <defaultvideosettings> etc.).
function parseSimpleXmlBlock(t, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(t);
  if (!m) return [];
  const out = []; const re = /<(\w+)>([^<]*)<\/\1>/g; let x;
  while ((x = re.exec(m[1]))) out.push([x[1], xmlDecode(x[2])]);
  return out;
}
// Parses well-formed XML into a DOM document; returns null for empty or invalid XML.
function parseXml(t) {
  if (!t.trim().startsWith('<')) return null;
  const doc = new DOMParser().parseFromString(t.replace(/^\uFEFF/, ''), 'application/xml');
  return doc.querySelector('parsererror') ? null : doc;
}
// Flatten an XML tree into [path, value] rows, e.g. ["videodatabase › host", "192.168.1.69"].
function flattenXml(el, prefix = '') {
  const rows = [];
  for (const c of el.children) {
    const attrs = [...c.attributes].map(a => `${a.name}="${a.value}"`).join(' ');
    const p = prefix + c.tagName + (attrs ? ` [${attrs}]` : '');
    if (c.children.length) rows.push(...flattenXml(c, p + ' › '));
    else rows.push([p, c.textContent.trim()]);
  }
  return rows;
}
// "sources.xml": media sources -> [{ type (video/music/…), name, paths, isDefault }].
function parseSources(t) {
  const doc = parseXml(t);
  if (!doc) return [];
  const out = [];
  for (const type of doc.documentElement.children) {
    const def = type.querySelector(':scope > default')?.textContent.trim();
    for (const s of type.querySelectorAll(':scope > source')) {
      out.push({
        type: type.tagName,
        name: s.querySelector('name')?.textContent.trim(),
        paths: [...s.querySelectorAll('path')].map(p => p.textContent.trim()),
        isDefault: def && def === s.querySelector('name')?.textContent.trim(),
      });
    }
  }
  return out;
}
// "fstab": non-comment lines -> [{ spec, mnt, type, opts }].
function parseFstab(t) {
  return t.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const [spec, mnt, type, opts] = l.split(/\s+/);
    return { spec, mnt, type, opts };
  });
}
// "mounts" (/proc/mounts) -> [{ spec, mnt, type, opts }].
function parseMounts(t) {
  return t.split('\n').filter(Boolean).map(l => {
    const [spec, mnt, type, opts] = l.split(/\s+/);
    return { spec, mnt, type, opts };
  });
}
// "Diskspace" (`df -h`) -> [{ fs, size, used, avail, pct, mnt }].
function parseDf(t) {
  const lines = t.split('\n').filter(Boolean);
  return lines.slice(1).map(l => {
    const p = l.split(/\s+/);
    if (p.length < 6) return null;
    return { fs: p[0], size: p[1], used: p[2], avail: p[3], pct: parseInt(p[4]), mnt: p.slice(5).join(' ') };
  }).filter(Boolean);
}
// "Memory" (`free -m`) -> { Mem: { total, used, free, cache, avail }, Swap: {…} } in MB.
function parseFree(t) {
  const out = {};
  for (const l of t.split('\n')) {
    const m = /^(Mem|Swap):\s+(.*)$/.exec(l.trim());
    if (m) {
      // columns: total used free shared buff/cache available
      const n = m[2].split(/\s+/).map(Number);
      out[m[1]] = { total: n[0], used: n[1], free: n[2], cache: n[4], avail: n[5] };
    }
  }
  return out;
}
// "ifconfig": one block per interface (a block starts with a non-indented line) -> addresses, traffic and error counters.
function parseIfconfig(t) {
  const blocks = t.split(/\n(?=\S)/).filter(b => b.trim());
  return blocks.map(b => {
    const g = re => (re.exec(b) || [])[1];
    return {
      name: g(/^(\S+?):/),
      inet: g(/\binet (\S+)/), mask: g(/netmask (\S+)/), inet6: g(/\binet6 (\S+)/),
      ether: g(/ether (\S+)/), type: g(/\(([^)]+)\)\s*$/m),
      rx: g(/RX packets \d+\s+bytes \d+ \(([^)]+)\)/), tx: g(/TX packets \d+\s+bytes \d+ \(([^)]+)\)/),
      rxErr: g(/RX errors (\d+)/), txErr: g(/TX errors (\d+)/),
    };
  }).filter(i => i.name);
}
// Prefix length -> netmask: 24 -> "255.255.255.0".
const prefixMask = n => Array.from({ length: 4 }, (_, i) => 256 - 2 ** (8 - Math.min(8, Math.max(0, n - 8 * i)))).join('.');
// "System Journal": network interfaces for logs without ifconfig (some OSMC systems don't have it, and grab-logs
// then reports "No such file or directory: 'ifconfig'"). ConnMan logs each interface, its MAC address and every
// IPv4 address it gets or loses:
//   connmand[2497]: Adding interface eth0 [ ethernet ]
//   connmand[2497]: eth0 {newlink} index 2 address 94:CC:04:60:10:A5 mtu 1500
//   connmand[2497]: eth0 {add} address 10.0.10.182/24 label eth0 family 2      ({del} when it is removed)
// The journal can hold several boots whose lines are mixed when the clock jumped, so only the lines of the last
// boot (after its "-- Boot <id> --" markers) are used. -> objects like parseIfconfig()'s, without traffic and error
// counters, wired interfaces first.
function parseJournalNet(t) {
  const lines = t.split('\n');
  const marks = lines.map(l => (/^-- Boot (\w+) --$/.exec(l) || [])[1]).filter(Boolean);
  const last = marks[marks.length - 1];
  const ifs = new Map(), get = name => ifs.get(name) || ifs.set(name, { name }).get(name);
  let boot = null;
  for (const l of lines) {
    const b = /^-- Boot (\w+) --$/.exec(l);
    if (b) { boot = b[1]; continue; }
    if (last && boot !== last) continue;
    let m;
    if ((m = /connmand\[\d+\]: Adding interface (\S+) \[ (\w+) \]/.exec(l))) get(m[1]).type = m[2] === 'wifi' ? 'Wi-Fi' : m[2][0].toUpperCase() + m[2].slice(1);
    else if ((m = /connmand\[\d+\]: (\S+) \{newlink\} index \d+ address ([0-9A-Fa-f:]{17}) /.exec(l)) && m[1] !== 'lo') {
      // a VPN tunnel (tun0) has no hardware address and logs 00:00:00:00:00:00
      if (!/^[0:]+$/.test(m[2])) get(m[1]).ether = m[2].toLowerCase();
    }
    else if ((m = /connmand\[\d+\]: (\S+) \{add\} address ([\d.]+)\/(\d+) /.exec(l))) Object.assign(get(m[1]), { inet: m[2], mask: prefixMask(+m[3]) });
    else if ((m = /connmand\[\d+\]: (\S+) \{del\} address ([\d.]+)\//.exec(l)) && ifs.has(m[1]) && ifs.get(m[1]).inet === m[2]) {
      delete ifs.get(m[1]).inet; delete ifs.get(m[1]).mask;
    }
  }
  const order = i => /^(eth|en)/.test(i.name) ? 0 : /^wl/.test(i.name) ? 1 : 2;
  return [...ifs.values()].sort((a, b) => order(a) - order(b));
}
// "OSMC Packages" / "All Other Packages" (`dpkg -l`) -> [{ status ('ii' = installed), name, version, arch, desc }].
function parseDpkg(t) {
  // the header lines ("Desired=…", "||/ Name …", "+++-===…") don't match, as they don't start with 2–3 letters and a space
  return t.split('\n').map(l => /^([a-zA-Z]{2,3})\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map(m => ({ status: m[1], name: m[2], version: m[3], arch: m[4], desc: m[5] }));
}
// "APT history.log": blank-line separated runs (Start-Date, Commandline, Install/Upgrade/Remove/Purge, End-Date)
// -> runs, newest first, with package lists split into one entry per package.
function parseAptHistory(t) {
  return t.split(/\n\s*\n/).map(b => {
    const g = k => (new RegExp(`^${k}: (.*)$`, 'm').exec(b) || [])[1];
    const pkgs = k => { const v = g(k); return v ? v.split(/\),\s*/).map(s => s.replace(/\)?$/, ')')) : []; };
    const start = g('Start-Date');
    if (!start) return null;
    return {
      start: start.replace(/\s+/, ' '), end: (g('End-Date') || '').replace(/\s+/, ' '),
      cmd: g('Commandline') || '',
      install: pkgs('Install'), upgrade: pkgs('Upgrade'), remove: pkgs('Remove'), purge: pkgs('Purge'),
      error: g('Error'),
    };
  }).filter(Boolean).sort((a, b) => b.start.localeCompare(a.start));
}
// Raspberry Pi model ("Raspberry Pi 400 Rev 1.1", from the kernel's "Machine model:" line) -> SoC.
// Kodi's "Running on" line can't be used: the Pi kernel reports "BCM2835" in /proc/cpuinfo on every model.
function piSoc(model) {
  const m = model.replace(/^Raspberry Pi\s*/, '');
  if (/^(5|500|Compute Module 5)\b/.test(m)) return 'Broadcom BCM2712';
  if (/^(4|400|Compute Module 4)/.test(m)) return 'Broadcom BCM2711';
  if (/^Zero 2/.test(m)) return 'RP3A0 (Broadcom BCM2710A1)';
  if (/^3 Model [AB] Plus|^Compute Module 3 Plus/.test(m)) return 'Broadcom BCM2837B0';
  if (/^(3|Compute Module 3)\b|^2 Model B Rev 1\.2/.test(m)) return 'Broadcom BCM2837';
  if (/^2\b/.test(m)) return 'Broadcom BCM2836';
  if (/^(Model|Zero|Compute Module\b(?! \d))/.test(m)) return 'Broadcom BCM2835';
  return '';
}
// HDMI/CTA-861 Video Identification Codes -> readable mode ("Display Mode" shows e.g. "VIC:16").
const VIC = {
  1: '640x480p60', 2: '480p60', 3: '480p60', 4: '720p60', 5: '1080i60', 16: '1080p60', 17: '576p50', 18: '576p50',
  19: '720p50', 20: '1080i50', 31: '1080p50', 32: '1080p24', 33: '1080p25', 34: '1080p30', 60: '720p24', 61: '720p25', 62: '720p30',
  93: '2160p24', 94: '2160p25', 95: '2160p30', 96: '2160p50', 97: '2160p60',
  98: '4096x2160p24', 99: '4096x2160p25', 100: '4096x2160p30', 101: '4096x2160p50', 102: '4096x2160p60',
};
// Lines indented under a header line in edid-decode output (also used for "Dolby Vision Cap").
// Returns the trimmed child lines, or null when the header is not found.
function indentedBlock(t, headerRe) {
  const lines = t.split('\n');
  const i = lines.findIndex(l => headerRe.test(l));
  if (i < 0) return null;
  const ind = lines[i].search(/\S/);
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim()) continue;
    if (l.search(/\S/) <= ind) break;
    out.push(l.trim());
  }
  return out;
}
// "EDID" (Amlogic's summary of the TV's EDID): "Key: value" lines -> { key: value } (first occurrence wins).
// flagsLine is the line without a colon that lists HDR/Dolby Vision/deep colour support.
function parseEdid(t) {
  const o = {};
  for (const l of t.split('\n')) {
    const m = /^([^:{]+?):\s*(.*)$/.exec(l);
    if (m && !o[m[1].trim()]) o[m[1].trim()] = m[2].trim();
  }
  o.flagsLine = (t.split('\n').find(l => /HDR|DolbyVision|DeepColor/.test(l) && !l.includes(':')) || '').trim();
  return o;
}
// "Audio Cap": audio formats the TV/receiver reports -> [[format, channels, sample rates, …extra]]
// (the first line is a column header and is skipped).
// Only format lines ("AC-3, 6 ch, …") are kept: some devices add a "Reserved" line and an indented
// "Dolby Vendor Specific" block (Ver:1.0, center_speaker:1 …) that are not formats.
function parseAudioCap(t) {
  return t.split('\n').slice(1).filter(l => /^[^\s,][^,]*, \d+ ch\b/.test(l) && !/^Reserved\b/.test(l)).map(l => l.split(',').map(s => s.trim()));
}

// "Kodi Log" / "Kodi Old Log": lines like
//   2026-10-31 09:30:46.882 T:2971     info <general>: message
// -> [{ date, time, thread, level, msg, extra, line }]. Lines without a timestamp (e.g. dumped XML)
// are continuation lines and are collected in the previous entry's `extra`. `line` is the 0-based line
// within the section, used to jump to the entry in the Raw sections tab.
function parseKodiLog(t) {
  const re = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+) T:(\d+)\s+(\w+) <[^>]+>: ?(.*)$/;
  const entries = []; let last = null;
  for (const [i, l] of t.split('\n').entries()) {
    const m = re.exec(l);
    if (m) { last = { date: m[1], time: m[2], thread: m[3], level: m[4].toLowerCase(), msg: m[5], extra: [], line: i }; entries.push(last); }
    else if (last && l.trim()) last.extra.push(l.trim());
  }
  return entries;
}
// Time of a Kodi log entry in ms (for durations between entries).
const kodiMs = e => Date.parse(`${e.date}T${e.time}`);
// Walks the Kodi log entries once and collects everything the page shows:
//   levels        count per log level           info        version, platform, skin, cache settings …
//   addons        Map id -> version             groups      errors/warnings grouped by message
//   devices       ALSA audio devices            playbacks   one object per VideoPlayer::OpenFile
//   resolutions   display mode switches         repoErrors  repositories Kodi complained about
// To pick up something new from the Kodi log, add a regex to the if/else chain below.
function analyzeKodi(entries) {
  const a = { levels: {}, info: {}, addons: new Map(), groups: new Map(), devices: [], playbacks: [], resolutions: [], debugLogging: false, repoErrors: new Set() };
  const lastByThread = {};
  let dev = null, pb = null;
  const devMap = new Map();
  for (const e of entries) {
    a.levels[e.level] = (a.levels[e.level] || 0) + 1;
    const msg = e.msg;
    let m;
    if (!a.first) a.first = e; a.last = e;
    if ((m = /^Starting Kodi \(([^)]+)\)\. Platform: (.*)$/.exec(msg))) { a.info.version = m[1]; a.info.platform = m[2]; }
    else if ((m = /^Running on (.*)$/.exec(msg))) a.info.runningOn = m[1];
    else if ((m = /^FFmpeg version\/source: (.*)$/.exec(msg))) a.info.ffmpeg = m[1];
    else if ((m = /^Local hostname: (.*)$/.exec(msg))) a.info.hostname = m[1];
    else if ((m = /^(\d+) CPU cores available/.exec(msg))) a.info.cores = m[1];
    else if ((m = /^Kodi compiled (.*)$/.exec(msg))) a.info.compiled = m[1];
    else if ((m = /^GUI format (.*)$/.exec(msg))) a.info.guiFormat = m[1];
    else if ((m = /^load skin from: \S+ \(version: ([^)]+)\)/.exec(msg))) a.info.skin = (/addons\/([^/]+)\//.exec(msg) || [])[1] + ' ' + m[1];
    else if (msg.startsWith('Enabled debug logging')) a.debugLogging = true;
    else if (msg.startsWith('New Cache GUI Settings')) a.info.cache = e.extra;
    else if ((m = /^CAddonMgr::FindAddons: (\S+) v(\S+) installed/.exec(msg))) a.addons.set(m[1], m[2]);
    else if ((m = /^Repository add-on (\S+) /.exec(msg)) && e.level === 'error') a.repoErrors.add(m[1]);

    // ALSA device enumeration: "Device N" followed by "m_name : value" lines; m_streamTypes is the last one.
    // Kodi enumerates more than once, so devices are de-duplicated by name.
    if ((m = /^\s+Device \d+$/.exec(msg))) { dev = {}; }
    else if (dev && (m = /^\s+m_(\w+)\s*:\s*(.*)$/.exec(msg))) {
      dev[m[1]] = m[2];
      if (m[1] === 'streamTypes') { devMap.set(dev.deviceName, dev); dev = null; }
    }

    // playback tracking: everything between VideoPlayer::OpenFile and CVideoPlayer::CloseFile belongs to that
    // playback (file path, ffmpeg stream info, Dolby Vision record, display mode switch, audio sink setup).
    // st collects how the playback started (times in ms since the epoch; most need debug logging, the
    // sync and late-frame figures also need component logging for "A/V sync" and "Video"):
    //   lost/reset   display lost and back for a refresh rate switch     hdmi      "Detected HDMI switch" (Vero) until 5 s after av
    //   cacheFrom/To buffering before playback starts                     av        first picture (OnAVStarted)
    //   pos          start position in seconds (0 = from the beginning)  resync    clock reset at start, ms
    //   syncErr      largest audio sync error in the first 5 s, ms       late      late frames in the first 5 s (maxLate: most frames behind)
    //   renders      render checks seen in the first 5 s (0 = no video component logging)   drops   frames dropped by the decoder
    //   frames       pictures from the decoder during the whole playback (0 = no video component logging, or not a Vero)
    //   gaps/maxGap  jumps in their timestamps (see below) and the largest, ms   gapLines  lines of the first 10 jumps
    if ((m = /^VideoPlayer::OpenFile: (.*)$/.exec(msg))) {
      pb = { start: e.date + ' ' + e.time.slice(0, 8), url: m[1], streams: [], dovi: null, res: null, dv: null, audio: [],
        t0: kodiMs(e), line: e.line, st: { hdmi: 0, late: 0, maxLate: 0, renders: 0, drops: 0, frames: 0, gaps: 0, maxGap: 0, gapLines: [] } };
      a.playbacks.push(pb);
    } else if (pb) {
      const st = pb.st, t = kodiMs(e), early = st.av != null && t - st.av < 5000;
      if (msg.startsWith('VideoPlayer: OnLostDisplay received')) st.lost ??= t;
      else if (msg.startsWith('VideoPlayer: OnResetDisplay received')) st.reset ??= t;
      else if (msg.startsWith('CWinSystemAmlogic: Detected HDMI switch')) { if (st.av == null || early) st.hdmi++; }
      else if ((m = /^CVideoPlayer::SetCaching - caching state (\d)/.exec(msg))) {
        if (+m[1]) st.cacheFrom ??= t;
        else if (st.cacheFrom != null) st.cacheTo ??= t;
      }
      else if (msg.startsWith('OnAVStarted:') && st.av == null) { st.av = t; st.avLine = e.line; }
      else if ((m = /^VideoPlayer::Sync - Video - pts: (-?[\d.]+)/.exec(msg))) st.pos ??= Math.max(0, +m[1] / 1e6);
      else if ((m = /^CVideoPlayerAudio - CDVDMsg::GENERAL_RESYNC\((-?[\d.]+)\)/.exec(msg))) st.resync ??= +m[1] / 1000;
      else if ((m = /^ActiveAE::SyncStream - average error of (-?[\d.]+), start adjusting/.exec(msg)) && early) st.syncErr = Math.max(st.syncErr || 0, Math.abs(+m[1]));
      else if ((m = /^PrepareNextRender: .*\blate: (-?\d+)/.exec(msg)) && early) {
        st.renders++;
        if (+m[1] > 0) { st.late++; st.maxLate = Math.max(st.maxLate, +m[1]); }
      }
      else if (/releaseFrame idx:\d+, drop:1/.test(msg)) st.drops++;
      // Vero decoder: "AMLInsecureVideoCodec::getPicture: index: 5, pts: 2.002, dur:875.867ms", where dur is the time to
      // the previous picture's timestamp. A picture that "lasts" more than 3 normal frames is a jump in the stream's
      // timestamps, seen as a jerk or a short freeze. Index 0 starts the stream again (also after a seek), and jumps
      // while fast-forwarding or rewinding (SetSpeed other than 1000, or 0 = paused) are expected.
      else if ((m = /^\w+::getPicture: index: (\d+), pts: -?[\d.]+, dur:\s*([\d.]+)ms/.exec(msg))) {
        const dur = +m[2];
        st.frames++;
        if (+m[1] && st.frameDur && dur > 3 * st.frameDur && !st.trick) {
          st.gaps++; st.maxGap = Math.max(st.maxGap, dur);
          if (st.gapLines.length < 10) st.gapLines.push(e.line);
        } else if (!st.frameDur || dur < 1.5 * st.frameDur) st.frameDur = dur;
      }
      else if ((m = /^\w+::SetSpeed, speed\((-?\d+)\)/.exec(msg))) st.trick = +m[1] !== 1000 && +m[1] !== 0;

      if (!pb.file && (m = /^CFileCache::Open - <(.+?)> opening/.exec(msg))) pb.file = m[1];
      else if ((m = /^ffmpeg\[[^\]]+\]:\s+Stream #\d+:\d+(\(\w+\))?: (Video|Audio): (.*)$/.exec(msg))) pb.streams.push({ kind: m[2], lang: (m[1] || '').replace(/[()]/g, ''), desc: m[3] });
      else if ((m = /^ffmpeg\[[^\]]+\]:\s+Stream #\d+:\d+(\(\w+\))?: Subtitle: (.*)$/.exec(msg))) pb.subs = (pb.subs || 0) + 1;
      else if ((m = /DOVI configuration record: (.*)$/.exec(msg))) pb.dovi = m[1];
      else if ((m = /^Display resolution (?:ADJUST|SET)\s*: (.*)$/.exec(msg))) pb.res = m[1];
      else if (/^DVCodec: DV support (enabled|disabled)/.test(msg)) pb.dv = msg.replace(/^DVCodec: /, '');
      else if ((m = /^CAESinkALSA::Initialize - (Requested layout .*|Opened device .*|set digital codec .*)$/.exec(msg))) pb.audio.push(m[1]);
      else if (/^CVideoPlayer::CloseFile\(\)/.test(msg) && !pb.end) { pb.end = e.date + ' ' + e.time.slice(0, 8); pb = null; }
    }
    if ((m = /^Display resolution (ADJUST|SET)\s*: (.*)$/.exec(msg))) a.resolutions.push(e.time.slice(0, 8) + '  ' + m[2]);

    // error/warning grouping; "Skipped N duplicate messages" adds to the previous message on that thread
    if (e.level === 'error' || e.level === 'warning' || e.level === 'fatal') {
      if ((m = /^Skipped (\d+) duplicate messages/.exec(msg))) {
        const g = lastByThread[e.thread];
        if (g) g.count += +m[1];
        continue;
      }
      // memory addresses differ between otherwise identical messages, so they are ignored for grouping
      const key = e.level + '|' + msg.replace(/0x[0-9a-f]+/gi, '0x…');
      let g = a.groups.get(key);
      if (!g) { g = { level: e.level, msg, count: 0, first: e.time.slice(0, 8), last: '', firstLine: e.line }; a.groups.set(key, g); }
      g.count++; g.last = e.time.slice(0, 8); g.lastLine = e.line;
      lastByThread[e.thread] = g;
    }
  }
  a.devices = [...devMap.values()];
  return a;
}
// kv() rows describing how a playback started, and jumps in its video timestamps (see pb.st in analyzeKodi).
// Rows without data are left out by kv().
// link(line, html) makes a link to a line of the Kodi log, used for the first-picture time and the first timestamp jump.
const secs = ms => `${(ms / 1000).toFixed(1)} s`;
function startRows(p, link) {
  const st = p.st;
  const sync = [st.resync != null && T('clock reset by {0} ms', Math.round(st.resync)), st.syncErr != null && T('audio off by up to {0} ms', Math.round(st.syncErr))].filter(Boolean);
  const disp = [st.lost != null && st.reset != null && T('display back after {0}', secs(st.reset - st.lost)), st.hdmi && T('{0} HDMI re-sync(s)', st.hdmi)].filter(Boolean);
  return [
    [T('Start position'), st.pos == null ? '' : st.pos < 5 ? T('from the beginning') : T('resumed at {0}', new Date(st.pos * 1000).toISOString().slice(11, 19))],
    [T('Refresh rate switch'), disp.join(', ')],
    [T('Buffering at start'), st.cacheFrom != null && st.cacheTo != null ? secs(st.cacheTo - st.cacheFrom) : ''],
    [T('Time to first picture'), st.av != null ? raw(link(st.avLine, esc(secs(st.av - p.t0)))) : ''],
    [T('A/V sync at start'), sync.join(', ')],
    [T('Late frames at start'), st.renders ? (st.late ? T('{0} in the first 5 s (up to {1} frames behind)', st.late, st.maxLate) : '0') : ''],
    [T('Dropped frames'), st.drops || ''],
    // for the whole playback, not just the start
    [T('Jumps in the video timestamps'), !st.frames ? '' : st.gaps ? raw(link(st.gapLines[0], esc(T('{0}, up to {1}', st.gaps, secs(st.maxGap))))) : '0'],
  ];
}
// Path of a playback's file. Add-on and PVR URLs are URL-encoded; a local path is logged as it is, so a "%" in
// its name ("100% Wolf.mkv") is not valid encoding and the path is then kept unchanged.
function pbPath(p) {
  const url = p.url.split('?')[0];
  try { return p.file || decodeURIComponent(url); } catch { return url; }
}
// Short video description for a playback: "hevc 3840x2160 24 fps" plus an HDR label.
function summarizeVideo(p) {
  const v = p.streams.find(s => s.kind === 'Video');
  if (!v) return { text: '' };
  const codec = v.desc.split(/[\s,]/)[0];
  const res = (/(\d{3,4}x\d{3,4})/.exec(v.desc) || [])[1] || '';
  const fps = (/([\d.]+) fps/.exec(v.desc) || [])[1];
  let hdr = '';
  if (p.dovi) hdr = 'DV P' + ((/profile: (\d+)/.exec(p.dovi) || [])[1] || '?');
  else if (/smpte2084/.test(v.desc)) hdr = 'HDR10';
  else if (/arib-std-b67/.test(v.desc)) hdr = 'HLG';
  return { text: [codec, res, fps && fps + ' fps'].filter(Boolean).join(' '), hdr };
}
// "System Journal" / "Kernel Message Log": lines matching re, grouped by message so repeats are counted once.
// Numbers are ignored when grouping. -> [{ text, count }], most frequent first.
function groupJournal(t, re) {
  const g = new Map();
  for (const l of t.split('\n')) {
    if (!re.test(l)) continue;
    // drop "Oct 31 09:30:44 host proc[pid]:" prefix to group identical messages
    const m = /^\w{3} +\d+ [\d:.]+ \S+ ([^:\[]+)(?:\[\d+\])?: (.*)$/.exec(l) || /^\[\s*[\d.]+\]\s*(?:())(.*)$/.exec(l);
    const key = m ? (m[1] ? m[1] + ': ' : '') + m[2] : l;
    const k2 = key.replace(/\d+(\.\d+)?/g, '#');
    const e = g.get(k2) || { text: key, count: 0 };
    e.count++; g.set(k2, e);
  }
  return [...g.values()].sort((a, b) => b.count - a.count);
}

// ---------- settings labels ----------
// guisettings.xml ids start with a group prefix ("audiooutput.passthrough"). This maps the prefix to a
// (translatable) group heading; unknown prefixes are shown as-is. New entries also need a key in lang/*.json.
const GROUPS = {
  audiooutput: 'Audio', videoplayer: 'Video player', videoscreen: 'Display', videoacceleration: 'Hardware acceleration',
  videolibrary: 'Video library', musiclibrary: 'Music library', myvideos: 'Videos', mymusic: 'Music', musicplayer: 'Music player',
  musicfiles: 'Music files', locale: 'Language & region', lookandfeel: 'Appearance', services: 'Services', network: 'Network',
  smb: 'SMB', nfs: 'NFS', subtitles: 'Subtitles', filelists: 'File lists', screensaver: 'Screensaver', powermanagement: 'Power management',
  debug: 'Debugging', general: 'General', addons: 'Add-ons', input: 'Input', pvrmanager: 'PVR', pvrplayback: 'PVR playback',
  pvrmenu: 'PVR menu', pvrrecord: 'PVR recording', pvrtimers: 'PVR timers', pvrpowermanagement: 'PVR power', pvrparental: 'PVR parental control',
  epg: 'EPG', weather: 'Weather', slideshow: 'Slideshow', pictures: 'Pictures', accessibility: 'Accessibility', masterlock: 'Master lock',
  cache: 'Cache', source: 'Sources', audiocds: 'Audio CD', disc: 'Disc', dvds: 'DVD', bluray: 'Blu-ray', karaoke: 'Karaoke',
  window: 'Window', scrapers: 'Scrapers', gamesgeneral: 'Games', gamesaccessibility: 'Games', gamesachievements: 'Games', games: 'Games',
  myvideosettings: 'Video settings',
};
const groupOf = id => { const p = id.split('.')[0]; return GROUPS[p] ? T(GROUPS[p]) : p; };
