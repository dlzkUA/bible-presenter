# Bible Presenter

Free presentation software for churches: Bible verses, song lyrics, PowerPoint and PDF slides, photos and videos on the projector, plus a live caption feed for vMix / OBS and a stage display for the band.

Windows 10/11 and macOS 11 or newer. Interface in 27 languages. The installer is about 10 MB.

## What it does

- **Bible.** Download any of ~1,000 public translations from the built-in catalogue, or import Zefania / OSIS XML. Type a reference (`John 3:16`, `Ин 3:16`) or search a phrase. Book names follow the language of the translation.
- **Songs.** Paste lyrics and the app splits them into verses, choruses and slides by itself: it understands headings in many languages, repeat marks (`Chorus x2`, `(2 раза)`), instrumental breaks and hymn numbering. Edits are saved automatically. ProPresenter `.pro` files and whole libraries import in one step, arrangements included, and `.proTheme` files become themes.
- **Presentations.** `.pptx` (through LibreOffice) and `.pdf` (no extra software) become slides that look exactly like the original.
- **Media.** Photos and videos, shown full screen.
- **Backgrounds.** Photo or looping video behind the text, switched live without touching the theme.
- **Service playlist.** The whole service in one list; the clicker's Next button runs from one item to the next.
- **Live output.** A web page for vMix / OBS with its own lower-third look.
- **Stage display.** Current line, next line, clock and service timer on any phone, tablet or screen on the network.
- **Phone remote.** Any phone or tablet on the same Wi-Fi becomes a remote: next and back, clear the text, black out the screen, the slides of the current item, the whole service plan and the presentation library, with slide pictures. Pair it by scanning a QR code; nothing to install.
- **Updates itself.** A new version downloads in the background and is installed when the app closes.

## How it is built

Version 3 is written in Rust with [Tauri](https://tauri.app). Everything the app does with files, imports, the network servers and the windows lives in the Rust core (`src-tauri/`). The screens are plain HTML/CSS/JS (`app/renderer/`) shown by the system's own web view: WebView2 on Windows, WebKit on macOS. There is no bundled browser, which is why the program is small.

Version 2 was built on Electron. Version 3 reads the same data folder and takes over the settings of version 2 on first start; installing it on Windows removes version 2 (the data stays). NDI output was dropped in version 3; the vMix / OBS web page remains.

## Run from source

You need:

- [Node.js](https://nodejs.org) 18 or newer;
- [Rust](https://rustup.rs) (stable);
- Windows: "Desktop development with C++" from Visual Studio Build Tools. WebView2 is already part of Windows 10/11.
- macOS: Xcode command line tools (`xcode-select --install`).

Then:

```
npm install
npm start
```

The first start compiles the Rust part and takes a few minutes; later starts are quick. Two windows open: **Control** (for the operator) and **Output** (the projector). With a second display connected, Output goes full screen on it.

## Checks

There is no CI. Everything runs on your computer, in one command:

```
npm run check          # all checks (about 20 s once compiled)
npm run check -- --fast   # without the end-to-end run
```

`npm install` turns on a git hook (`.githooks/pre-push`) that runs `npm run check` before every push to `master` or `main` and stops the push if anything fails.

What is checked:

- **Translations** (`scripts/check-i18n.js`): every language has every interface string; every string in the markup and in `t("…")` calls has a translation.
- **Backend integration tests** (`src-tauri/src/integration_tests.rs`, `cargo test`): Bible import (Zefania, OSIS, bad files) and phrase search on a real data folder; ProPresenter `.pro` and `.proTheme` imports; the phone remote and the live-output servers over real HTTP — pairing, wrong-PIN pause, the key on every command and picture, live state, media byte ranges.
- **End-to-end smoke test** (`tests/e2e/smoke.js`, run by `scripts/e2e.js`): the real app with a fresh, temporary data folder — a typed reference goes to the projector; pasted lyrics become slides and Next moves on; a PDF imports and shows; a phone pairs and presses Next. Your own data is never touched. On Linux without a screen it runs under `xvfb-run`.

Test fixtures are in `tests/fixtures/`. Unit tests are kept to the two places where a small function guards something big (RTF decoding of ProPresenter lyrics, ids that must not leave the data folder).

## Build installers and publish a release

Step by step, for someone doing it for the first time: [docs/RELEASE.md](docs/RELEASE.md) (in Russian).

In short: double-click `build-windows.cmd` on Windows, and run `build-mac.command` on a Mac (Intel or Apple Silicon: one universal `.dmg` works on both). Each installs what is missing, asks for the update-signing key file, builds, and puts the files to upload into `release/v<version>/`. Create the release on GitHub and upload them. Build Windows first; the Mac build then adds itself to the release's `latest.json`.

To build without the scripts: `npm run build` (macOS universal: `npm run build -- --target universal-apple-darwin`). The result is in `src-tauri/target/…/release/bundle/`.

The installers are not code-signed. On first launch Windows SmartScreen asks for confirmation ("More info" → "Run anyway"); on macOS right-click the app and choose "Open" (macOS 15 and later: System Settings → Privacy & Security → "Open Anyway"). The macOS app is ad-hoc signed, which is enough for it to run on Apple Silicon.

### Automatic updates

Installed copies check `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`. The release script fills in the address from the git remote (or asks once) and writes it into `src-tauri/tauri.conf.json` and `package.json`; commit that change. The repository must be public for updates to download.

Updates are signed, so a stranger can't push a fake update. The public half of the key is in `src-tauri/tauri.conf.json`. The private half, `bible-presenter-updater.key`, stays on your computer and in your password manager; it never goes into the repository (`.gitignore` excludes `*.key`). Without it a release still builds, only without automatic updates.

Computers still on version 2 (Electron) update from `latest.yml`, which the Windows build writes too.

To make a new key pair (if the private key is lost): `npx tauri signer generate -w bible-presenter-updater.key`, put the contents of the `.pub` file into `plugins.updater.pubkey` in `tauri.conf.json`. Copies already installed can then only update by a manual reinstall.

## Where data lives

Songs, themes, playlists, translations and media are stored outside the program folder, so updates never touch them:

- Windows: `%APPDATA%\BiblePresenter`
- macOS: `~/Library/Application Support/BiblePresenter`

Copy that folder to move everything to another computer. Nothing from it is ever part of this repository.

## Project layout

```
src-tauri/            the Rust core
  src/                windows, storage, Bible, songs, imports, servers, updates
  pages/              the live-output and stage-display web pages
  data/               the Bible catalogue and other data that ships with the app
  proto/              ProPresenter file formats (used to read .pro files)
  windows/, macos/    installer pictures and scripts
  tauri.conf.json     app name, version, windows, installers, updater
app/renderer/         the control panel (control/), the projector (output/), the phone remote (remote/)
  bridge.js           connects the pages to the Rust core
  vendor/pdfjs/       PDF reader (Mozilla pdf.js)
app/shared/           code used by both the projector and the live-output page
build/                the source pictures for the app icon (npm run icons)
docs/manual/          the user guide (English) for Notion
scripts/              checks (check.js), release build (release.js), helpers
tests/                end-to-end smoke test and the files all tests use
.githooks/            pre-push: the checks before every push to master
build-windows.cmd     double-click: Windows installer for a release
build-mac.command     macOS .dmg for a release
```
