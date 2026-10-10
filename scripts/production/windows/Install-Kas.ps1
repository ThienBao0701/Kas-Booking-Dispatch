<#
.SYNOPSIS
    Installs Kas onto a Windows machine.

.DESCRIPTION
    Copies the release payload to the install directory, creates Desktop and
    Start Menu shortcuts, registers the application in Windows "Apps &
    features", and launches Kas on first install.

    THE GUARANTEE: an upgrade never touches operator data. Configuration
    (.env), uploaded proof images and logs are left exactly where they are. The
    PostgreSQL database is outside the install directory and is never reached
    by anything here — no migration is run, no data is deleted.

    All decisions (fresh / upgrade / repair, what to preserve) come from
    server/dist/installer/plan.js, which is unit tested. This script carries
    them out.

.EXAMPLE
    .\Install-Kas.ps1
    .\Install-Kas.ps1 -InstallDir 'D:\Kas' -NoLaunch
#>
[CmdletBinding()]
param(
    [String]$InstallDir = 'C:\Kas',
    [switch]$NoLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The release root is the parent of installer\, so the script works from
# wherever the operator extracted the archive.
# The payload root is FOUND, not assumed to sit a fixed number of levels up.
#
# This script runs from two different depths and the old `Split-Path -Parent`
# was only right for one of them:
#
#   packaged release   <release>\installer\Install-Kas.ps1    -> one level up
#   repository         scripts\production\windows\Install-...  -> three levels up
#
# From the repository it therefore looked for the plan module under
# scripts\production\server\dist\..., which does not exist, and the install
# died before doing anything. Walking up until the payload is actually there
# handles both layouts and any future move of this file, without naming a path.
function Resolve-KasReleaseRoot {
    param([Parameter(Mandatory)][string]$StartDirectory)

    # The plan module is the marker because it is the first thing the installer
    # needs and it exists in both layouts.
    $marker = 'server\dist\installer\plan.js'
    $directory = $StartDirectory
    while ($directory) {
        if (Test-Path (Join-Path $directory $marker)) { return $directory }
        $parent = Split-Path -Parent $directory
        if (-not $parent -or $parent -eq $directory) { break }
        $directory = $parent
    }
    return $null
}

$ReleaseRoot = Resolve-KasReleaseRoot -StartDirectory $PSScriptRoot
if (-not $ReleaseRoot) {
    throw @"
Khong tim thay noi dung cai dat.

Da tim nguoc len tu: $PSScriptRoot
Can tim thay: server\dist\installer\plan.js

Neu ban chay tu ban phat hanh: hay giai nen TOAN BO thu muc roi chay lai.
Neu ban chay tu ma nguon: chay 'npm run build' truoc.
"@
}
$LogDir = Join-Path $InstallDir 'logs'
$LogFile = Join-Path $LogDir 'installer.log'

function Write-Log {
    param([string]$Message, [string]$Colour = 'Gray')
    Write-Host $Message -ForegroundColor $Colour
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
        Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date).ToString('o'), $Message) -Encoding utf8
    } catch {
        # A log that cannot be written must not stop an install.
    }
}

Write-Host ''
Write-Host '===============================================' -ForegroundColor Cyan
Write-Host '  Kas - Trinh cai dat' -ForegroundColor Cyan
Write-Host '===============================================' -ForegroundColor Cyan
Write-Host ''

# --- Gather the environment the decision needs ------------------------------
$nodeMajor = $null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $raw = (& node --version) 2>$null
    if ($raw -match 'v(\d+)') { $nodeMajor = [int]$Matches[1] }
}

$incomingVersion = 'unknown'
$releaseFile = Join-Path $ReleaseRoot 'kas-release.json'
if (Test-Path $releaseFile) {
    $incomingVersion = (Get-Content $releaseFile -Raw | ConvertFrom-Json).version
}

$existingVersion = $null
$installedRelease = Join-Path $InstallDir 'kas-release.json'
if (Test-Path $installedRelease) {
    $existingVersion = (Get-Content $installedRelease -Raw | ConvertFrom-Json).version
}

# --- Is the target an existing Kas install? ---------------------------------
#
# NOT just "kas-release.json exists". That file only appeared in Phase 6.3, so
# an installation predating it was classified as a FOREIGN folder and refused —
# the one directory that must never be treated as a stranger is the one holding
# the hotel's data. The markers are gathered here and judged by
# isKasInstallation() in the plan module, so the rule is tested in one place.
$installedPackageName = $null
$installedPackage = Join-Path $InstallDir 'package.json'
if (Test-Path $installedPackage) {
    try { $installedPackageName = (Get-Content $installedPackage -Raw | ConvertFrom-Json).name } catch { }
}

