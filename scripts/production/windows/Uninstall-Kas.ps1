<#
.SYNOPSIS
    Removes Kas from a Windows machine.

.DESCRIPTION
    Removes the application files, the shortcuts and the Apps & features entry.

    OPERATOR DATA IS KEPT BY DEFAULT. Configuration (.env), uploaded proof
    images, issue photos and logs stay where they are. Those are the hotel's
    records — an uninstall that deleted the proof a branch created a
    reservation correctly would destroy the only evidence of it.

    -PurgeData removes them too, and says exactly what it will delete first.

    THE DATABASE IS NEVER TOUCHED, with or without -PurgeData. It lives in
    PostgreSQL outside this directory; removing it is a deliberate database
    operation, not a side effect of uninstalling an application.

.EXAMPLE
    .\Uninstall-Kas.ps1
    .\Uninstall-Kas.ps1 -PurgeData
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
    [switch]$PurgeData,
    # SEPARATE from -PurgeData on purpose. Configuration and proof images can be
    # recovered from a backup; the backups are what remain when nothing else
    # does. Removing them is the one action here with no way back, so it takes
    # its own flag rather than riding along with one that sounded milder.
    [switch]$PurgeBackups,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '===============================================' -ForegroundColor Cyan
Write-Host '  Kas - Go cai dat' -ForegroundColor Cyan
Write-Host '===============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "Thu muc: $InstallDir"

if (-not (Test-Path (Join-Path $InstallDir 'kas-release.json'))) {
    Write-Host 'Khong tim thay ban cai Kas o thu muc nay. Dung lai.' -ForegroundColor Red
    exit 1
}

# Application files only. Everything absent from this list survives, which is
# how operator data is protected — by never being named.
# Must stay in step with RELEASE_PAYLOAD (server/src/installer/plan.ts).
# 'runtime' was removed from the product and lingered here; KasService.cmd and
# KasBackup.cmd were added and never arrived — so an uninstall left the two
# background entry points behind while claiming to have removed the application.
$applicationItems = @('server\dist', 'client\dist', 'prisma', 'node_modules',
                      'package.json', 'server\package.json', 'Kas.cmd',
                      'KasService.cmd', 'KasBackup.cmd', 'kas-release.json')
$operatorItems = @('.env', 'server\uploads', 'logs')
# Held apart from $operatorItems: see -PurgeBackups above, and BACKUP_DATA in
# server/src/installer/plan.ts, which is the list the tests pin.
$backupItems = @('backups')

Write-Host ''
Write-Host 'Se xoa:' -ForegroundColor Yellow
foreach ($item in $applicationItems) { Write-Host "  - $item" }
if ($PurgeData) {
    Write-Host ''
    Write-Host 'VA XOA CA DU LIEU (-PurgeData):' -ForegroundColor Red
    foreach ($item in $operatorItems) { Write-Host "  - $item" -ForegroundColor Red }
} else {
    Write-Host ''
    Write-Host 'Giu lai (du lieu cua ban):' -ForegroundColor Green
    foreach ($item in $operatorItems) { Write-Host "  - $item" -ForegroundColor Green }
}

if ($PurgeBackups) {
    Write-Host ''
    Write-Host 'VA XOA CA CAC BAN SAO LUU (-PurgeBackups):' -ForegroundColor Red
    foreach ($item in $backupItems) { Write-Host "  - $item" -ForegroundColor Red }
    Write-Host '  KHONG THE HOAN TAC. Day la ban sao cuoi cung cua du lieu khach san.' -ForegroundColor Red
} else {
    Write-Host ''
    Write-Host 'Giu lai (cac ban sao luu):' -ForegroundColor Green
    foreach ($item in $backupItems) { Write-Host "  - $item" -ForegroundColor Green }
}

Write-Host ''
Write-Host 'Co so du lieu PostgreSQL KHONG bi dong den.' -ForegroundColor Green
Write-Host ''

if (-not $Force) {
    $answer = Read-Host 'Tiep tuc go cai dat? (y/N)'
    if ($answer -ne 'y' -and $answer -ne 'Y') {
        Write-Host 'Da huy. Khong co tep nao bi xoa.' -ForegroundColor Yellow
        exit 0
    }
}

# --- Stop and unregister the background runner ------------------------------
#
# BEFORE deleting any file. A running server holding server\dist open would make
# the removal fail halfway and leave a half-uninstalled directory; and the stop
# is graceful, so a receptionist mid-upload is not cut off by an uninstall.
$serviceCmd = Join-Path $InstallDir 'KasService.cmd'
if (Test-Path $serviceCmd) {
    Write-Host 'Dang dung Kas neu no khoi chay...'
    & cmd.exe /c "`"$serviceCmd`" stop"
    Start-Sleep -Seconds 2
}

# NO `2>$null` ON A NATIVE COMMAND. On PowerShell 5.1 redirecting a native
# program's stderr wraps each line in an ErrorRecord (NativeCommandError), which
# aborted this uninstall before it deleted anything the first time it was run
# against a machine with no tasks registered. schtasks writes to stderr for the
# ordinary "task not found" case, so that path is hit every time. The exit code
# is the answer; stderr is left alone, exactly as KasOps.ps1 documents.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
foreach ($taskName in @('Kas', 'Kas Backup')) {
    schtasks.exe /Query /TN $taskName | Out-Null
    if ($LASTEXITCODE -eq 0) {
        schtasks.exe /Delete /TN $taskName /F | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Host "  da go Scheduled Task `"$taskName`"" }
        else { Write-Host "  KHONG go duoc Scheduled Task `"$taskName`" (can quyen Administrator)" -ForegroundColor Yellow }
    }
}
$ErrorActionPreference = $previousPreference

$targets = $applicationItems
if ($PurgeData) { $targets += $operatorItems }
if ($PurgeBackups) { $targets += $backupItems }
foreach ($item in $targets) {
    $path = Join-Path $InstallDir $item
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  da xoa $item"
    }
}

# Shortcuts
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kas.lnk'
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Kas'
foreach ($link in @($desktopLink, $startMenuDir)) {
    if (Test-Path $link) {
        Remove-Item $link -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  da xoa loi tat $(Split-Path $link -Leaf)"
    }
}

# Apps & features
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KasBookingDispatch'
if (Test-Path $uninstallKey) {
    Remove-Item $uninstallKey -Recurse -Force
    Write-Host '  da go khoi Apps & features'
}

Write-Host ''
if ($PurgeData) {
    Write-Host 'Da go cai dat hoan toan.' -ForegroundColor Green
} else {
    Write-Host 'Da go cai dat. Du lieu cua ban van con tai:' -ForegroundColor Green
    Write-Host "  $InstallDir" -ForegroundColor Green
}
exit 0
