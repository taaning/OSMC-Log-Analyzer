# OSMC Log Analyzer

A single web page that reads an OSMC log file and shows the useful parts in a clear, tabbed view: settings, display and audio capabilities, storage, packages, Kodi log errors, playbacks and banned add-ons.

Everything runs in the browser. The log file is never uploaded anywhere.

## Usage

1. On the OSMC device, create a full log with `grab-logs -A` and save it as a file (for example `osmc.log`).
2. Open the page and drop the file onto it, or click to choose it.
3. Browse the tabs. Use **Load another log** to open a different file.

The interface is available in English and Danish (the **EN / DA** buttons). The chosen language is remembered.

## What the page shows

| Tab | Contents |
| --- | --- |
| **Overview** | Key system facts, a short list of the problems found, playbacks and a check for banned add-ons |
| **Problems** | Every problem found, with advice and the log lines behind it; categories can be switched off |
| **Kodi settings** | All `guisettings.xml` settings, searchable, with an option to show only values changed from the default; `advancedsettings.xml` |
| **Sources & storage** | Media sources, active network mounts and disk space |
| **Display & audio** | The TV/receiver's EDID (supported modes, HDR, Dolby Vision, audio formats), current display mode, user display overrides, Kodi's audio settings and passthrough formats, resolution changes |
| **System** | Hardware and network, OSMC and Debian packages, APT sources and history, kernel and system journal errors and warnings |
| **Kodi log** | Errors grouped and counted (click one to jump to its line in Raw sections), playbacks with how each one started (refresh rate switch, buffering, time to first picture, A/V sync and late frames at the start) and installed add-ons |
| **Raw sections** | Each section of the log file as it is, with a search across the whole log, for anything the other tabs don't cover |

### Problems

The page checks the log for common problems, many of them ones that helpers on the OSMC forum often point out in users' logs. Each finding has a severity, a short piece of advice and the log lines that triggered it; clicking a line opens it in **Raw sections**. The checks are grouped in categories that can be switched off in the Problems tab (the choice is remembered in the browser):

| Category | Examples |
| --- | --- |
| **Add-ons** | Banned add-ons, broken repositories, Python errors in add-ons |
| **Network shares** | SMB and NFS shares Kodi could not open, failed mounts |
| **Network** | Lost connections during playback, DNS errors, TV (PVR) add-ons that can't log in to or reach their server, Wi-Fi instead of a cable, interface errors |
| **Crashes & errors** | Program crashes (segfaults), errors that repeat many times in the current or previous Kodi log |
| **Storage & memory** | Nearly full disks, low memory, out-of-memory kills, file system errors, unclean shutdowns |
| **Hardware & power** | Under-voltage, USB errors, HDMI connection drops, CEC adapter and message failures, overclocking in `config-user.txt` |
| **Display** | Refresh rate adjustment off, refresh rate switches without a pause for the TV, only 640x480 found, custom video calibration, changed default view (zoom/stretch), skin zoom, display settings in `config-user.txt`, Dolby Vision support and metadata errors |
| **Audio** | Passthrough off although the TV/receiver supports it, formats not enabled, too few channels |
| **Playback** | Playbacks that take more than 5 seconds to show a picture or have many late frames at the start, large audio sync errors |
| **Updates & packages** | Packages not fully installed, many old kernels, `apt upgrade` instead of `dist-upgrade`, APT errors, no updates for a long time |
| **Database** | MySQL/MariaDB connection errors and damaged databases |
| **About the log** | Debug logging off, sections `grab-logs` could not collect, a cut-off log file |

Most playback details need debug logging in Kodi; the A/V sync and late-frame figures also need component logging for **A/V sync** and **Video** (Settings → System → Logging).

The checks are hints, not a diagnosis: a finding is not always the cause of a problem, and not every problem is detected.

### Banned add-ons

Installed add-ons are checked against the [Banned add-ons](https://kodi.wiki/view/Official:Forum_rules/Banned_add-ons) list from the Kodi forum rules. A match by add-on ID is marked **Banned**; a match by name only is marked **Possibly banned**. No support is given on the Kodi and OSMC forums while a banned add-on is installed.

The page uses a copy of the list stored on the server (`banned-wiki.json`). The **Update from kodi.wiki** button fetches the current list and keeps it in the browser; the newest of the two copies is used. The list only gives examples, so an add-on that is not on it is not necessarily allowed.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and all JavaScript |
| `style.css` | All styling, including dark mode |
| `lang/en.json`, `lang/da.json` | UI texts in English and Danish |
| `banned-wiki.json` | Server copy of Kodi's banned add-ons list |
| `.htaccess` | Makes browsers revalidate HTML, CSS and JSON so updates show without a forced reload (Apache) |

There is no build step and there are no dependencies.

## Hosting

Copy the files to any web server. The page loads its language files and the banned add-ons list with `fetch`, so it must be served over HTTP(S); opening `index.html` directly from disk does not work.

To try it locally:

```bash
python -m http.server 8765
```

Then open <http://localhost:8765>.

## Development

The comment at the top of `index.html` describes how the script is organised and how to:

- add a translated text
- read a new log section
- add a check (a rule in `RULES`)
- add a tab

New texts are written in English in the code as `T('English text')`, and the same key is added to `lang/en.json` and `lang/da.json`. A missing key just shows the English text.
