@echo off
REM Starts the Aircraft Deal Platform on this computer (Windows).
REM   start.bat          sample aircraft included, good for trying it out
REM   start.bat real     starts empty, for your own aircraft (use this for real work)
REM Open http://127.0.0.1:3000 in your web browser. Close this window to stop it. Data is kept in the platform\data folder.
cd /d "%~dp0platform"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Opening the download page: install the LTS version, then run this again.
  start https://nodejs.org
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo.
  echo Your Node.js is too old. This needs version 22.13 or newer. Install the LTS version from https://nodejs.org
  start https://nodejs.org
  pause
  exit /b 1
)
if /i "%1"=="real" set SEED_DEMO=0
if "%PORT%"=="" set PORT=3000
set NODE_OPTIONS=--disable-warning=ExperimentalWarning
echo.
echo Starting... your browser will open. First time: create the admin account and write the password down.
echo To stop: close this window.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:%PORT%"
node server.js
pause
