// OSMC Log Analyzer – render.js: Builds every tab from a parsed log (buildData, render) and wires up their interactive parts.
// See the comment at the top of index.html for how the files fit together.
'use strict';

// ---------- rendering ----------
// Parsed data shared by the tabs and the problem rules (the `d` the rules get). Also used by test.html, which
// runs the rules on the example logs without drawing the page.
function buildData(log) {
  const S = log.sec;
  const uname = parseUname(S('UNAME'));
  const cmd = parseCmdline(S('cmdline'));
  const kodiEntries = parseKodiLog(S('Kodi Log'));
  const kodi = kodiEntries.length ? analyzeKodi(kodiEntries) : null;
  const oldEntries = parseKodiLog(S('Kodi Old Log'));
  const oldKodi = oldEntries.length ? analyzeKodi(oldEntries) : null;
  // installed add-ons from both Kodi logs
  const allAddons = new Map();
  for (const [k, name] of [[kodi, 'Kodi Log'], [oldKodi, 'Kodi Old Log']]) {
    if (!k) continue;
    for (const [id, ver] of k.addons) {
      const a = allAddons.get(id) || { ver, logs: [] };
      a.logs.push(name);
      allAddons.set(id, a);
    }
  }
  // network interfaces from ifconfig, or from the system journal when the log has no ifconfig (ifacesFrom says which)
  let ifaces = parseIfconfig(S('ifconfig')), ifacesFrom = 'ifconfig';
  if (!ifaces.length) { ifaces = parseJournalNet(S('System Journal')); ifacesFrom = ifaces.length ? 'journal' : ''; }
  const sysText = S('System Journal').trim() ? S('System Journal') : S('Kernel Message Log');
  const net = parseNetSetup(S('Kernel Message Log') || sysText, sysText, ifaces, [...allAddons.keys()],
    [...parseDpkg(S('OSMC Packages')), ...parseDpkg(S('All Other Packages'))]);
  return {
    log, uname, cmd, kodiEntries, kodi, oldEntries, oldKodi, allAddons, net,
    abridged: parseAbridged(S('GUI Settings (abridged)')),
    gui: parseGuiSettings(S('guisettings.xml')),
    df: parseDf(S('Diskspace')),
    mem: parseFree(S('Memory')),
    ifaces, ifacesFrom,
    audioCap: parseAudioCap(S('Audio Cap')),
    dvCap: S('Dolby Vision Cap'),
    edid: parseEdid(S('EDID')),
    bannedMatches: matchBanned(allAddons),
  };
}

