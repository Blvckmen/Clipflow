@echo off
rem Double-click to set up the Clipflow worker on this PC (see setup-windows.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1" %*
echo.
pause
