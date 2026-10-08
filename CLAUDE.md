# Bible Presenter — notes for AI agents

Presentation software for churches. Tauri 2: Rust core in `src-tauri/src`, pages in plain HTML/CSS/JS in `app/renderer` (control window, projector, phone remote), web pages for vMix/OBS and the stage display in `src-tauri/pages`. README.md describes the features and the layout.

## No CI — checks run locally before every push to master

There is no GitHub Actions or any other CI, on purpose. Do not add workflows.

- `npm run check` runs everything; it must pass before anything is pushed to `master`/`main`. The git hook `.githooks/pre-push` (turned on by `npm install` via `scripts/install-hooks.js`) runs it automatically and blocks the push on failure. Never bypass it with `--no-verify` unless the owner asks.
- `npm run check -- --fast` skips the end-to-end run while iterating; run the full check before pushing.
- When you change behaviour, run the full check yourself and report the result.

Steps of `scripts/check.js`: translations (`scripts/check-i18n.js`), JS syntax (`node --check`), backend tests (`cargo test` in `src-tauri`), end-to-end (`scripts/e2e.js`).

## Testing policy

Prefer, in this order:

1. **Backend integration tests** — `src-tauri/src/integration_tests.rs`. Real files in a temporary data folder (`Paths::at`, `AppState::new`) and the real servers started on port 0, driven over HTTP with `reqwest::blocking`. New import formats, server routes and access rules get a test here.
2. **End-to-end smoke** — `tests/e2e/smoke.js`, only for scenarios a service cannot run without (verse, song, presentation on screen; phone remote). Keep it short and simple: drive real buttons, assert on `test:shown` (what reached the projector). Do not add UI-detail assertions, screenshots or timing tests.
3. **Unit tests** — almost none. Only for a small function that guards something big and is awkward to reach otherwise (currently `rtf.rs` and `store::is_safe_id`).

Delete tests that cost more upkeep or run time than they catch. Fixtures live in `tests/fixtures/` and stay tiny (a few KB).

The e2e harness: the app started with `BP_TEST=<script>` evaluates the script in the control window; `BP_TEST_OUT` gets the log, `BP_DATA_DIR` points the data folder elsewhere, `BP_TEST_LANG` sets the interface language. Test-only channels (`main.rs`, `test_channel`, refused unless `BP_TEST` is set): `test:log`, `test:exit`, `test:shown`, `test:answer` (queues answers for file dialogs), `test:outputState`, `test:http`. Keep that list minimal.

## Translations

Keys are the Ukrainian source strings in `app/renderer/control/i18n.js`; 26 more languages. Any new visible string (markup text, `placeholder`, `title`, or `t("…")`/`tf("…")`) needs an entry in **every** language — `check-i18n.js` fails otherwise. Remove keys that are no longer used from all languages.

## Releases

Built locally, uploaded by hand to GitHub Releases (step by step in `docs/RELEASE.md`, in Russian):

- `build-windows.cmd` (Windows) and `build-mac.command` (macOS, universal for Intel + Apple Silicon) call `scripts/release.js`, which checks tools, asks for the updater key file, builds, and writes the files to upload into `release/v<version>/`, including `latest.json` (merged with the one already in the GitHub release) and `latest.yml` (lets version 2 / Electron installs update).
- Version must be the same in `package.json` and `src-tauri/Cargo.toml` (`tauri.conf.json` reads `package.json`).
- The macOS build can only be made on a Mac, the Windows one on Windows.

## Privacy and secrets — hard rules

- Users' data lives in `%APPDATA%\BiblePresenter` / `~/Library/Application Support/BiblePresenter`. Nothing from there, and no personal data of any kind, ever goes into the repository, test fixtures or logs.
- The updater private key (`*.key`) never goes into the repository, a zip of the project, or a commit. `.gitignore` excludes it; the key is only read from a file the owner points to at build time and passed via `TAURI_SIGNING_PRIVATE_KEY`.
- Keep the owner's GitHub email private: don't write it into files, commit metadata you create, or package.json.

## Style

- Comments explain why, in plain English; user-facing text goes through the translation table.
- Design tokens (colours, radii, sizes) are in `app/renderer/control/app.css`; reuse them instead of inline styles.
