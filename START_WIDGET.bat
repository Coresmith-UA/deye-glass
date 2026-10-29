@echo off
setlocal
cd /d "%~dp0electron"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js LTS from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
if not exist node_modules\electron\dist\electron.exe (
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Installation failed. Check your internet connection.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
