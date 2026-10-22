<#
.SYNOPSIS
    KAS production operator commands for the Windows host (Phase D.1).

.DESCRIPTION
    The supported production topology is:

        Admin PC and CN1-CN8 browsers
              |
        Cloudflare Named Tunnel
              |
        KAS server on localhost:3001   (node server/dist/index.js)
              |
        PostgreSQL 17 on localhost:5432

    Docker is NOT required on this path. These are the Windows equivalents of
    scripts/production/*.sh.

    SECRETS: no command here ever takes a password as a parameter, prints one,
    or writes one to disk. DATABASE_URL is read from the process environment
    (or from an untracked .env next to the app). If you must set it, use an
    interactive prompt so it never enters your PowerShell history:

        $sec = Read-Host -AsSecureString 'kas_app password'
        ...
        [uri]::EscapeDataString($plain)      # percent-encodes it correctly

    POWERSHELL 5.1 NOTE: Prisma and psql write informational output to stderr.
    That is NOT a failure. Every function here checks $LASTEXITCODE, never the
    presence of stderr text, and you should do the same.

.EXAMPLE
    . .\scripts\production\windows\KasOps.ps1
    Invoke-KasMigrate
    Invoke-KasSeed
    Invoke-KasBackup -Retain 14
    Invoke-KasHealthCheck
#>

Set-StrictMode -Version Latest

$script:RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

function Get-KasRepoRoot { $script:RepoRoot }

function Assert-KasNotProduction {
    <#
        Refuses to act on the reserved production database during Phase D.1.
        Mirrors server/src/d1/guard.ts so the two cannot drift apart.
    #>
    param([Parameter(Mandatory)][string]$DatabaseUrl)

    $name = $null
    try { $name = ([uri]$DatabaseUrl).AbsolutePath.TrimStart('/') } catch { }
    if (-not $name) { throw 'DATABASE_URL khong hop le hoac thieu ten co so du lieu.' }
    if ($name.ToLower() -like '*production*') {
        throw "TU CHOI: `"$name`" la co so du lieu duoc bao luu trong Phase D.1."
    }
    return $name
}

function Get-KasDatabaseUrl {
    <# Reads DATABASE_URL from the environment. Never prints it. #>
    if ($env:DATABASE_URL) { return $env:DATABASE_URL }
    throw 'Chua dat DATABASE_URL. Dat bien moi truong roi chay lai (khong dat mat khau vao lich su lenh).'
}

function Show-KasTarget {
    <# Prints the database NAME and host only — never the URL. #>
    param([Parameter(Mandatory)][string]$DatabaseUrl)
    $u = [uri]$DatabaseUrl
    Write-Host ("Dich: {0} @ {1}:{2}" -f $u.AbsolutePath.TrimStart('/'), $u.Host, $u.Port)
}

function Invoke-KasNodeTool {
    <#
        Runs a node/npm command from the repository root and returns its exit
        code. stderr is left alone: on PowerShell 5.1 redirecting a native
        command's stderr wraps each line in an ErrorRecord and makes a
        successful command look failed.
    #>
    param(
        [Parameter(Mandatory)][string]$Command,
        [string[]]$Arguments = @()
    )
    Push-Location $script:RepoRoot
    try {
        & $Command @Arguments
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

function Invoke-KasMigrate {
    <#
    .SYNOPSIS
        Applies the committed PostgreSQL migrations. Safe to re-run.
    .DESCRIPTION
        Uses `prisma migrate deploy` — never `migrate dev`, never `db push`,
        never `migrate reset`. Those three can drop data and must never appear
        on a production host.
    #>
    $url = Get-KasDatabaseUrl
    Assert-KasNotProduction -DatabaseUrl $url | Out-Null
    Show-KasTarget -DatabaseUrl $url

    $code = Invoke-KasNodeTool -Command 'npm.cmd' -Arguments @('run', 'db:migrate')
    if ($code -ne 0) { throw "Migration that bai (exit $code)." }
    Write-Host 'OK: migration da duoc ap dung.' -ForegroundColor Green
}

function Invoke-KasSeed {
    <#
    .SYNOPSIS
        Runs the idempotent production seed (branches + aliases + room classes).
    .DESCRIPTION
        Creates CONFIGURATION only. It never creates a booking, a proof, an
        issue or a notification, and running it twice changes nothing.
    #>
    $url = Get-KasDatabaseUrl
    Assert-KasNotProduction -DatabaseUrl $url | Out-Null

    $code = Invoke-KasNodeTool -Command 'npm.cmd' -Arguments @('run', 'prod:seed')
    if ($code -ne 0) { throw "Seed that bai (exit $code)." }
    Write-Host 'OK: seed hoan tat (idempotent).' -ForegroundColor Green
}

function New-KasAdmin {
    <#
    .SYNOPSIS
        Creates the initial Admin account interactively.
    .DESCRIPTION
        The password is typed at the prompt inside the tool itself, so it never
        appears as a parameter, in this script, or in PowerShell history.
    #>
    $code = Invoke-KasNodeTool -Command 'npm.cmd' -Arguments @('run', 'prod:create-admin')
    if ($code -ne 0) { throw "Tao Admin that bai (exit $code)." }
}

function Invoke-KasBackup {
    <#
    .SYNOPSIS
        Takes a pg_dump custom-format backup plus uploads, checksum and manifest.
    .PARAMETER Retain
        Keep only the newest N backups. 0 (the default) keeps everything —
        deleting backups is never the default.
    #>
    param([int]$Retain = 0)

    $url = Get-KasDatabaseUrl
    Assert-KasNotProduction -DatabaseUrl $url | Out-Null
    Show-KasTarget -DatabaseUrl $url

    $args = @('run', 'prod:backup')
    if ($Retain -gt 0) { $args += @('--', "--retain=$Retain") }

    $code = Invoke-KasNodeTool -Command 'npm.cmd' -Arguments $args
    if ($code -ne 0) { throw "Sao luu that bai (exit $code)." }
    Write-Host 'OK: sao luu hoan tat.' -ForegroundColor Green
    Write-Host 'Nhac: sao chep thu muc sao luu sang MAY KHAC — ban sao cung may khong chong duoc hong o dia.' -ForegroundColor Yellow
}

function Invoke-KasRestore {
    <#
    .SYNOPSIS
        Restores a verified backup. Requires an interactive typed confirmation.
    .PARAMETER BackupDir
        The backup directory to restore. Never auto-selected.
    .PARAMETER TargetUrl
        Where to restore. Defaults to DATABASE_URL. Point this at a disposable
        database to REHEARSE a restore without touching live data.
    .PARAMETER ResetSchema
        Drop and recreate the schema first, giving a genuinely empty database.
    #>
    param(
        [Parameter(Mandatory)][string]$BackupDir,
        [string]$TargetUrl,
        [switch]$ResetSchema
    )

    $url = if ($TargetUrl) { $TargetUrl } else { Get-KasDatabaseUrl }
    Assert-KasNotProduction -DatabaseUrl $url | Out-Null
    Show-KasTarget -DatabaseUrl $url

    $args = @('run', 'prod:restore', '--', "--backup=$BackupDir", "--target-url=$url")
    if ($ResetSchema) { $args += '--reset-schema' }

    $code = Invoke-KasNodeTool -Command 'npm.cmd' -Arguments $args
    if ($code -ne 0) { throw "Khoi phuc that bai (exit $code)." }
}

function Invoke-KasHealthCheck {
    <#
    .SYNOPSIS
        Verifies liveness and readiness of a running KAS server.
    .DESCRIPTION
        /api/health  = process liveness + database connectivity
        /api/ready   = database, migrations, writable directories, configuration
    #>
    param([int]$Port = 3001)

    $base = "http://localhost:$Port"
    $failed = $false

    foreach ($path in @('/api/health', '/api/ready')) {
        try {
            $response = Invoke-WebRequest -Uri "$base$path" -UseBasicParsing -TimeoutSec 15
            $body = $response.Content | ConvertFrom-Json
            Write-Host ("OK  {0} -> {1}" -f $path, $response.StatusCode) -ForegroundColor Green
            if ($path -eq '/api/ready') {
                foreach ($check in $body.checks) {
                    $mark = if ($check.ok) { 'v' } else { 'x' }
                    Write-Host ("     [{0}] {1} {2}" -f $mark, $check.name, $check.detail)
                }
            }
        } catch {
            Write-Host ("FAIL {0}: {1}" -f $path, $_.Exception.Message) -ForegroundColor Red
            $failed = $true
        }
    }

    if ($failed) { throw 'Kiem tra suc khoe that bai.' }
}

function Start-KasProduction {
    <#
    .SYNOPSIS
        REMOVED. Use Kas.cmd or KasService.cmd.
    .DESCRIPTION
        This used to run `node server\dist\index.js` directly. That bypasses
        everything the production runner exists to provide: the single-instance
        lock, the health monitor and its one-restart policy, the five rotated
        log files, and the graceful shutdown that lets in-flight requests
        finish. A second way to start the server is a second set of behaviours
        to keep correct, and this one was strictly worse.

            Kas.cmd              start, open the browser, hold the window
            KasService.cmd       start in the background (no browser)
            KasService.cmd stop  stop safely
            Kas.cmd --diagnose   check the whole system
    #>
    throw @'
Start-KasProduction da bi go bo.

Dung mot trong cac lenh sau tai thu muc cai dat Kas:
  Kas.cmd                 khoi dong va mo trinh duyet
  KasService.cmd          khoi dong nen (khong mo trinh duyet)
  KasService.cmd stop     tat an toan
  Kas.cmd --diagnose      kiem tra toan bo he thong

Ly do: chay truc tiep node bo qua khoa chong trung, giam sat suc khoe,
nhat ky va tat an toan.
'@
}

Export-ModuleMember -Function * -ErrorAction SilentlyContinue
