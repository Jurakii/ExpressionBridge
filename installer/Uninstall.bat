@echo off
rem Removes the Maya Expression Bridge (Maya module + VS Code extension).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" -Uninstall %*
set RESULT=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %RESULT%
