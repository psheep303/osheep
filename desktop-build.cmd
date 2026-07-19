@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop.ps1" -Build %*
