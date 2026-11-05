@echo off
rem Removes the Expression Bridge (Maya module + VS Code extension).
set ASK=
if "%~1"=="" set ASK=-Ask
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" -Uninstall %ASK% %*
set RESULT=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %RESULT%
