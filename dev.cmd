@echo off
REM 双击运行入口：直接调用同目录下的 dev.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
