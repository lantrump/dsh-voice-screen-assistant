@echo off
chcp 65001 >nul
title DSH Voice Assistant
rem -- Hugging Face via China mirror, disable xet backend --
set HF_ENDPOINT=https://hf-mirror.com
set HF_HUB_DISABLE_XET=1
cd /d "%~dp0"
rem -- 中文路径下 Chromium 沙箱会直接退出(exit 3)，Electron 本体放在纯英文路径 --
set "ELECTRON=%LOCALAPPDATA%\dsh-voice-electron\electron.exe"
if exist "%ELECTRON%" (
  start "" "%ELECTRON%" "%~dp0."
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\.bin\electron.cmd" .