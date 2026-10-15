@echo off
setlocal enabledelayedexpansion

rem ---------------------------------------------------------------------------
rem  Kas - bootstrap ben trong KasSetup.exe
rem
rem  IExpress giai nen KasPayload.zip va tep nay vao mot thu muc tam, roi chay
rem  tep nay. Nhiem vu cua no: bung goi ung dung ra va goi trinh cai dat that.
rem
rem  KHONG chay tep nay truc tiep. Nhan dup KasSetup.exe.
rem
rem  Che do im lang:  KasSetup.exe /Q
rem  IExpress dat bien QUIET khi chay /Q, va trinh cai dat se khong mo trinh
rem  duyet cung khong dung lai cho ai bam phim.
rem
rem  ASCII-only: cua so cmd.exe mac dinh dung code page 437.
rem ---------------------------------------------------------------------------

rem PATHS ARE RESOLVED RELATIVE TO THIS FILE, never to the current directory.
rem IExpress extracts to a temp folder and runs this, but the working directory
rem it hands over is not reliably that folder - and when it is not, every
rem relative path here silently refers to somewhere else. That produced an
rem installer which reported success and installed nothing.
cd /d "%~dp0"

if not exist "%~dp0KasPayload.zip" (
  echo.
  echo   GOI CAI DAT HONG: khong tim thay KasPayload.zip
  echo   Hay tai lai KasSetup.exe va kiem tra Checksums.txt.
  echo.
  if not defined QUIET pause
  exit /b 1
)

rem Bung ra thu muc tam rieng cho lan cai nay. tar.exe co san tu Windows 10.
set "KASTMP=%TEMP%\KasSetup-%RANDOM%%RANDOM%"
mkdir "%KASTMP%" 2>nul

echo Dang giai nen goi cai dat...
tar.exe -x -f "%~dp0KasPayload.zip" -C "%KASTMP%"
if errorlevel 1 (
  echo.
  echo   KHONG GIAI NEN DUOC GOI CAI DAT.
  echo   Dia co the day, hoac tep tai ve bi hong - kiem tra Checksums.txt.
  echo.
  rmdir /s /q "%KASTMP%" 2>nul
  if not defined QUIET pause
  exit /b 1
)

rem Thu muc duy nhat ben trong la ban phat hanh da dong goi.
set "KASSRC="
for /d %%D in ("%KASTMP%\*") do set "KASSRC=%%D"
if not defined KASSRC (
  echo   GOI CAI DAT HONG: khong tim thay noi dung sau khi giai nen.
  rmdir /s /q "%KASTMP%" 2>nul
  if not defined QUIET pause
  exit /b 1
)

rem Chay trinh cai dat that. -NoLaunch khi cai im lang: luc do khong co ai ngoi
rem truoc may de doc ket qua hay bam gi ca.
set "KASARGS="
if defined QUIET set "KASARGS=-NoLaunch"

rem Thu muc cai dat. IExpress khong co trang chon thu muc, nen duong dan duoc
rem lay tu bien moi truong - du de trien khai hang loat va de kiem thu:
rem
rem     set KAS_INSTALL_DIR=D:\Kas
rem     KasSetup.exe /Q
rem
rem Khong dat thi mac dinh la %LOCALAPPDATA%\Kas.
if defined KAS_INSTALL_DIR set "KASARGS=%KASARGS% -InstallDir "%KAS_INSTALL_DIR%""

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%KASSRC%\installer\Install-Kas.ps1" %KASARGS%
set EXITCODE=%ERRORLEVEL%

rem Don dep thu muc tam du cai dat thanh cong hay khong: goi da duoc chep vao
rem thu muc cai dat roi, giu lai chi ton dia.
rmdir /s /q "%KASTMP%" 2>nul

if not "%EXITCODE%"=="0" (
  echo.
  echo   CAI DAT KHONG THANH CONG ^(ma %EXITCODE%^).
  echo.
  if not defined QUIET pause
)

exit /b %EXITCODE%
