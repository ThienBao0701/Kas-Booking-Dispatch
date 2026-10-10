@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  Kas - chay nen (background runner)
rem
rem  Day la lenh ma Windows goi luc khoi dong may, qua Scheduled Task "Kas".
rem  Khong ai can double-click file nay - dung Kas.cmd de mo ung dung.
rem
rem  Khac biet duy nhat so voi Kas.cmd:
rem    - KHONG mo trinh duyet (luc khoi dong may co the chua ai dang nhap)
rem    - KHONG can cua so console
rem
rem  Cach dung:
rem    KasService.cmd            khoi dong nen
rem    KasService.cmd stop       tat an toan ban dang chay
rem
rem  "stop" gui yeu cau qua named pipe, may chu se hoan tat cac yeu cau dang xu
rem  ly roi dong co so du lieu. Dung "taskkill" se cat ngang giua chung.
rem
rem  ASCII-only: xem ghi chu trong Kas.cmd.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo KHONG TIM THAY NODE.JS - cai dat ban LTS tai https://nodejs.org
  exit /b 1
)

if not exist "server\dist\service\runner.js" (
  echo CHUA BUILD UNG DUNG - chay: npm run build
  exit /b 1
)

if /i "%~1"=="stop" (
  node "server\dist\service\runner.js" --stop
  exit /b %ERRORLEVEL%
)

node "server\dist\service\runner.js" --service
exit /b %ERRORLEVEL%
