@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  Start-Dev - khoi dong moi truong PHAT TRIEN (development)
rem
rem  Chay backend :3002 va frontend :5173 cung luc, chi tren localhost.
rem  Mo trinh duyet tai http://localhost:5173
rem
rem  KHONG PHAI PRODUCTION. Production la C:\Kas, cong 3001, do Kas.cmd khoi
rem  dong. Hai moi truong chay song song duoc va khong dung chung cong hay
rem  du lieu.
rem
rem  Dong cua so nay de tat moi truong phat trien.
rem
rem  WHY THE GUARDS BELOW EXIST
rem
rem  A development frontend proxies /api to whatever port it is told. Pointed at
rem  3001 while the production service is listening, it serves a local-looking
rem  UI backed by LIVE data - and the dev backend does not even have to be
rem  running for that to happen. Nothing on screen would look wrong. So this
rem  script refuses to start rather than let a misconfigured .env reach the
rem  production port or the production database.
rem
rem  ASCII-only: cmd.exe mac dinh dung code page 437 va se hien thi sai neu tep
rem  nay chua dau tieng Viet.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   KHONG TIM THAY NODE.JS
  echo.
  echo   Cai dat ban LTS tai https://nodejs.org roi chay lai tep nay.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo.
  echo   CHUA CO TEP .env
  echo.
  echo   Chay:  copy .env.example .env
  echo   roi dat SESSION_SECRET va INITIAL_ADMIN_*.
  echo.
  pause
  exit /b 1
)

rem --- Guard 1: never bind the production port -------------------------------
findstr /B /C:"PORT=3001" .env >nul 2>&1
if not errorlevel 1 (
  echo.
  echo   DUNG LAI - .env DANG DAT PORT=3001
  echo.
  echo   3001 la cong PRODUCTION. Moi truong phat trien phai dung 3002.
  echo   Sua .env:  PORT=3002
  echo.
  pause
  exit /b 1
)

rem --- Guard 2: never point development at a production database -------------
rem
rem  THIS GUARD USED TO REQUIRE kas_dev_cn1, AND THAT WAS THE BUG. kas_dev_cn1
rem  was designated the development database, then turned out to be the LIVE
rem  database serving kasbookingapp.com - so the guard that was supposed to
rem  protect production was the thing pinning development to it. A dev backend
rem  on 3002 was reading and writing real guest data, and nothing looked wrong.
rem
rem  It is now a DENY-LIST, not an allow-list. Development gets its own
rem  disposable database (kas_dev) and this script refuses to start if .env
rem  names any database known to hold live data. Naming one database that is
rem  permitted would repeat the original mistake the day that name changes
rem  meaning; naming the ones that are forbidden does not.
rem
rem  kas_d1_test is production despite its name. kas_production is reserved.
rem  Anything containing "production" is refused on sight.

for %%D in (kas_dev_cn1 kas_d1_test kas_production) do (
  findstr /C:"/%%D" .env >nul 2>&1
  if not errorlevel 1 (
    echo.
    echo   DUNG LAI - DATABASE_URL TRO TOI CO SO DU LIEU PRODUCTION: %%D
    echo.
    echo   Moi truong phat trien KHONG duoc dung co so du lieu nay.
    echo   Dat DATABASE_URL trong .env tro toi:  kas_dev
    echo.
    pause
    exit /b 1
  )
)

rem  Belt and braces: refuse any database name containing "production", so a
rem  new name nobody thought to add above is still caught.
findstr /R /C:"DATABASE_URL=.*production" .env >nul 2>&1
if not errorlevel 1 (
  echo.
  echo   DUNG LAI - DATABASE_URL CO CHUA "production"
  echo.
  echo   Moi truong phat trien phai dung co so du lieu rieng:  kas_dev
  echo.
  pause
  exit /b 1
)

rem  And require the dedicated development database explicitly, so a .env that
rem  points somewhere unexpected fails loudly instead of silently working.
findstr /C:"/kas_dev?" .env >nul 2>&1
if errorlevel 1 (
  findstr /R /C:"/kas_dev$" .env >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   DUNG LAI - DATABASE_URL KHONG TRO TOI kas_dev
    echo.
    echo   Moi truong phat trien dung co so du lieu rieng:  kas_dev
    echo   Vi du:  DATABASE_URL=postgresql://kas_app:MAT_KHAU@127.0.0.1:5432/kas_dev?schema=public
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   Moi truong PHAT TRIEN
echo   ---------------------
echo   Backend   http://localhost:3002
echo   Frontend  http://localhost:5173     ^<-- mo trang nay
echo   Database  kas_dev
echo.
echo   Production (C:\Kas, cong 3001) khong bi anh huong.
echo   Dong cua so nay de tat.
echo.

call npm run dev
exit /b %ERRORLEVEL%