$markers = @{
    releaseMetadata = [bool](Test-Path $installedRelease)
    packageName     = $installedPackageName
    serverBuild     = [bool](Test-Path (Join-Path $InstallDir 'server\dist\index.js'))
    clientBuild     = [bool](Test-Path (Join-Path $InstallDir 'client\dist\index.html'))
    prismaSchema    = [bool](Test-Path (Join-Path $InstallDir 'prisma\schema.prisma'))
    launcher        = [bool](Test-Path (Join-Path $InstallDir 'Kas.cmd'))
    operatorData    = [bool]((Test-Path (Join-Path $InstallDir '.env')) -or
                             (Test-Path (Join-Path $InstallDir 'server\uploads')))
}

# `existingInstall` and `targetOccupiedByOther` are decided from the markers by
# the plan module, below — the decision script computes both before classifying.
$existingInstall = $false
$targetDirectoryHasContents = $false
if (Test-Path $InstallDir) {
    $targetDirectoryHasContents = (Get-ChildItem $InstallDir -Force | Measure-Object).Count -gt 0
}
$targetOccupiedByOther = $false

$targetWritable = $false
try {
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    $probe = Join-Path $InstallDir '.write-probe'
    Set-Content -Path $probe -Value 'x' -Encoding ascii
    Remove-Item $probe -Force
    $targetWritable = $true
} catch {
    $targetWritable = $false
}

$payloadComplete = $true
# Must stay in step with RELEASE_PAYLOAD (server/src/installer/plan.ts) and with
# Package-Kas.ps1. Three lists of the same thing is two too many, but the two
# PowerShell ones cannot import the TypeScript one; a test asserts the packager
# matches, and this list is what refuses an incomplete release.
foreach ($item in 'server\dist', 'client\dist', 'prisma', 'node_modules', 'package.json',
                  'Kas.cmd', 'KasService.cmd', 'KasBackup.cmd',
                  'Enable-KasAutostart.cmd', 'Enable-KasAutostart.ps1') {
    if (-not (Test-Path (Join-Path $ReleaseRoot $item))) { $payloadComplete = $false }
}

# --- Ask the tested plan what to do -----------------------------------------
$planModule = Join-Path $ReleaseRoot 'server\dist\installer\plan.js'
if (-not (Test-Path $planModule)) { throw "Goi cai dat hong: khong tim thay $planModule" }

# --- Machine prerequisites (Phase 6.4) --------------------------------------
# Measured here, judged in plan.ts. An unreadable value is passed as $null and
# the plan treats that as "do not refuse" — the checks exist to stop an install
# onto Windows 7 or a full disk, not to stop one on a machine whose version
# string could not be parsed.
$windowsMajor = $null
try { $windowsMajor = [Environment]::OSVersion.Version.Major } catch { }

$freeDiskBytes = $null
try {
    $targetRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($InstallDir))
    $drive = Get-PSDrive -Name $targetRoot.Substring(0, 1) -ErrorAction Stop
    $freeDiskBytes = [int64]$drive.Free
} catch { }

# The port Kas will use, read from an existing .env when there is one.
$installPort = 3001
$existingEnvFile = Join-Path $InstallDir '.env'
if (Test-Path $existingEnvFile) {
    $portLine = Select-String -Path $existingEnvFile -Pattern '^\s*PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($portLine) { $installPort = [int]$portLine.Matches[0].Groups[1].Value }
}
$portInUse = $false
try {
    $portInUse = [bool](Get-NetTCPConnection -LocalPort $installPort -State Listen -ErrorAction SilentlyContinue)
} catch { }

$environmentJson = @{
    nodeMajor             = $nodeMajor
    targetDir             = $InstallDir
    targetWritable        = $targetWritable
    existingInstall       = $existingInstall
    existingVersion       = $existingVersion
    incomingVersion       = $incomingVersion
    payloadComplete       = $payloadComplete
    targetOccupiedByOther = $targetOccupiedByOther
    windowsMajor          = $windowsMajor
    freeDiskBytes         = $freeDiskBytes
    portInUse             = $portInUse
    port                  = $installPort
    markers               = $markers
    targetHasContents     = $targetDirectoryHasContents
} | ConvertTo-Json -Compress

# node reads the environment and prints the decision as JSON, so the PowerShell
# here never re-implements a rule that is tested in TypeScript.
#
# Both values travel through FILES rather than arguments: Windows argument
# parsing mangles the embedded quotes of a JSON string handed to a native
# executable, which fails in a way that looks like a syntax error in the script.
$environmentFile = Join-Path ([System.IO.Path]::GetTempPath()) ("kas-install-env-{0}.json" -f [guid]::NewGuid())
$decisionScriptFile = [System.IO.Path]::ChangeExtension($environmentFile, 'js')

