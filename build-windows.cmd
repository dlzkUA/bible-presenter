@echo off
rem Double-click to build the Windows installer for a GitHub release.
rem What it does and what to upload afterwards: docs/RELEASE.md
chcp 65001 >nul
cd /d "%~dp0"
rem Rust puts itself here; a window opened by double-click does not know that until you log out.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
title Bible Presenter - build
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js не установлен. Сейчас откроется nodejs.org:
  echo  скачайте версию LTS, установите и запустите этот файл ещё раз.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node scripts\release.js %*
echo.
pause