// Builds the whole result view from a parsed log. It is called again on a language switch, after the banned list
// is updated and when a problem category or "Show known harmless messages" is switched, so it must only depend on
// its arguments and global state (lang, banned, activeTab, klLog and the settings in localStorage).
// Order: parse the sections -> build each tab as an HTML string -> insert the tabs -> wire up the interactive
// parts (search fields, checkboxes, selects), which need the elements to exist in the page first.
function render(log, fileName, fileSize) {
  const S = log.sec;   // S('Section name') -> section text
  const d = buildData(log);
  const { uname, cmd, kodiEntries, kodi, oldEntries, oldKodi, allAddons, bannedMatches } = d;
  // device name and OSMC version come from the Kodi log ("Running on OSMC Vero V with Open Source Media Center 2026.05-2");
  // without a Kodi log the device is guessed from osmcdev= on the kernel command line.
  // On a Raspberry Pi, Kodi just says "BCM2835", so the kernel's "Machine model:" line is used instead.
  const run = kodi && kodi.info.runningOn ? /^(?:OSMC )?(.+?) with Open Source Media Center ([^\s,]+)/.exec(kodi.info.runningOn) : null;
  const piModel = (/Machine model: (Raspberry Pi.*)/.exec(S('Kernel Message Log') + '\n' + S('System Journal')) || [])[1]?.trim();
  const soc = piModel ? piSoc(piModel) : '';
  const device = piModel || (run ? run[1] : ({ vero5: 'Vero V', vero3: 'Vero 4K / 4K+', vero2: 'Vero 2', rbp4: 'Raspberry Pi 4', rbp2: 'Raspberry Pi 2/3', rbp1: 'Raspberry Pi 1/Zero' }[cmd.osmcdev] || cmd.osmcdev));
  const osmcVer = run ? run[2] : '';
  const vic = (/VIC:(\d+)/.exec(S('Display Mode')) || [])[1];
  const root = d.df.find(x => x.mnt === '/');
  const eth = d.ifaces.find(i => i.inet && i.name !== 'lo');   // first real network interface with an address
  // wired link "1Gbps"/"Full" -> "1 Gbps, full duplex"; VPN connections -> "WireGuard tun0 (10.2.0.2)"
  const linkText = l => l && l.speed ? `${l.speed.replace(/(\d+)([GM])bps/, '$1 $2bps')}, ${T(l.duplex === 'Full' ? 'full duplex' : 'half duplex')}` : '';
  const vpnText = d.net.vpn.map(v => `${v.kind ? v.kind + ' ' : ''}${v.name} (${v.inet})`).join(', ');

  // tabs in display order; id is used for the panel element (p-<id>) and for switching tabs
  const tabs = [];
  const addTab = (id, label, html) => tabs.push({ id, label, html });

  // problem findings; categories switched off in the Problems tab are left out here and in the overview
  const off = catsOff();
  const allFound = problems(d), shown = allFound.filter(f => !off.has(f.cat));

  // --- Overview tab: key figures, observations (short list of the problems), system/Kodi/display/hardware, playbacks, banned add-ons ---
  let html = '<div class="stats">' + [
    [T('Device'), device], ['OSMC', osmcVer], ['Kodi', kodi && kodi.info.version], [T('Hostname'), uname.host],
    [T('IP address'), eth && eth.inet], [T('Uptime'), log.uptime != null ? fmtDuration(log.uptime) : ''],
    [T('Debug logging'), kodi ? T(kodi.debugLogging ? 'On' : 'Off') : ''],
  ].filter(x => x[1]).map(([l, v]) => `<div class="stat"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join('') + '</div>';
  // warn when categories are switched off in the Problems tab, since their findings are missing from the list
  const nOff = Object.keys(CATS).filter(id => off.has(id)).length;
  const offNote = nOff ? `<li class="warn">${esc(T('{0} of {1} categories are switched off, so their findings are not shown.', nOff, Object.keys(CATS).length))} <a href="#" data-goto="problems">${esc(T('Change under Problems'))}</a></li>` : '';
  html += card(T('Observations'), (shown.length || offNote ? '<ul class="obs">' + offNote + shown.map(f => `<li class="${f.sev}">${esc(f.text)}</li>`).join('') + '</ul>' : `<p class="empty">${esc(T('Nothing notable found.'))}</p>`)
    + `<p class="muted" style="margin:8px 0 0"><a href="#" data-goto="problems">${esc(T('Advice and log lines under Problems →'))}</a></p>`,
    esc(T('automatic checks, not a guarantee')));
  html += '<div class="grid">';
  html += card(T('System'), kv([
    [T('Log created'), log.created], [T('Device'), device], [T('Chip (SoC)'), soc], [T('OSMC version'), osmcVer], [T('Kernel'), uname.kernel], [T('Architecture'), uname.arch],
    [T('Debian'), S('Debian version').trim()], [T('OSMC build'), S('OSMC Build Information').trim()],
    [T('RAM type'), cmd['osmcdev.ddr_type']], [T('CPU cores'), kodi && kodi.info.cores],
  ]));
  html += card('Kodi', kv([
    [T('Version'), kodi && kodi.info.version], [T('Platform'), kodi && kodi.info.platform], [T('Compiled'), kodi && kodi.info.compiled],
    [T('FFmpeg'), kodi && kodi.info.ffmpeg], [T('Skin'), kodi && kodi.info.skin],
    [T('Debug logging'), kodi ? yesNo(kodi.debugLogging) : ''], [T('Add-ons found'), kodi && kodi.addons.size],
  ]));
  html += card(T('Display'), kv([
    [T('TV/display'), [d.edid['Rx Product Name'], d.edid['Manufacture Year'] && `(${d.edid['Manufacture Year']})`].filter(Boolean).join(' ')],
    [T('Manufacturer code'), d.edid['Rx Manufacturer Name']],
    [T('Current mode'), vic ? `VIC ${vic}${VIC[vic] ? ' = ' + VIC[vic] : ''}` : ''],
    [T('GUI'), kodi && kodi.info.guiFormat],
    [T('Boot mode (hdmimode)'), cmd.hdmimode], [T('HDMI format (cmdline)'), cmd.hdmitx],
    [T('HDR flags'), d.edid.flagsLine],
  ]));
  html += card(T('Hardware & network'), kv([
    [T('Memory'), d.mem.Mem && raw(esc(T('{0} / {1} MB used, {2} MB available', d.mem.Mem.used, d.mem.Mem.total, d.mem.Mem.avail)) + bar(100 * d.mem.Mem.used / d.mem.Mem.total))],
    [T('Root disk'), root && raw(`${esc(root.used)} / ${esc(root.size)} (${root.pct}%)${bar(root.pct)}`)],
    [T('Network'), eth && [`${eth.name} (${eth.type || ''}) ${eth.inet}/${eth.mask}`, linkText(d.net.link[eth.name])].filter(Boolean).join(' · ')],
    [T('MAC'), eth && eth.ether],
    [T('VPN'), vpnText],
  ]));
  html += '</div>';
  // playbacks from both Kodi logs, newest first
  const pbs = [
    ...(kodi ? kodi.playbacks.map(p => ({ p, log: 'Kodi Log' })) : []),
    ...(oldKodi ? oldKodi.playbacks.map(p => ({ p, log: 'Kodi Old Log' })) : []),
  ].sort((a, b) => b.p.start.localeCompare(a.p.start));
  html += card(T('Playbacks'), pbs.length ? table([T('Time'), T('File'), T('Video'), T('Audio'), T('Display mode'), T('Log')], pbs.map(({ p, log }) => {
    const v = summarizeVideo(p), a = p.streams.find(s => s.kind === 'Audio');
    const file = pbPath(p);
    return [
      `${p.start.slice(5)}${p.end ? '–' + p.end.slice(11) : ''}`,
      raw(`<span title="${esc(file)}">${esc(file.split('/').pop() || file)}</span>`),
      raw(esc(v.text) + (v.hdr ? ' ' + badge(v.hdr, 'acc') : '')),
      a ? a.desc.split(',').slice(0, 3).map(s => s.trim()).join(', ').replace(/ \(default\)/, '') + (a.lang ? ` (${a.lang})` : '') : '',
      p.res ? p.res.replace(/\s*-\s*Full Screen.*$/, '') : '',
      log === 'Kodi Log' ? T('current') : T('previous'),
    ];
  }), { cols: ['16%', '22%', '23%', '17%', '13%', '9%'] }) + `<p class="muted" style="margin:8px 0 0"><a href="#" data-goto="kodilog">${esc(T('See details under Kodi log →'))}</a></p>`
    : `<p class="empty">${esc(T('No playbacks in the log.'))}</p>`, esc(T('{0} total, newest first', pbs.length)));
  html += bannedCard(bannedMatches, allAddons.size);
  addTab('overview', T('Overview'), html);

  // --- Problems tab: category switches, then every finding with advice and the log lines behind it ---
  const worst = list => list.reduce((w, f) => SEV_ORDER[f.sev] < SEV_ORDER[w] ? f.sev : w, 'ok');
  // the "All" switch comes first; it is half-ticked (set after rendering) when only some categories are on
  const allOn = !Object.keys(CATS).some(id => off.has(id));
  html = card(T('What to look for'), '<div class="toolbar" style="margin:0">'
    + `<label class="chk all"><input type="checkbox" data-cat="*"${allOn ? ' checked' : ''}> ${esc(T('All'))}</label>` + Object.entries(CATS).map(([id, label]) => {
    const fs = allFound.filter(f => f.cat === id);
    return `<label class="chk"><input type="checkbox" data-cat="${id}"${off.has(id) ? '' : ' checked'}> ${esc(T(label))}${fs.length ? ' ' + badge(fs.length, worst(fs)) : ''}</label>`;
  }).join('') + '</div>', esc(T('categories you switch off are hidden here and in the overview, and remembered in this browser')));
  html += shown.length ? '<ul class="obs problems">' + shown.map(problemHtml).join('') + '</ul>' : `<p class="empty">${esc(T('Nothing notable found.'))}</p>`;
  const serious = shown.filter(f => f.sev === 'bad' || f.sev === 'warn').length;
  addTab('problems', T('Problems') + (serious ? ` (${serious})` : ''), html);

  // --- Kodi settings tab ---
  // The two settings tables are filled in further down (renderAb / renderGs) because they react to checkboxes and search.
  // One row of an abridged-settings table; changed settings get the blue left border.
  const settingRow = s => Object.assign([s.name, yesNo(s.value), s.def ?? ''], { cls: s.changed ? 'changed' : '' });
  html = `<section class="card"><h3>${esc(T('Key settings'))} <span class="sub">${esc(T('from grab-logs’ GUI Settings (abridged). Changed settings are marked with a blue line.'))}</span></h3>
    <div class="toolbar"><label class="chk"><input type="checkbox" id="ab-changed"> ${esc(T('Show changed only ({0})', d.abridged.filter(s => s.changed).length))}</label></div>
    <div id="ab-out"></div></section>`;
  const changedCount = d.gui.filter(s => !s.isDefault).length;
  html += `<section class="card"><h3>guisettings.xml <span class="sub">${esc(T('{0} changed of {1}', changedCount, d.gui.length))}</span></h3>
    <div class="toolbar"><input type="search" id="gs-q" placeholder="${esc(T('Search settings (id or value)…'))}">
    <label class="chk"><input type="checkbox" id="gs-all"> ${esc(T('Also show default values'))}</label></div>
    <div id="gs-out"></div></section>`;
  const dvs = parseSimpleXmlBlock(S('guisettings.xml'), 'defaultvideosettings');
  const das = parseSimpleXmlBlock(S('guisettings.xml'), 'defaultaudiosettings');
  if (dvs.length || das.length) html += '<div class="grid">' + (dvs.length ? card(T('Default video settings'), kv(dvs)) : '') + (das.length ? card(T('Default audio settings'), kv(das)) : '') + '</div>';
  if (kodi && kodi.info.cache) html += card(T('Cache'), `<pre>${esc(kodi.info.cache.join('\n'))}</pre>`, esc(T('from the Kodi log')));
  addTab('settings', T('Kodi settings'), html);

  // --- Sources & storage tab: sources.xml, fstab, network mounts, disk space, advancedsettings.xml ---
  html = '';
  const srcs = parseSources(S('sources.xml'));
  html += card(T('Media sources'), table([T('Type'), T('Name'), T('Path')], srcs.map(s => [s.type, s.name, raw(s.paths.map(p => `<code>${esc(p)}</code>`).join('<br>'))])), 'sources.xml');
  // fstab and the network mounts have long paths and options, so each gets the full width
  html += card('fstab', table([T('Source'), T('Mount point'), T('Type'), T('Options')], parseFstab(S('fstab')).map(f => [raw(`<code>${esc(f.spec)}</code>`), f.mnt, f.type, raw(`<code>${esc(f.opts)}</code>`)])));
  const netMounts = parseMounts(S('mounts')).filter(m => /^(nfs|nfs4|cifs|smb3|fuse\.sshfs)$/.test(m.type));
  html += card(T('Active network mounts'), table([T('Source'), T('Mount point'), T('Type'), T('Key options')], netMounts.map(m => [
    raw(`<code>${esc(m.spec)}</code>`), m.mnt, m.type,
    m.opts.split(',').filter(o => /^(vers|rsize|wsize|proto|hard|soft|timeo|retrans|sec|username|cache|uid|gid)/.test(o)).join(', '),
  ])), esc(T('from /proc/mounts')));
  html += card(T('Disk space'), table([T('Filesystem'), T('Size'), T('Used'), T('Free'), T('Use'), T('Mount point')],
    d.df.map(x => [raw(`<code>${esc(x.fs)}</code>`), x.size, x.used, x.avail, raw(`${x.pct}%${bar(x.pct)}`), x.mnt])));
  const adv = parseXml(S('advancedsettings.xml'));
  html += card(T('advancedsettings.xml (user)'), adv ? table([T('Setting'), T('Value')], flattenXml(adv.documentElement).map(([k, v]) => [k, unmask(v)]))
    : (S('advancedsettings.xml').trim() ? `<pre>${esc(S('advancedsettings.xml'))}</pre>` : `<p class="empty">${esc(T('No advancedsettings.xml'))}</p>`));
  // OSMC's own advancedsettings.xml is not a log section, but Kodi prints its contents at start-up
  const sysAdv = kodiEntries.find(e => /^Contents of special:\/\/xbmc\/system\/advancedsettings\.xml/.test(e.msg));
  if (sysAdv) {
    const doc = parseXml(sysAdv.extra.join('\n'));
    html += card(T('advancedsettings.xml (OSMC system)'), doc ? table([T('Setting'), T('Value')], flattenXml(doc.documentElement).map(([k, v]) => [k, xmlDecode(v)])) : `<pre>${esc(sysAdv.extra.join('\n'))}</pre>`, esc(T('OSMC’s own defaults, from the Kodi log')));
  }
  addTab('storage', T('Sources & storage'), html);

  // --- Display & audio tab: EDID, HDR, Dolby Vision, display modes, audio formats and devices ---
  const nativeVic = (/native (\d+)/.exec(S('EDID')) || [])[1];
  html = '<div class="grid">';
  html += card(T('TV / receiver (EDID)'), kv([
    [T('Product name'), d.edid['Rx Product Name']], [T('Manufacturer'), d.edid['Rx Manufacturer Name']], [T('Product code'), d.edid['Rx Product Code']],
    [T('Year of manufacture'), d.edid['Manufacture Year']], [T('Physical size (mm)'), d.edid['Physical size(mm)']], [T('EDID version'), d.edid['EDID Version']],
    [T('Physical address (CEC)'), d.edid['Source Physical Address[a.b.c.d]']], [T('Native VIC'), nativeVic && `${nativeVic} = ${VIC[nativeVic] || '?'}`],
    [T('Max TMDS (HDMI 1.4)'), d.edid.MaxTMDSClock1], [T('Max TMDS (HDMI 2.x)'), d.edid.MaxTMDSClock2],
    ['ALLM', d.edid.ALLM && yesNo(d.edid.ALLM === '1')], ['SCDC', d.edid.SCDC && yesNo(d.edid.SCDC === '1')],
    [T('HDR flags'), d.edid.flagsLine],
  ]));
  const ed = S('edid-decode');
  const eotf = indentedBlock(ed, /Electro optical transfer functions:/) || [];
  const dolbyVs = indentedBlock(ed, /Vendor-Specific Video Data Block \(Dolby\)/) || [];
  const colorimetry = indentedBlock(ed, /Colorimetry Data Block:/) || [];
  html += card(T('HDR'), kv([
    [T('Transfer functions'), eotf.length && raw('<div class="chips">' + eotf.map(e => badge(e.replace('SMPTE ST2084', 'HDR10 (SMPTE ST2084)').replace('Hybrid Log-Gamma', 'HLG'), /2084|Log-Gamma/.test(e) ? 'ok' : '')).join('') + '</div>')],
    ['HDR10+', /HDR10\+/.test(ed) ? yesNo(true) : (ed ? yesNo(false) : '')],
    [T('Dolby Vision'), d.dvCap ? yesNo(/Support mode/.test(d.dvCap)) : ''],
    [T('Colorimetry'), colorimetry.length && colorimetry.join(', ')],
  ]));
  html += '</div>';
  const dvModes = indentedBlock(d.dvCap, /^Support mode:/) || [];
  const dv60 = (/2160p60hz: (\d)/.exec(d.dvCap) || [])[1];
  html += '<div class="grid">';
  html += card(T('Dolby Vision'), kv([
    [T('VSVDB version'), (/VSVDB Version: (\S+)/.exec(d.dvCap) || [])[1]],
    ['2160p60', dv60 && yesNo(dv60 === '1')],
    [T('Supported modes'), dvModes.length && raw(dvModes.map(x => `<code>${esc(x)}</code>`).join('<br>'))],
    ...dolbyVs.map(l => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i), l.slice(i + 1).trim()] : [l, raw(badge(T('yes'), 'ok'))]; }),
  ]), esc(T('from Dolby Vision Cap and edid-decode')));
  html += card(T('Audio formats from TV/receiver'), table([T('Format'), T('Channels'), T('Sample rate'), T('Info')], d.audioCap.map(r => [r[0], r[1], r[2], r.slice(3).join(', ')])), 'Audio Cap');
  html += '</div>';
  // display mode lists ("Display Cap CTA" etc.); a trailing * marks the TV's preferred/native mode
  const capList = name => S(name).split('\n').map(s => s.trim()).filter(Boolean);
  const chipList = list => list.length ? '<div class="chips">' + list.map(c => badge(c.replace('*', ' ★'), c.endsWith('*') ? 'acc' : '')).join('') + '</div>' : `<p class="empty">${esc(T('None'))}</p>`;
  html += card(T('Supported display modes'), `<h4>CTA</h4>${chipList(capList('Display Cap CTA'))}<h4>VESA</h4>${chipList(capList('Display Cap VESA'))}<h4>3D</h4>${chipList(capList('Display Cap 3D'))}`, esc(T('★ = preferred/native mode')));
  // the section only contains the three file labels when no overrides are set
  const overrides = S('User Display Overrides').split('\n').filter(l => l.trim() && !/^(disp_cap|vesa_cap|disp_cap_3d) file$/.test(l.trim()));
  html += card(T('User display overrides'), overrides.length ? `<pre>${esc(S('User Display Overrides'))}</pre>` : `<p class="empty">${esc(T('No overrides (disp_cap, vesa_cap and disp_cap_3d are empty)'))}</p>`);
  html += card(T('Audio settings in Kodi'), table([T('Setting'), T('Value'), T('Default')],
    d.abridged.filter(s => /audio|passthrough|receiver|channels|output configuration|transcod|sounds/i.test(s.name)).map(settingRow), { cols: ['45%', '30%', '25%'] }));
  if (kodi && kodi.devices.length) html += card(T('Audio devices found by Kodi'), table([T('Device'), T('Name'), T('Type'), T('Passthrough formats')], kodi.devices.map(x => [
    raw(`<code>${esc(x.deviceName)}</code>`), [x.displayName, x.displayNameExtra].filter(Boolean).join(' – '), x.deviceType,
    /No passthrough/.test(x.streamTypes || '') ? raw(badge(T('none'))) : raw('<div class="chips">' + (x.streamTypes || '').split(',').map(s => badge(s.trim().replace('STREAM_TYPE_', ''))).join('') + '</div>'),
  ])));
  if (kodi && kodi.resolutions.length) html += card(T('Resolution changes in the Kodi log'), `<pre>${esc(kodi.resolutions.join('\n'))}</pre>`);
  addTab('display', T('Display & audio'), html);

  // --- System tab: memory, network, APT sources, kernel command line, packages, APT history, journal/kernel errors ---
  html = '<div class="grid">';
  const mb = v => v != null ? v + ' MB' : '';
  html += card(T('Memory'), table(['', T('Total'), T('Used'), T('Free'), T('Cache'), T('Available')],
    Object.entries(d.mem).map(([k, m]) => [k, mb(m.total), mb(m.used), mb(m.free), mb(m.cache), mb(m.avail)])));
  // from the journal there are no traffic or error counters, so those columns are left out
  const fromJournal = d.ifacesFrom === 'journal';
  html += card(T('Network interfaces'), fromJournal
    ? table([T('Interface'), T('Type'), T('Address'), 'MAC'], d.ifaces.map(i => [i.name, i.type || '', i.inet ? `${i.inet}/${i.mask}` : '', i.ether || '']))
    : table([T('Interface'), T('Address'), 'MAC', 'RX / TX', T('Errors')],
      d.ifaces.map(i => [i.name, [i.inet && `${i.inet}/${i.mask}`, i.inet6].filter(Boolean).join('\n'), i.ether || '', `${i.rx || '-'} / ${i.tx || '-'}`, `${i.rxErr || 0} / ${i.txErr || 0}`])),
    fromJournal ? esc(T('from the system journal, as the log has no ifconfig')) : '');
  html += '</div>';

  // network setup (for information) and Kodi's network services, from the kernel log, journal, packages and guisettings.xml
  const gs = id => (d.gui.find(s => s.id === id) || {}).value;
  const on = id => gs(id) === 'true';
  const smbProto = v => ({ 0: T('none'), 1: 'SMBv1', 2: 'SMBv2', 3: 'SMBv3' }[v] ?? v);
  const proxyTypes = ['HTTP', 'SOCKS4', 'SOCKS4A', 'SOCKS5', 'SOCKS5 (remote DNS)', 'HTTPS'];
  html += '<div class="grid">';
  html += card(T('Network setup'), kv([
    [T('Wired connection'), Object.entries(d.net.link).filter(([, l]) => l.speed).map(([n, l]) =>
      `${n}: ${linkText(l)}${l.downs ? ' · ' + T('link lost {0}× since start-up', l.downs) : ''}`).join('; ')],
    [T('VPN connection'), vpnText || T('none found')],
    [T('VPN add-ons and packages'), [...d.net.vpnAddons, ...d.net.vpnPkgs].join(', ')],
    [T('HTTP proxy'), gs('network.usehttpproxy') == null ? '' : on('network.usehttpproxy')
      ? `${proxyTypes[+gs('network.httpproxytype')] || 'HTTP'} ${gs('network.httpproxyserver') || '?'}:${gs('network.httpproxyport') || ''}` : T('Off')],
    [T('Internet bandwidth limit'), gs('network.bandwidth') == null ? '' : +gs('network.bandwidth') ? `${gs('network.bandwidth')} kbit/s` : T('No limit')],
    [T('SMB client'), gs('smb.maxprotocol') == null ? '' : [T('minimum {0}, maximum {1}', smbProto(gs('smb.minprotocol')), smbProto(gs('smb.maxprotocol'))),
      on('smb.legacysecurity') && T('legacy security'), gs('smb.chunksize') && `${T('chunk size')} ${gs('smb.chunksize')} KB`].filter(Boolean).join(', ')],
  ]), esc(T('for information')));
  // each service: on/off, with what matters about it
  const svc = (id, extra) => gs(id) == null ? '' : on(id) ? raw(badge(T('On'), 'acc') + (extra ? ` <span class="muted">${esc(extra)}</span>` : '')) : raw(badge(T('Off')));
  html += card(T('Kodi network services'), kv([
    [T('Web server'), svc('services.webserver', [`${T('port')} ${gs('services.webserverport')}`, on('services.webserverssl') && 'HTTPS',
      !on('services.webserverauthentication') && T('no password')].filter(Boolean).join(', '))],
    [T('Remote control from apps'), svc('services.esenabled', on('services.esallinterfaces') ? T('also from other devices') : T('only from this device'))],
    ['UPnP', svc('services.upnp', [on('services.upnpserver') && T('share libraries'), on('services.upnprenderer') && T('receive and play'),
      on('services.upnpcontroller') && T('control other players')].filter(Boolean).join(', '))],
    ['AirPlay', svc('services.airplay')],
    ['Zeroconf', svc('services.zeroconf', T('announces these services on the network'))],
    ['WS-Discovery', svc('services.wsdiscovery')],
  ]), 'guisettings.xml');
  html += '</div>';
  const aptSrc = [S('APT sources.list'), S('APT sources.list.d')].join('\n').split('\n').filter(l => /^\s*deb/.test(l));
  html += card(T('APT sources'), aptSrc.length ? `<pre>${esc(aptSrc.join('\n'))}</pre>` : `<p class="empty">${esc(T('None'))}</p>`);
  html += card(T('Kernel command line'), '<div class="kvgrid">' + Object.entries(cmd).map(([k, v]) =>
    `<div><code>${esc(k)}</code><span>${v === true ? '' : esc(v)}</span></div>`).join('') + '</div>', 'cmdline');
  const osmcPk = parseDpkg(S('OSMC Packages'));
  html += card(T('OSMC packages'), table([T('Package'), T('Version'), T('Architecture'), T('Description')], osmcPk.map(p => [raw(`<code>${esc(p.name)}</code>`), p.version, p.arch, p.desc]), { scroll: true }), esc(T('{0} packages', osmcPk.length)));
  // the other-packages table is filled by renderPk() below because it has a search field
  const otherPk = parseDpkg(S('All Other Packages'));
  html += `<section class="card"><h3>${esc(T('Other packages'))} <span class="sub">${esc(T('{0} packages', otherPk.length))}</span></h3>
    <div class="toolbar"><input type="search" id="pk-q" placeholder="${esc(T('Search package name…'))}"></div><div id="pk-out"></div></section>`;
  const hist = parseAptHistory(S('APT history.log'));
  html += card(T('APT history'), hist.length ? hist.map(h => `<details><summary><span class="name">${esc(h.start)}</span>
      ${h.install.length ? badge(T('{0} installed', h.install.length), 'acc') : ''}${h.upgrade.length ? badge(T('{0} upgraded', h.upgrade.length), 'ok') : ''}
      ${h.remove.length + h.purge.length ? badge(T('{0} removed', h.remove.length + h.purge.length), 'warn') : ''}${h.error ? badge(T('error'), 'bad') : ''}
      <span class="muted mono">${esc(h.cmd.replace(/^\/usr\/bin\/apt-get-real (-o \S+ )*/, 'apt-get ').slice(0, 90))}</span></summary>
      <div class="body">${h.error ? `<p class="badge bad">${esc(h.error)}</p>` : ''}${[['Installed', h.install], ['Upgraded', h.upgrade], ['Removed', h.remove], ['Purged', h.purge]].filter(x => x[1].length)
      .map(([l, p]) => `<h4>${esc(T(l))}</h4><div class="lines">${p.map(x => `<div>${esc(x)}</div>`).join('')}</div>`).join('')}</div></details>`).join('') : `<p class="empty">${esc(T('None'))}</p>`, esc(T('newest first')));
  const jErr = groupJournal(S('System Journal'), /\b(error|failed|failure|fatal|segfault|timed out)\b/i);
  // known harmless messages are left out unless "Show known harmless messages" is ticked (see HARMLESS)
  const msgCells = g => [g.count, raw(`<span class="mono">${esc(g.text)}</span>`)];
  html += card(T('System journal: errors and warnings'), harmlessTable(jErr, [T('Count'), T('Message')], msgCells, { scroll: true, max: 60 }),
    esc(T('{0} unique messages, grouped', jErr.length)));
  const kErr = groupJournal(S('Kernel Message Log'), /\b(error|failed|fail|warning|timeout|unable)\b/i);
  html += card(T('Kernel messages: errors and warnings'), harmlessTable(kErr, [T('Count'), T('Message')], msgCells, { scroll: true, max: 60 }),
    esc(T('{0} unique messages', kErr.length)));
  addTab('system', T('System'), html);

  // --- Kodi log tab: only the log selector here; the content is built by renderKl() below ---
  const kodiLogs = ['Kodi Log', 'Kodi Old Log'].filter(n => S(n).trim());
  html = `<div class="toolbar"><label class="chk">${esc(T('Log:'))} <select id="kl-sel">${kodiLogs.map(n => `<option${n === klLog ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div><div id="kl-out"></div>`;
  addTab('kodilog', T('Kodi log'), html);

  // --- Raw sections tab: search and sort controls; the list is built by renderRaw() below ---
  html = `<div class="toolbar"><input type="search" id="raw-q" placeholder="${esc(T('Search the whole log (at least 2 characters)…'))}">
    <label class="chk">${esc(T('Sort:'))} <select id="raw-sort"><option value="log">${esc(T('Log order'))}</option><option value="az">${esc(T('Alphabetical'))}</option></select></label>
    <span class="muted" id="raw-info"></span></div><div id="raw-out"></div>`;
  addTab('raw', T('Raw sections'), html);

  // --- insert the tabs into the page ---
  const tabsEl = document.getElementById('tabs'), panelsEl = document.getElementById('panels');
  tabsEl.innerHTML = tabs.map(t => `<button data-tab="${t.id}">${esc(t.label)}</button>`).join('');
  panelsEl.innerHTML = tabs.map(t => `<div class="panel" id="p-${t.id}">${t.html}</div>`).join('');
  const show = id => {
    tabsEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    panelsEl.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'p-' + id));
    activeTab = id;
  };
  // Switching tab by clicking adds a step to the browser history, so Back returns to the previous tab at the place
  // it was scrolled to (see the history handling in main.js); showTab is what Back and Forward use.
  const go = id => { saveScroll(); show(id); history.pushState({ tab: id, y: 0 }, ''); };
  showTab = id => show(tabs.some(t => t.id === id) ? id : 'overview');
  tabsEl.onclick = e => { const b = e.target.closest('button'); if (b && b.dataset.tab !== activeTab) { go(b.dataset.tab); window.scrollTo(0, 0); } };
  // One click handler for all panels (event delegation), so it survives re-rendering:
  //   data-goto="<tab id>"           link that switches tab (e.g. "See details under Kodi log")
  //   data-sec="<section>" data-line="<n>"   link to line n of a section in the Raw sections tab
  //   data-action="refresh-banned"   the "Update from kodi.wiki" button
  panelsEl.onclick = async e => {
    const a = e.target.closest('[data-goto]');
    if (a) { e.preventDefault(); go(a.dataset.goto); window.scrollTo(0, 0); return; }
    const ln = e.target.closest('[data-line]');
    if (ln) { e.preventDefault(); gotoLine(ln.dataset.sec, +ln.dataset.line); return; }
    const btn = e.target.closest('[data-action="refresh-banned"]');
    if (btn) {
      btn.disabled = true; btn.textContent = T('Fetching…');
      try {
        await refreshBanned();
        const y = window.scrollY;
        render(log, fileName, fileSize);
        window.scrollTo(0, y);
      } catch (err) {
        btn.disabled = false; btn.textContent = T('Update from kodi.wiki');
        document.getElementById('banned-status').textContent = T('Could not fetch the list: {0}', err.message);
      }
    }
  };
  // category switches in the Problems tab: remember the choice and re-render (the overview uses it too)
  // and the "Show known harmless messages" checkboxes in the error lists (one setting for all of them)
  panelsEl.onchange = e => {
    const c = e.target.closest('[data-cat]'), hm = e.target.closest('[data-harmless]');
    if (!c && !hm) return;
    try {
      if (hm) localStorage.setItem('osmclog.harmless', hm.checked ? 'show' : 'hide');
      else {
        const o = catsOff();
        const ids = c.dataset.cat === '*' ? Object.keys(CATS) : [c.dataset.cat];
        for (const id of ids) if (c.checked) o.delete(id); else o.add(id);
        localStorage.setItem('osmclog.cats.off', JSON.stringify([...o]));
      }
    } catch {}
    const y = window.scrollY;
    render(log, fileName, fileSize);
    window.scrollTo(0, y);
  };
  const allChk = panelsEl.querySelector('[data-cat="*"]');
  if (allChk) allChk.indeterminate = !allOn && Object.keys(CATS).some(id => !off.has(id));
  show(tabs.some(t => t.id === activeTab) ? activeTab : 'overview');

  // abridged settings: optional "changed only" filter
  const abChanged = document.getElementById('ab-changed'), abOut = document.getElementById('ab-out');
  const renderAb = () => {
    const list = d.abridged.filter(s => !abChanged.checked || s.changed);
    abOut.innerHTML = table([T('Setting'), T('Value'), T('Default')], list.map(settingRow), { cols: ['45%', '30%', '25%'] });
  };
  abChanged.onchange = renderAb; renderAb();

  // guisettings.xml table: search field + "also show defaults" checkbox (only changed settings by default)
  const gsQ = document.getElementById('gs-q'), gsAll = document.getElementById('gs-all'), gsOut = document.getElementById('gs-out');
  const renderGs = () => {
    const q = gsQ.value.trim().toLowerCase();
    const list = d.gui.filter(s => (gsAll.checked || !s.isDefault) && (!q || s.id.toLowerCase().includes(q) || s.value.toLowerCase().includes(q) || groupOf(s.id).toLowerCase().includes(q)));
    const groups = new Map();
    for (const s of list) { const g = groupOf(s.id); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
    // one table with group header rows, so columns line up across groups
    const rows = [...groups].map(([g, items]) => `<tr class="grp"><th colspan="3">${esc(g)} <span class="badge">${items.length}</span></th></tr>` +
      items.map(s => `<tr${s.isDefault ? '' : ' class="changed"'}><td><code>${esc(s.id)}</code></td><td>${s.value === '' ? `<span class="muted">${esc(T('(empty)'))}</span>` : val(unmask(yesNo(s.value)))}</td>` +
        `<td>${s.isDefault ? badge(T('default')) : badge(T('changed'), 'acc')}</td></tr>`).join('')).join('');
    gsOut.innerHTML = groups.size ? `<div class="tw"><table class="fixed"><colgroup><col style="width:45%"><col style="width:40%"><col style="width:15%"></colgroup>
      <thead><tr><th>${esc(T('Setting'))}</th><th>${esc(T('Value'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">${esc(T('No settings match.'))}</p>`;
  };
  gsQ.oninput = gsAll.onchange = renderGs; renderGs();

  // other packages: search by name or description; at most 500 rows are drawn at once
  const pkQ = document.getElementById('pk-q'), pkOut = document.getElementById('pk-out');
  const renderPk = () => {
    const q = pkQ.value.trim().toLowerCase();
    const list = q ? otherPk.filter(p => p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)) : otherPk;
    pkOut.innerHTML = table([T('Status'), T('Package'), T('Version'), T('Architecture'), T('Description')], list.slice(0, 500).map(p => [p.status === 'ii' ? p.status : raw(badge(p.status, 'warn')), raw(`<code>${esc(p.name)}</code>`), p.version, p.arch, p.desc]), { scroll: true })
      + (list.length > 500 ? `<p class="muted">${esc(T('Showing 500 of {0}. Search to narrow down.', list.length))}</p>` : '');
  };
  pkQ.oninput = renderPk; renderPk();

  // Kodi log tab content for the selected log (current or previous Kodi log): figures, info, grouped errors,
  // playbacks with full details and installed add-ons with their banned status
  const klSel = document.getElementById('kl-sel'), klOut = document.getElementById('kl-out');
  const renderKl = () => {
    const name = klSel.value;
    if (!name) { klOut.innerHTML = `<p class="empty">${esc(T('No Kodi log in the file.'))}</p>`; return; }
    const entries = name === 'Kodi Log' ? kodiEntries : oldEntries;
    const k = name === 'Kodi Log' ? kodi : oldKodi;
    if (!k) { klOut.innerHTML = `<p class="empty">${esc(T('Could not read the log.'))}</p>`; return; }
    let h = '<div class="stats">' + [
      [T('Lines'), entries.length], [T('Errors'), k.levels.error || 0], [T('Warnings'), k.levels.warning || 0],
      [T('Time span'), k.first ? `${k.first.time.slice(0, 8)} – ${k.last.time.slice(0, 8)}` : ''], [T('Playbacks'), k.playbacks.length], [T('Add-ons'), k.addons.size],
    ].map(([l, v]) => `<div class="stat"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join('') + '</div>';
    h += card(T('Kodi info'), kv([[T('Version'), k.info.version], [T('Running on'), k.info.runningOn], [T('Compiled'), k.info.compiled], [T('FFmpeg'), k.info.ffmpeg],
      [T('Hostname'), k.info.hostname], [T('GUI'), k.info.guiFormat], [T('Debug logging'), yesNo(k.debugLogging)],
      [T('Log levels'), raw(Object.entries(k.levels).map(([l, n]) => badge(`${l}: ${n}`, l === 'error' ? 'bad' : l === 'warning' ? 'warn' : '')).join(' '))]]));
    const grp = [...k.groups.values()].sort((a, b) => b.count - a.count).map(g => ({ ...g, text: g.msg }));
    // first/last time and the message link to that line in Raw sections
    const lineLink = (n, html) => `<a href="#" class="plain" data-sec="${esc(name)}" data-line="${n}" title="${esc(T('Show in Raw sections'))}">${html}</a>`;
    h += card(T('Errors and warnings'), harmlessTable(grp, [T('Level'), T('Count'), T('First'), T('Last'), T('Message')], g => [raw(badge(g.level, g.level === 'warning' ? 'warn' : 'bad')), g.count,
      raw(lineLink(g.firstLine, esc(g.first))), raw(lineLink(g.lastLine, esc(g.last))), raw(lineLink(g.firstLine, `<span class="mono">${esc(g.msg)}</span>`))], { scroll: true }),
      esc(T('grouped, incl. “Skipped N duplicate messages” · click to show in Raw sections')));
    // the sync and late-frame figures need component logging; say so when the log has none
    const noComp = k.playbacks.length && !k.playbacks.some(p => p.st.renders);
    h += card(T('Playbacks'), (noComp ? `<p class="muted" style="margin:0 0 8px">${esc(T('For A/V sync details at the start of each playback and jumps in the video timestamps: enable debug logging and component logging for “A/V sync” and “Video” (Settings → System → Logging), then make a new log.'))}</p>` : '')
      + (k.playbacks.length ? k.playbacks.map(p => {
      const title = pbPath(p);
      return `<div class="pb"><div class="t">${esc(title.split('/').pop() || title)}</div>
        <div class="muted mono" style="overflow-wrap:anywhere">${esc(title)}</div>${kv([
          [T('Time'), `${p.start}${p.end ? ' → ' + p.end.slice(11) : ''}`],
          ...p.streams.map(s => [s.kind === 'Video' ? T('Video') : `${T('Audio')}${s.lang ? ' (' + s.lang + ')' : ''}`, s.desc]),
          [T('Subtitles'), p.subs], [T('Dolby Vision'), p.dovi], [T('DV codec'), p.dv], [T('Display mode'), p.res],
          [T('Audio output'), p.audio.length ? p.audio.join(' · ') : ''],
          ...startRows(p, lineLink),
        ])}</div>`;
    }).join('') : `<p class="empty">${esc(T('No playbacks in the log.'))}</p>`));
    const bm = new Map(bannedMatches.map(m => [m.id, m]));
    // banned/suspect add-ons first, then alphabetical
    const addonRows = [...k.addons].sort((a, b) => (bm.has(b[0]) - bm.has(a[0])) || a[0].localeCompare(b[0]));
    h += card(T('Installed add-ons'), table([T('Add-on'), T('Version'), T('Type'), T('Status')], addonRows.map(([id, v]) => [raw(`<code>${esc(id)}</code>`), v,
      id.split('.')[0] + (id.split('.')[1] && /^(video|audio|image|program|album|artists|tvshows|movies)$/.test(id.split('.')[1]) ? '.' + id.split('.')[1] : ''), raw(bannedBadge(bm.get(id)))]), { scroll: true }),
      esc(T('from CAddonMgr::FindAddons')));
    klOut.innerHTML = h;
  };
  klSel.onchange = () => { klLog = klSel.value; renderKl(); };
  renderKl();

  // Raw sections tab. Without a search: every section as a collapsed <details>; its lines are only drawn
  // when it is opened, because some sections have thousands of lines. With a search (2+ characters):
  // only matching lines, highlighted, at most 300 per section. Line numbers refer to the original file.
  const rawQ = document.getElementById('raw-q'), rawOut = document.getElementById('raw-out'), rawInfo = document.getElementById('raw-info'), rawSort = document.getElementById('raw-sort');
  try { rawSort.value = localStorage.getItem('osmclog.rawsort') || 'log'; } catch {}
  const sortedSections = () => {
    const list = log.sections.map((s, i) => ({ s, i }));
    if (rawSort.value === 'az') list.sort((a, b) => a.s.name.localeCompare(b.s.name, undefined, { sensitivity: 'base' }));
    return list;
  };
  // one log line with its line number; Kodi error/warning lines are coloured. hl highlights search hits: it has
  // one capturing group, so split() puts the hits at the odd positions. The pieces are escaped one by one,
  // so a search for "gt" can't land inside the "&gt;" of an escaped "<".
  const lineHtml = (l, n, hl) => {
    const lv = /\s(error|warning)\s</.exec(l);
    const t = hl ? l.split(hl).map((p, i) => i % 2 ? `<mark>${esc(p)}</mark>` : esc(p)).join('') : esc(l);
    return `<div${lv ? ` class="lv-${lv[1]}"` : ''}><span class="ln">${n}</span>${t}</div>`;
  };
  // draws the lines of a collapsed section the first time it is opened
  const fillRaw = det => {
    const body = det.querySelector('.body');
    if (body.innerHTML) return;
    const s = log.sections[det.dataset.i];
    body.innerHTML = `<div class="lines">${s.lines.map((l, j) => lineHtml(l, s.startLine + j)).join('')}</div>`;
  };
  // Shows line j (0-based) of a section in the Raw sections tab: clears any search, opens the section,
  // highlights the line and scrolls it into view. Used by the line links in the Problems and Kodi log tabs; Back
  // returns to the line that was clicked.
  const gotoLine = (name, j) => {
    clearTimeout(rawT);
    if (rawQ.value) { rawQ.value = ''; renderRaw(); }
    go('raw');
    const det = rawOut.querySelector(`details[data-i="${log.sections.indexOf(log.byName[name])}"]`);
    if (!det) return;
    det.open = true; fillRaw(det);
    rawOut.querySelector('.lines .target')?.classList.remove('target');
    const el = det.querySelector('.lines').children[j];
    if (el) { el.classList.add('target'); el.scrollIntoView({ block: 'center' }); }
  };
  const renderRaw = () => {
    const q = rawQ.value.trim();
    if (q.length < 2) {
      rawInfo.textContent = T('{0} sections', log.sections.length);
      rawOut.innerHTML = sortedSections().map(({ s, i }) => `<details data-i="${i}"><summary><span class="name">${esc(s.name)}</span>
        ${badge(T('{0} lines', s.lines.length))}${s.truncated ? badge(T('truncated'), 'warn') : ''}${/^An error occurred while grabbing/m.test(s.text) ? badge(T('collection error'), 'warn') : ''}
        ${!s.text.trim() ? badge(T('empty')) : ''}</summary><div class="body"></div></details>`).join('');
      rawOut.querySelectorAll('details').forEach(det => det.addEventListener('toggle', () => { if (det.open) fillRaw(det); }));
      return;
    }
    // the search text is matched literally; hl is the same search for highlighting (see lineHtml)
    const re = new RegExp(reEsc(q), 'i'), hl = new RegExp(`(${reEsc(q)})`, 'gi');
    let total = 0;
    const parts = [];
    for (const { s } of sortedSections()) {
      const hits = [];
      s.lines.forEach((l, j) => { if (re.test(l)) hits.push([l, s.startLine + j]); });
      if (!hits.length) continue;
      total += hits.length;
      parts.push(`<details open><summary><span class="name">${esc(s.name)}</span>${badge(hits.length === 1 ? T('1 hit') : T('{0} hits', hits.length), 'acc')}</summary>
        <div class="body"><div class="lines">${hits.slice(0, 300).map(([l, n]) => lineHtml(l, n, hl)).join('')}</div>
        ${hits.length > 300 ? `<p class="muted">${esc(T('Showing 300 of {0}.', hits.length))}</p>` : ''}</div></details>`);
    }
    rawInfo.textContent = T('{0} hits in {1} sections', total, parts.length);
    rawOut.innerHTML = parts.join('') || `<p class="empty">${esc(T('No hits.'))}</p>`;
  };
  let rawT;   // debounce timer, so the whole log is not searched on every key press
  rawQ.oninput = () => { clearTimeout(rawT); rawT = setTimeout(renderRaw, 200); };
  rawSort.onchange = () => { try { localStorage.setItem('osmclog.rawsort', rawSort.value); } catch {} renderRaw(); };
  renderRaw();

  document.getElementById('fileinfo').textContent = T('{0} · {1} · {2} sections', fileName, fmtBytes(fileSize), log.sections.length) + (uname.host ? ' · ' + uname.host : '');
  document.title = `${T('OSMC Log Analyzer')} – ${uname.host || fileName}`;
}
