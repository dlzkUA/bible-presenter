#!/bin/bash
# Builds the macOS app (one .dmg for Intel and Apple Silicon) for a GitHub release.
# Start it in Terminal: type "bash ", drag this file into the window, press Enter.
# What it does and what to upload afterwards: docs/RELEASE.md
cd "$(dirname "$0")" || exit 1
finish() { echo; read -r -p "Нажмите Enter, чтобы закрыть окно." _; exit "$1"; }

echo "Bible Presenter — сборка для Mac"

# 1. Apple's developer tools (compiler, linker)
# (xcrun, not xcode-select -p: after a macOS upgrade the old path stays but the tools are gone)
if ! xcrun --find clang >/dev/null 2>&1; then
  echo
  echo "Нужны инструменты разработчика Apple. Сейчас появится окно —"
  echo "нажмите «Установить» и дождитесь конца (5–20 минут)."
  echo "Потом запустите этот файл ещё раз."
  xcode-select --install >/dev/null 2>&1
  finish 1
fi

# 2. Node.js
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Нужен Node.js. Сейчас откроется nodejs.org: скачайте версию LTS (файл .pkg),"
  echo "установите и запустите этот файл ещё раз."
  open "https://nodejs.org"
  finish 1
fi

# 3. Rust (installed once, into your home folder)
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! command -v cargo >/dev/null 2>&1; then
  echo
  echo "Устанавливаю Rust (один раз, 1–3 минуты)…"
  installer="$(mktemp)"
  if ! curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$installer" || ! sh "$installer" -y --no-modify-path >/dev/null; then
    rm -f "$installer"
    echo "Не получилось установить Rust. Проверьте интернет и запустите ещё раз."
    finish 1
  fi
  rm -f "$installer"
  . "$HOME/.cargo/env"
fi

node scripts/release.js "$@"
finish $?
