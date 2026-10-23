@echo off
setlocal
title Aircraft Deal Platform - public tunnel
cd /d "%~dp0"
echo.
echo  Aircraft Deal Platform - public address through Cloudflare
echo.
if not exist "platform\server.js" goto notextracted
where node >nul 2>nul
if errorlevel 1 goto nonode
where cloudflared >nul 2>nul
if errorlevel 1 goto nocf
if not exist "platform\data\platform.db" goto noadmin
cd platform
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode
for /f "delims=" %%s in ('node tools\ensure-secret.js') do set APP_SECRET=%%s
set PORT=3000
set COOKIE_SECURE=1
set TRUST_PROXY=1
set REQUIRE_2FA=admin
set NODE_OPTIONS=--disable-warning=ExperimentalWarning
echo  Starting the app in a second window. Do not close that window.
start "Aircraft app" /min cmd /c "node server.js & pause"
timeout /t 5 >nul
echo.
echo  Your public address appears below, on a line like https://something.trycloudflare.com
echo  Open it and sign in with your admin account. The address changes every time.
echo  To stop everything, close this window and the "Aircraft app" window.
echo.
cloudflared tunnel --url http://localhost:3000
goto end

:notextracted
echo  Cannot find the "platform" folder next to this file. Extract the zip first.
goto end

:nonode
echo  Node.js is not installed. Install the LTS version from https://nodejs.org and restart the computer.
goto end

:oldnode
echo  Your Node.js is too old. Version 22.13 or newer is needed.
goto end

:nocf
echo  cloudflared is not installed. Open a new Command Prompt and run:
echo      winget install --id Cloudflare.cloudflared
echo  Then close it, open this file again.
goto end

:noadmin
echo  No admin account exists yet. First double-click start.bat, create the admin account, close it,
echo  then run this file. Otherwise the first stranger who opens the public address could create the admin.
goto end

:end
echo.
pause
endlocal