# Written WITHOUT a byte-order mark. PowerShell 5.1's Set-Content -Encoding utf8
# emits a BOM, and JSON.parse rejects it outright — the failure surfaces as an
# unrelated-looking syntax error.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

$decisionScript = @'
const fs = require('fs');
const plan = require(process.argv[2]);
// Strips a BOM if one ever reaches this file from elsewhere.
const env = JSON.parse(fs.readFileSync(process.argv[3], 'utf8').replace(/^﻿/, ''));

// Recognition BEFORE classification, both from the tested module. A legacy
// install has no kas-release.json but is unmistakably Kas by its structure;
// calling it a foreign folder refused to upgrade the one directory that holds
// the hotel's data. A directory that is neither Kas nor empty is still refused.
const isKas = plan.isKasInstallation(env.markers);
env.existingInstall = isKas;
env.targetOccupiedByOther = !isKas && env.targetHasContents === true;

const action = plan.decideInstall(env);
console.log(
  JSON.stringify({
    action,
    lines: plan.describeInstall(action, env),
    recognisedAsKas: isKas,
    legacy: isKas && env.markers.releaseMetadata !== true,
  }),
);
'@

[System.IO.File]::WriteAllText($environmentFile, $environmentJson, $utf8NoBom)
[System.IO.File]::WriteAllText($decisionScriptFile, $decisionScript, $utf8NoBom)

try {
    $decisionRaw = & node $decisionScriptFile $planModule $environmentFile
    if ($LASTEXITCODE -ne 0) { throw 'Khong doc duoc ke hoach cai dat.' }
    $decision = $decisionRaw | ConvertFrom-Json
} finally {
    Remove-Item $environmentFile, $decisionScriptFile -Force -ErrorAction SilentlyContinue
}

foreach ($line in $decision.lines) { Write-Log "  $line" }
if ($decision.legacy) {
    Write-Log '  Ghi chu       : ban cai dat cu (truoc khi co kas-release.json) - nhan dien qua cau truc thu muc' 'Yellow'
}
Write-Host ''

if ($decision.action.kind -eq 'ABORT') {
    Write-Log 'Cai dat da dung lai. Khong co tep nao bi thay doi.' 'Red'
    exit 1
}

# --- Copy the payload -------------------------------------------------------
Write-Log "Dang cai dat ($($decision.action.kind))..." 'Cyan'

# Replaced wholesale; anything in OPERATOR_DATA is simply never named here, so
# it cannot be removed by accident.
foreach ($item in 'server\dist', 'client\dist', 'prisma', 'node_modules') {
    $destination = Join-Path $InstallDir $item
    if (Test-Path $destination) { Remove-Item $destination -Recurse -Force }
    $parent = Split-Path $destination -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item (Join-Path $ReleaseRoot $item) $destination -Recurse -Force
    Write-Log "  cap nhat $item"
}
# KasService.cmd and KasBackup.cmd are what the two Scheduled Tasks point at.
# They were absent here, so an elevated install registered tasks referencing
# files that had never been copied — no boot start and no nightly backup, with
# nothing failing until the machine was next restarted.
foreach ($item in 'package.json', 'Kas.cmd', 'KasService.cmd', 'KasBackup.cmd',
                  'Enable-KasAutostart.cmd', 'Enable-KasAutostart.ps1',
                  'kas-release.json', 'server\package.json') {
    $source = Join-Path $ReleaseRoot $item
    if (Test-Path $source) { Copy-Item $source (Join-Path $InstallDir $item) -Force }
}
if (Test-Path (Join-Path $ReleaseRoot 'runtime')) {
    $runtimeDestination = Join-Path $InstallDir 'runtime'
    if (Test-Path $runtimeDestination) { Remove-Item $runtimeDestination -Recurse -Force }
    Copy-Item (Join-Path $ReleaseRoot 'runtime') $runtimeDestination -Recurse -Force
    Write-Log '  cap nhat runtime (Node portable)'
}

