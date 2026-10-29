@echo off
setlocal
cd /d "%~dp0electron"
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
call npm run dist
if errorlevel 1 goto fail
echo EXE: electron\dist\Deye-Glass.exe
echo Copy config.ini and sounds folder next to the EXE before running.
pause
exit /b 0
:fail
pause
exit /b 1
