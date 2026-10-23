@echo off
setlocal
title Aircraft Deal Platform
cd /d "%~dp0"
echo.
echo  Aircraft Deal Platform
echo  Folder: %CD%
echo.
if not exist "platform\server.js" goto notextracted
where node >nul 2>nul
if errorlevel 1 goto nonode
cd platform
for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo  Node.js version: %NODEV%
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode
if /i "%1"=="real" set SEED_DEMO=0
set OPEN_BROWSER=1
set NODE_OPTIONS=--disable-warning=ExperimentalWarning
echo.
echo  Starting. Your browser opens by itself.
echo  First time: create the admin account and write the password down.
echo  Keep this window open while you use the program. To stop it, close this window.
echo.
node server.js
echo.
echo  The program stopped. If you did not close it yourself, read the message above.
goto end

:notextracted
echo  Cannot find the "platform" folder next to this file.
echo  You probably started start.bat from inside the zip file.
echo  Close this window. Right-click the zip file, choose "Extract All", open the new folder,
echo  and double-click start.bat there.
goto end

:nonode
echo  Node.js is not installed, or Windows does not know about it yet.
echo  1. Install the LTS version from https://nodejs.org
echo  2. Restart the computer, then double-click start.bat again.
start https://nodejs.org
goto end

:oldnode
echo  Your Node.js (%NODEV%) is too old. Version 22.13 or newer is needed.
echo  Install the LTS version from https://nodejs.org , restart the computer, and try again.
start https://nodejs.org
goto end

:end
echo.
pause
endlocal