# --- Configuration ----------------------------------------------------------
# Seeded ONLY when absent. An existing .env holds the database password and the
# operator's own settings; overwriting it would break a working install.
$envPath = Join-Path $InstallDir '.env'
if (Test-Path $envPath) {
    Write-Log '  giu nguyen .env hien co (khong ghi de)'
} else {
    Copy-Item (Join-Path $ReleaseRoot '.env.example') $envPath -Force

    # The template declares NODE_ENV=production, and production REFUSES to
    # start unless the upload and backup paths are absolute. Only the installer
    # knows where this machine put them, so it writes them here — otherwise a
    # fresh install would abort on first run with a wall of validation errors,
    # and the natural fix an operator reaches for is to set NODE_ENV back to
    # development, which is exactly the fault this release is repairing.
    #
    # Appended rather than templated so the file keeps its comments, and the
    # values are machine-specific rather than shipped.
    $resolved = @(
        '',
        '# --- Written by the installer for THIS machine ------------------------------',
        '# Production requires absolute paths; these point inside the install folder,',
        '# which is where the upgrade and uninstall logic already protects them.',
        ('PROOF_UPLOAD_DIR={0}' -f (Join-Path $InstallDir 'server\uploads\booking-proofs')),
        ('ISSUE_UPLOAD_DIR={0}' -f (Join-Path $InstallDir 'server\uploads\issue-photos')),
        ('BACKUP_DIR={0}' -f (Join-Path $InstallDir 'backups')),
        ''
    )
    Add-Content -LiteralPath $envPath -Value $resolved -Encoding utf8

    Write-Log '  da tao .env tu mau - CAN CHINH SUA truoc khi chay' 'Yellow'
    Write-Log '    bat buoc: DATABASE_URL, SESSION_SECRET, INITIAL_ADMIN_*, APP_ORIGIN' 'Yellow'
}

# --- Folders ----------------------------------------------------------------
#
# The application creates each of these the first time it needs one, so this is
# not about correctness. It is so the operator can SEE where their proof images
# and backups will live before anything has happened, and so a permission
# problem surfaces on the day of the install rather than on the day of the
# first upload. The list comes from the plan module, which the tests pin.
foreach ($folder in 'logs', 'backups', 'server\uploads\booking-proofs', 'server\uploads\issue-photos') {
    $full = Join-Path $InstallDir $folder
    if (-not (Test-Path $full)) {
        New-Item -ItemType Directory -Path $full -Force | Out-Null
        Write-Log "  da tao $folder"
    }
}

# --- Shortcuts --------------------------------------------------------------
$iconPath = Join-Path $InstallDir 'client\dist\favicon.ico'
$targetCmd = Join-Path $InstallDir 'Kas.cmd'

function New-KasShortcut {
    param([string]$Path)
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $targetCmd
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.Description = 'Kas - Trung tam dieu phoi dat phong'
    if (Test-Path $iconPath) { $shortcut.IconLocation = $iconPath }
    $shortcut.Save()
}

$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kas.lnk'
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Kas'
if (-not (Test-Path $startMenuDir)) { New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null }
$startLink = Join-Path $startMenuDir 'Kas.lnk'

New-KasShortcut -Path $desktopLink
New-KasShortcut -Path $startLink
Write-Log '  da tao loi tat Desktop va Start Menu'

# --- Start with Windows -----------------------------------------------------
#
# An at-startup Scheduled Task, not a Windows Service. A service must speak the
# Service Control Protocol; node.exe does not, so `sc create` would register a
# service that fails at start with error 1053. Making Kas a real service needs a
# third-party wrapper binary shipped unsigned to the hotel. This needs nothing
# that is not already in Windows and does the same job.
#
# Registration needs Administrator (it runs as SYSTEM). A per-user install
# without elevation is still fully usable - the desktop shortcut starts Kas -
# so a failure here is reported and the install continues.
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Log '  bo qua tu dong khoi dong cung Windows (can quyen Administrator)' 'Yellow'
    Write-Log '    de bat sau: mo PowerShell (Administrator) va chay lai trinh cai dat' 'Yellow'
} else {
    try {
        # ONE implementation of the registration, called from both places that
        # need it. It used to be written out twice - here and in
        # Enable-KasAutostart.ps1 - and both copies carried the same wrong
        # `schtasks /Change /ET` line, which is the shape this class of bug
        # always takes. The rejected-XML story is documented in that script.
        #
        # Nightly backup is registered in the same call. It is a separate task
        # from the runner on purpose: a backup that fails must never be able to
        # stop the application, and a restart of the application must never skip
        # a backup.
        $autostart = Join-Path $PSScriptRoot 'Enable-KasAutostart.ps1'
        if (-not (Test-Path $autostart)) { throw "khong tim thay $autostart" }

        & $autostart -InstallDir $InstallDir
        if ($LASTEXITCODE -ne 0) { throw "Enable-KasAutostart tra ve ma $LASTEXITCODE" }

        Write-Log '  da dang ky khoi dong cung Windows (Scheduled Task "Kas")'
        Write-Log '    tat an toan:  KasService.cmd stop'
        Write-Log '  da dang ky sao luu hang ngay 22:00 (Scheduled Task "Kas Backup")'
        Write-Log '    sao luu ngay:  KasBackup.cmd'
    } catch {
        Write-Log "  KHONG dang ky duoc tu dong khoi dong: $($_.Exception.Message)" 'Yellow'
        Write-Log '    Kas van chay binh thuong khi bam loi tat tren Desktop.' 'Yellow'
    }
}

