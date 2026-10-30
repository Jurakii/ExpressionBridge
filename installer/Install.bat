@echo off
rem Installs the Maya Expression Bridge (Maya module + VS Code extension).
rem Options are passed through, e.g.  Install.bat -SkipVSCode
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
set RESULT=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %RESULT%
