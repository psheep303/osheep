@echo off
REM Developer launcher: enables authoring, icon editing and deletion of built-in templates.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" -Developer %*
