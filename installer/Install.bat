@echo off
rem Installs the Expression Bridge (Maya module + VS Code extension).
rem Options are passed through, e.g.  Install.bat -SkipVSCode
set ASK=
if "%~1"=="" set ASK=-Ask
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %ASK% %*
set RESULT=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %RESULT%
