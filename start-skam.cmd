@echo off
rem SKAM: open the built site (dist) at http://localhost:5173 without Node.js
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve.ps1"
