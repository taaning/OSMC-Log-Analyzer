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
| **Overview** | Automatic observations, key system facts and a check for banned add-ons |
| **Kodi settings** | All `guisettings.xml` settings, searchable, with an option to show only values changed from the default; `advancedsettings.xml` |
| **Sources & storage** | Media sources, active network mounts and disk space |
| **Display & audio** | The TV/receiver's EDID (supported modes, HDR, Dolby Vision, audio formats), current display mode, user display overrides, Kodi's audio settings and passthrough formats, resolution changes |
| **System** | Hardware and network, OSMC and Debian packages, APT sources and history, kernel and system journal errors and warnings |
| **Kodi log** | Errors grouped and counted, playbacks, and a search across the whole log |
| **Raw sections** | Each section of the log file as it is, for anything the other tabs don't cover |

### Observations

The overview flags common problems and things worth knowing, for example:

- Audio passthrough is off although the TV/receiver supports it, or supported formats are not enabled in Kodi
- The number of audio channels is set lower than the device supports
- **Adjust display refresh rate** is off (films at 23.976/24 fps may stutter)
- Debug logging is on
- Nearly full disks, low available memory and network errors
- Errors that repeat many times in the Kodi log
- Outdated or broken repositories
- Dolby Vision support and playbacks
- Sections that `grab-logs` could not collect

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
- add an observation
- add a tab

New texts are written in English in the code as `T('English text')`, and the same key is added to `lang/en.json` and `lang/da.json`. A missing key just shows the English text.
