@echo off
setlocal
if not exist "%LOCALAPPDATA%\HermesDeskAgent\credential.dpapi" (
  node "%~dp0bin\hermesdesk.js" connect
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node "%~dp0bin\hermesdesk.js" chat %*
if errorlevel 1 pause
