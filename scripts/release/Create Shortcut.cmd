@echo off
setlocal
rem ASCII-only on purpose: mixing UTF-8 Chinese into a batch file corrupts
rem cmd.exe parsing on some Windows builds. The desktop shortcut label itself
rem is Chinese and is generated inside create-shortcut.ps1 via code points.
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
if exist "%SCRIPT_DIR%create-shortcut.ps1" goto :create
echo [error] Incomplete installation: create-shortcut.ps1 is missing.
echo Please re-extract the full package.
echo.
pause
exit /b 1
:create
rem Trailing "." avoids the trailing-backslash-quoting problem for arguments
rem that end right before a closing quote (e.g. "D:\pkg\").
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%create-shortcut.ps1" -PackageRoot "%SCRIPT_DIR%."
echo.
if errorlevel 1 (
  echo [error] Shortcut creation failed; report the message above.
) else (
  echo Desktop shortcut created.
)
echo.
pause
exit /b %ERRORLEVEL%