# --- Apps & features --------------------------------------------------------
# HKCU so no Administrator rights are needed for a per-user install.
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KasBookingDispatch'
New-Item -Path $uninstallKey -Force | Out-Null
$uninstallCommand = 'powershell.exe -ExecutionPolicy Bypass -File "{0}\installer\Uninstall-Kas.ps1"' -f $InstallDir
Set-ItemProperty -Path $uninstallKey -Name 'DisplayName' -Value 'Kas Booking Dispatch'
Set-ItemProperty -Path $uninstallKey -Name 'DisplayVersion' -Value $incomingVersion
Set-ItemProperty -Path $uninstallKey -Name 'Publisher' -Value 'Kas'
Set-ItemProperty -Path $uninstallKey -Name 'InstallLocation' -Value $InstallDir
Set-ItemProperty -Path $uninstallKey -Name 'UninstallString' -Value $uninstallCommand
Set-ItemProperty -Path $uninstallKey -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name 'NoRepair' -Value 1 -Type DWord
if (Test-Path $iconPath) { Set-ItemProperty -Path $uninstallKey -Name 'DisplayIcon' -Value $iconPath }
Write-Log '  da dang ky trong Apps & features'

# The uninstaller travels with the install so it survives the release folder.
$installedInstallerDir = Join-Path $InstallDir 'installer'
if (-not (Test-Path $installedInstallerDir)) { New-Item -ItemType Directory -Path $installedInstallerDir -Force | Out-Null }
Copy-Item (Join-Path $PSScriptRoot 'Uninstall-Kas.ps1') (Join-Path $installedInstallerDir 'Uninstall-Kas.ps1') -Force

Write-Host ''
Write-Log "Cai dat hoan tat: $InstallDir" 'Green'

# --- Verify what was just installed -----------------------------------------
#
# The installer's own log says what it COPIED. That is not the same as saying
# the result works, and the gap between those two is where an operator is left
# with a green "installation complete" and an application that will not start.
# So the deployment validator built in 6.3c is run here, against the machine as
# it now stands.
#
# Its verdict never fails the install: at this point the files ARE installed,
# and the usual reason for a warning on a fresh machine is the .env that the
# operator has not filled in yet, which is the very next instruction below.
$diagnoseCmd = Join-Path $InstallDir 'Kas.cmd'
if (Test-Path $diagnoseCmd) {
    Write-Host ''
    Write-Log 'Dang kiem tra ban cai dat...' 'Cyan'
    & cmd.exe /c "`"$diagnoseCmd`" --diagnose"
    $diagnoseExit = $LASTEXITCODE
    switch ($diagnoseExit) {
        0 { Write-Log 'Kiem tra: DAT. He thong san sang.' 'Green' }
        1 { Write-Log 'Kiem tra: co CANH BAO o tren - doc va xu ly khi can.' 'Yellow' }
        default {
            Write-Log 'Kiem tra: co LOI NGHIEM TRONG o tren.' 'Red'
            Write-Log 'Kas da duoc cai nhung chua chay dung. Xu ly cac muc [FAIL] roi chay lai:' 'Red'
            Write-Log '    Kas.cmd --diagnose' 'Red'
        }
    }
}

# --- First run --------------------------------------------------------------
$freshEnv = -not (Test-Path $envPath) -or $decision.action.kind -eq 'FRESH'
if ($NoLaunch) {
    Write-Log 'Bo qua khoi dong (-NoLaunch).'
} elseif ($freshEnv -and -not $existingInstall) {
    Write-Host ''
    Write-Log 'BUOC TIEP THEO: mo .env trong thu muc cai dat va dien DATABASE_URL,' 'Yellow'
    Write-Log 'sau do nhan dup bieu tuong Kas tren Desktop.' 'Yellow'
} else {
    Write-Log 'Dang khoi dong Kas...' 'Cyan'
    Start-Process -FilePath $targetCmd -WorkingDirectory $InstallDir
}

Write-Host ''
Write-Log "Nhat ky: $LogFile"
exit 0
