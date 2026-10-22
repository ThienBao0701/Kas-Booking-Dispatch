@echo off
rem ---------------------------------------------------------------------------
rem  Kas - bat tu dong khoi dong cung Windows
rem
rem  BAM CHUOT PHAI vao tep nay va chon "Run as administrator".
rem  Ca hai tac vu chay duoi tai khoan SYSTEM nen Windows bat buoc phai co quyen do.
rem
rem  Mac dinh cai dat o %LOCALAPPDATA%\Kas. Neu Kas nam cho khac, mo PowerShell
rem  (Administrator) va chay:
rem
rem      .\Enable-KasAutostart.ps1 -InstallDir "C:\Kas"
rem
rem  ASCII-only: cua so cmd.exe mac dinh dung code page 437.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

set "KASDIR=%~1"
if "%KASDIR%"=="" set "KASDIR=%LOCALAPPDATA%\Kas"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Enable-KasAutostart.ps1" -InstallDir "%KASDIR%"
set EXITCODE=%ERRORLEVEL%

echo.
pause
exit /b %EXITCODE%
