@echo off
setlocal
rem ASCII-only on purpose: mixing UTF-8 Chinese into a batch file corrupts
rem cmd.exe parsing on some Windows builds. All Chinese user-facing text is
rem printed by launcher.cjs (Node writes Unicode to the console correctly).
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
set "NODE_EXE=%SCRIPT_DIR%runtime\node.exe"
if exist "%NODE_EXE%" if exist "%SCRIPT_DIR%launcher.cjs" goto :launch
echo [error] Incomplete installation: runtime\node.exe or launcher.cjs is missing.
echo Folder: "%SCRIPT_DIR%"
echo Please re-extract the full package.
echo.
pause
exit /b 1
:launch
"%NODE_EXE%" "%SCRIPT_DIR%launcher.cjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" exit /b 0
echo.
echo [error] Launch failed. See the hints above; detailed logs are in the data
echo directory (default: %USERPROFILE%\.a-share-kline-trainer).
echo.
pause
exit /b %EXIT_CODE%
