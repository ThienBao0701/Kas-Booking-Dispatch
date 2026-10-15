@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  Kas - cai dat (nhan dup file nay)
rem
rem  Chay trinh cai dat PowerShell trong installer\Install-Kas.ps1. Trinh cai se:
rem    - kiem tra Node.js va goi cai dat
rem    - chep ung dung vao %LOCALAPPDATA%\Kas
rem    - tao loi tat Desktop va Start Menu
rem    - dang ky trong Apps ^& features
rem
rem  Nang cap: chay lai file nay tren ban moi. Cau hinh (.env), anh da tai len
rem  va co so du lieu deu duoc giu nguyen.
rem
rem  ASCII-only: cmd.exe mac dinh dung code page 437.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

if not exist "installer\Install-Kas.ps1" (
  echo.
  echo   GOI CAI DAT KHONG DAY DU
  echo.
  echo   Hay giai nen TOAN BO thu muc ban phat hanh roi chay lai file nay.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "installer\Install-Kas.ps1" %*
set EXITCODE=%ERRORLEVEL%

echo.
pause
exit /b %EXITCODE%
