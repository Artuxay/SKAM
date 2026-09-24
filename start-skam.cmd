@echo off
rem SKAM: open the built site (dist) at http://localhost:5173 without Node.js
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText('%~dp0scripts\serve.ps1', [Text.Encoding]::UTF8); & ([scriptblock]::Create($s)) -Root '%~dp0dist'"
