@echo off
rem Quit WPS Lingxi first, then run this to start it with the DevTools port.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-lingxi.ps1"
if errorlevel 1 pause
