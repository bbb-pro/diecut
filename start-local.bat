@echo off
title DieCut Local Preview - http://localhost:8093
cd /d "%~dp0"

echo ============================================================
echo   DieCut / Universal Box Library - Local Preview Server
echo ------------------------------------------------------------
echo   List page    : http://localhost:8093/v2/index.html
echo   Detail page  : http://localhost:8093/v2/box.html?id=A038
echo ------------------------------------------------------------
echo   Keep this window OPEN. Closing it stops the server.
echo   Auto-restarts if the process crashes (Ctrl+C to stop).
echo ============================================================
echo.

:loop
echo [%date% %time%] starting node server.js ...
node server.js
echo.
echo [%date% %time%] server exited (code %errorlevel%), restarting in 3s ...
timeout /t 3 /nobreak >nul
goto loop
