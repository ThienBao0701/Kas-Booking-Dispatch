@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  Kas - sao luu du lieu
rem
rem  Windows goi file nay moi ngay luc 22:00 qua Scheduled Task "Kas Backup".
rem  Ban cung co the bam tay bat cu luc nao - sao luu KHONG can dung ung dung:
rem  pg_dump chup mot anh nhat quan cua co so du lieu dang chay.
rem
rem  Cach dung:
rem    KasBackup.cmd              sao luu ngay (giu lai 30 ban moi nhat)
rem    KasBackup.cmd 7            sao luu ngay, chi giu lai 7 ban moi nhat
rem
rem  Ket qua ghi vao logs\backup.log va logs\verification.log.
rem  Neu that bai, ly do nam trong logs\error.log va ung dung VAN CHAY BINH THUONG.
rem
rem  ASCII-only: xem ghi chu trong Kas.cmd.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo KHONG TIM THAY NODE.JS - cai dat ban LTS tai https://nodejs.org
  exit /b 1
)

if not exist "server\dist\scripts\backup.js" (
  echo CHUA BUILD UNG DUNG - chay: npm run build
  exit /b 1
)

if "%~1"=="" (
  node "server\dist\scripts\backup.js" --scheduled
) else (
  node "server\dist\scripts\backup.js" --scheduled "--retain=%~1"
)

exit /b %ERRORLEVEL%
