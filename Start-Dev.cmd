@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  Start-Dev - khoi dong moi truong PHAT TRIEN (development)
rem
rem  Chay backend :3002 va frontend :5173 cung luc, chi tren localhost.
rem  Mo trinh duyet tai http://127.0.0.1:5173
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
rem  The DENY-LIST below comes first and never depends on the allow check
rem  after it: this script refuses to start if .env names any database known
rem  to hold live data, whatever else the file says. Development has its own
rem  database (kas_dev_transfer, role kas_dev_app); the older kas_dev on this
rem  machine is not it and must be left alone.
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
    echo   Dat DATABASE_URL trong .env tro toi:  kas_dev_transfer
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
  echo   Moi truong phat trien phai dung co so du lieu rieng:  kas_dev_transfer
  echo.
  pause
  exit /b 1
)

rem --- Guard 3: require the dedicated development database exactly -----------
rem
rem  The backend loads .env with dotenv, which NEVER overrides a variable that
rem  is already in the process environment. An inherited DATABASE_URL or PORT
rem  would therefore win over .env, and every check above and below would be
rem  validating a value the backend does not use. Refuse rather than guess.
if defined DATABASE_URL (
  echo.
  echo   DUNG LAI - BIEN MOI TRUONG DATABASE_URL DA DUOC DAT SAN
  echo.
  echo   Gia tri nay se ghi de .env va khong the kiem tra duoc.
  echo   Xoa bien DATABASE_URL khoi moi truong roi chay lai.
  echo.
  pause
  exit /b 1
)
if "%PORT%"=="3001" (
  echo.
  echo   DUNG LAI - BIEN MOI TRUONG PORT=3001
  echo.
  echo   3001 la cong PRODUCTION. Xoa bien PORT khoi moi truong roi chay lai.
  echo.
  pause
  exit /b 1
)

rem  Exactly one DATABASE_URL line. dotenv keeps the LAST one it reads, so a
rem  second line could silently replace the one validated below. Indented and
rem  "export"-prefixed forms are counted too, because dotenv accepts them.
set "KAS_DBURL_LINES=0"
for /f %%N in ('findstr /R /C:"^ *DATABASE_URL" /C:"^ *export  *DATABASE_URL" .env ^| find /c /v ""') do set "KAS_DBURL_LINES=%%N"
if not "%KAS_DBURL_LINES%"=="1" (
  echo.
  echo   DUNG LAI - .env PHAI CO DUNG MOT DONG DATABASE_URL
  echo.
  echo   Tim thay: %KAS_DBURL_LINES% dong.
  echo   Moi truong phat trien dung co so du lieu rieng:  kas_dev_transfer
  echo.
  pause
  exit /b 1
)

rem  And that line must name kas_dev_transfer as the database itself - the URL
rem  path right after host[:port] - optionally quoted, optionally followed by
rem  ?query parameters, and nothing else. [^/]* keeps the match inside the
rem  authority, so the name cannot be satisfied from inside a query string.
rem  Anything this cannot recognise is refused: kas_dev, kas_dev_transfer2 and
rem  a missing or malformed DATABASE_URL all stop here.
rem
rem  The patterns are deliberately NOT wrapped in "...": a \" inside quotes
rem  flips cmd's own quote state, which eats the caret in [^/] and turns the
rem  output redirection into a findstr argument. Unquoted, a doubled caret is
rem  one literal caret and a caret before a quote passes the quote through.
rem  findstr's $ only matches before CRLF, so an LF-only .env with an
rem  unquoted, parameterless URL is refused - add ?schema=public to it.
findstr /R /C:^^DATABASE_URL=\^"*postgres[a-z]*://[^^/]*/kas_dev_transfer? /C:^^DATABASE_URL=\^"*postgres[a-z]*://[^^/]*/kas_dev_transfer\^"*$ .env >nul 2>&1
if errorlevel 1 (
  echo.
  echo   DUNG LAI - DATABASE_URL KHONG TRO TOI kas_dev_transfer
  echo.
  echo   Moi truong phat trien dung co so du lieu rieng:  kas_dev_transfer
  echo   Vi du:  DATABASE_URL=postgresql://kas_dev_app:MAT_KHAU@127.0.0.1:5432/kas_dev_transfer?schema=public
  echo.
  pause
  exit /b 1
)

echo.
echo   Moi truong PHAT TRIEN
echo   ---------------------
echo   Backend   http://localhost:3002
echo   Frontend  http://127.0.0.1:5173     ^<-- mo trang nay
echo   Database  kas_dev_transfer
echo.
echo   Production (C:\Kas, cong 3001) khong bi anh huong.
echo   Dong cua so nay de tat.
echo.

call npm run dev
exit /b %ERRORLEVEL%
