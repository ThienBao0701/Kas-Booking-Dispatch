<#
.SYNOPSIS
    Builds a self-contained Kas release folder for single-machine deployment.

.DESCRIPTION
    Produces release/Kas-<version>/ containing everything a target machine
    needs: the built server and SPA, the Prisma schema and migrations,
    production-only node_modules (including the native Prisma engines), the
    Phase 6.2 launcher, and the installer.

    WHAT IS NOT IN THE PAYLOAD, deliberately:
      .env                 configuration is per-machine and holds the database
                           password; it is never packaged, never copied and
                           never overwritten. The installer seeds a template
                           only when none exists.
      server/uploads       guest documents belong to the hotel.
      dev dependencies     the target never builds anything.

    NODE RUNTIME. By default the release expects Node on the target machine and
    the installer detects it. Pass -BundleNode with the path to an extracted
    node-v22+-win-x64 folder to make the release fully self-contained; the
    launcher prefers a bundled runtime when one is present.

.EXAMPLE
    .\scripts\production\windows\Package-Kas.ps1
    .\scripts\production\windows\Package-Kas.ps1 -BundleNode 'C:\tmp\node-v22.11.0-win-x64'
#>
[CmdletBinding()]
param(
    [string]$OutputRoot,
    [string]$BundleNode,
    [switch]$SkipBuild,
    # OPT-IN, and deliberately so. See the KasSetup.exe section below: the
    # executable builds and its payload is sound, but IExpress does not reliably
    # launch the bootstrap inside it, and an installer that exits 0 having
    # installed nothing is far worse than no installer at all. The verified
    # install path is the staged folder plus Install-Kas.cmd.
    [switch]$BuildSetupExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
if (-not $OutputRoot) { $OutputRoot = Join-Path $RepoRoot 'release' }

$version = (Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
$stage = Join-Path $OutputRoot "Kas-$version"

# The folder that is actually handed over: KasSetup.exe plus its metadata. The
# staged payload above is an intermediate, and lives beside it rather than
# inside it so it is not mistaken for part of the release.
$releaseDir = Join-Path $OutputRoot "Kas-$version-release"
if (-not (Test-Path $releaseDir)) { New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null }

Write-Host "Kas $version -> $stage" -ForegroundColor Cyan

# --- 1. Build ---------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host 'Dang build...' -ForegroundColor Cyan
    Push-Location $RepoRoot
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build that bai.' }
    } finally { Pop-Location }
}

foreach ($required in 'server\dist\index.js', 'server\dist\launcher\cli.js', 'client\dist\index.html') {
    if (-not (Test-Path (Join-Path $RepoRoot $required))) {
        throw "Thieu $required. Chay 'npm run build' truoc."
    }
}

# --- 2. Clean stage ---------------------------------------------------------
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# --- 3. Copy the release payload -------------------------------------------
Write-Host 'Dang sao chep ung dung...' -ForegroundColor Cyan

function Copy-Payload {
    param([string]$Relative)
    $source = Join-Path $RepoRoot $Relative
    if (-not (Test-Path $source)) { throw "Khong tim thay $Relative" }
    $destination = Join-Path $stage $Relative
    $parent = Split-Path $destination -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item $source $destination -Recurse -Force
}

Copy-Payload 'server\dist'
Copy-Payload 'client\dist'
Copy-Payload 'prisma'

# The three entry points. KasService.cmd and KasBackup.cmd were MISSING here
# while the installer already registered Scheduled Tasks pointing at them —
# so on an elevated install both tasks referenced files that had never been
# copied, and neither the boot start nor the nightly backup would have run.
# Caught by installing into a throwaway directory and listing what arrived.
#
# These must stay in step with RELEASE_PAYLOAD in server/src/installer/plan.ts,
# which is what the uninstaller removes and what the tests assert.
Copy-Payload 'Kas.cmd'
Copy-Payload 'KasService.cmd'
Copy-Payload 'KasBackup.cmd'

# package.json files: needed by Node's module resolution and by the installer,
# which reads the version from the root one.
Copy-Payload 'package.json'
New-Item -ItemType Directory -Path (Join-Path $stage 'server') -Force | Out-Null
Copy-Item (Join-Path $RepoRoot 'server\package.json') (Join-Path $stage 'server\package.json') -Force

# Configuration TEMPLATE only — never the real .env.
Copy-Item (Join-Path $RepoRoot '.env.production.example') (Join-Path $stage '.env.example') -Force

# --- 4. Production dependencies --------------------------------------------
# Installed into the stage rather than copied from the repo: the repo tree
# carries dev dependencies and build tooling the target must never receive.
Write-Host 'Dang cai dependencies (production only)...' -ForegroundColor Cyan
Copy-Item (Join-Path $RepoRoot 'package-lock.json') (Join-Path $stage 'package-lock.json') -Force
Push-Location $stage
# THE EXIT CODE IS THE ANSWER, NOT STDERR. npm and Prisma both write
# informational banners to stderr — Prisma's version-update notice is a box of
# line-drawing characters — and under $ErrorActionPreference = 'Stop' PowerShell
# 5.1 turns any native stderr output into a terminating NativeCommandError. That
# failed a packaging run whose only sin was that Prisma had a new version out.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & npm.cmd ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'npm ci that bai.' }
    # --ignore-scripts skipped Prisma's generate, so the client is produced
    # explicitly. Without it @prisma/client throws at first query.
    & npx.cmd prisma generate --schema prisma/schema.prisma
    if ($LASTEXITCODE -ne 0) { throw 'prisma generate that bai.' }
} finally {
    $ErrorActionPreference = $previousPreference
    Pop-Location
}
Remove-Item (Join-Path $stage 'package-lock.json') -Force

# --- 5. Optional portable Node ---------------------------------------------
if ($BundleNode) {
    if (-not (Test-Path (Join-Path $BundleNode 'node.exe'))) {
        throw "Khong tim thay node.exe trong '$BundleNode'."
    }
    Write-Host 'Dang dong goi Node portable...' -ForegroundColor Cyan
    Copy-Item $BundleNode (Join-Path $stage 'runtime\node') -Recurse -Force
}

# --- 6. Installer ----------------------------------------------------------
$installerDir = Join-Path $stage 'installer'
New-Item -ItemType Directory -Path $installerDir -Force | Out-Null
foreach ($script in 'Install-Kas.ps1', 'Uninstall-Kas.ps1', 'Enable-KasAutostart.ps1') {
    Copy-Item (Join-Path $PSScriptRoot $script) (Join-Path $installerDir $script) -Force
}

# The autostart helper sits at the TOP of the release, not inside installer\,
# because it is the one thing an operator runs by hand after a non-elevated
# install — and something you have to go looking for in a subfolder is
# something that does not get run.
Copy-Item (Join-Path $PSScriptRoot 'Enable-KasAutostart.cmd') (Join-Path $stage 'Enable-KasAutostart.cmd') -Force
Copy-Item (Join-Path $PSScriptRoot 'Enable-KasAutostart.ps1') (Join-Path $stage 'Enable-KasAutostart.ps1') -Force
Copy-Item (Join-Path $PSScriptRoot 'Install-Kas.cmd') (Join-Path $stage 'Install-Kas.cmd') -Force

# Records the version so an upgrade can tell what it is replacing, and the
# COMMIT so the installed copy can report what it was built from. Without the
# commit an install has no .git to read and falls back to APP_RELEASE_REF, which
# the shipped .env template leaves at a placeholder — so the application
# reported a commit that never existed.
# No `2>$null` on the native command: under $ErrorActionPreference = 'Stop' that
# turns git's ordinary stderr chatter into a terminating error and the stamp
# comes back empty — which is exactly how the first attempt shipped a release
# with no commit in it.
$buildCommit = ''
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location $RepoRoot
try {
    # Captured WITHOUT a pipe. Piping a native command through Select-Object
    # replaces $LASTEXITCODE with the pipeline's own result, so the check below
    # discarded a perfectly good commit — the third time this exact PowerShell
    # trap has cost something in this project.
    $gitOutput = & git rev-parse HEAD
    if ($LASTEXITCODE -eq 0 -and $gitOutput) { $buildCommit = @($gitOutput)[0] }
} catch {
    $buildCommit = ''
} finally {
    $ErrorActionPreference = $previousPreference
    Pop-Location
}

@{ version = $version; commit = "$buildCommit".Trim(); packagedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content (Join-Path $stage 'kas-release.json') -Encoding utf8

$size = [math]::Round(((Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host ''
Write-Host "Da dong goi ung dung: $stage ($size MB)" -ForegroundColor Green

# --- 7. KasSetup.exe -------------------------------------------------------
#
# WHY IEXPRESS. A single-file installer needs a compiler, and none is installed
# on a machine that merely has Windows: Inno Setup, NSIS and WiX are all
# third-party downloads. iexpress.exe ships with Windows itself, so the release
# can be built anywhere without asking anyone to install a toolchain first.
#
# What it gives: one .exe, a licence page, a confirmation prompt, a finish
# message, and silent install via /Q. What it does not give: custom wizard
# pages, so the installation folder stays a parameter of Install-Kas.ps1 and
# the database is configured by editing .env, exactly as before.
#
# The payload is packed into ONE zip first. IExpress CABs the files it is
# given, and handing it thirty thousand node_modules files individually is
# both extremely slow and fragile; handing it a single archive is neither.
#
# ── STATUS: UNVERIFIED, OPT-IN ────────────────────────────────────────────
# The .exe builds, and extracting it by hand (KasSetup.exe /C /T:<dir>) yields
# an intact payload whose bootstrap installs correctly when run directly. What
# does NOT work is IExpress launching that bootstrap itself: AppLaunched and
# the quiet-install commands were tried as `cmd.exe /c file`, as a bare file
# name and with paths resolved from %~dp0, and every form returned success
# while installing nothing. Until that is understood, this stays behind
# -BuildSetupExe and the release ships the folder installer.
if (-not $BuildSetupExe) {
    Write-Host 'Bo qua KasSetup.exe (dung -BuildSetupExe de tao - xem ghi chu trong script).' -ForegroundColor Yellow
} else {
    $iexpress = Join-Path $env:WINDIR 'System32\iexpress.exe'
    if (-not (Test-Path $iexpress)) {
        Write-Host 'Khong tim thay iexpress.exe - chi tao goi thu muc.' -ForegroundColor Yellow
    } else {
        Write-Host 'Dang tao KasSetup.exe...' -ForegroundColor Cyan
        $build = Join-Path $OutputRoot '.setup-build'
        if (Test-Path $build) { Remove-Item $build -Recurse -Force }
        New-Item -ItemType Directory -Path $build -Force | Out-Null

        # tar.exe ships with Windows 10 1803+ and is far faster than
        # Compress-Archive on a tree this size.
        $payloadZip = Join-Path $build 'KasPayload.zip'
        Push-Location (Split-Path $stage -Parent)
        try {
            & tar.exe -a -c -f $payloadZip (Split-Path $stage -Leaf)
            if ($LASTEXITCODE -ne 0) { throw "Nen goi that bai (tar exit $LASTEXITCODE)." }
        } finally { Pop-Location }

        Copy-Item (Join-Path $PSScriptRoot 'KasSetup-Bootstrap.cmd') (Join-Path $build 'KasSetup-Bootstrap.cmd') -Force
        Copy-Item (Join-Path $PSScriptRoot 'KasSetup-License.txt') (Join-Path $build 'KasSetup-License.txt') -Force

        # The SED is generated rather than committed: it embeds absolute paths
        # and the version, both of which differ per build.
        $setupExe = Join-Path $releaseDir 'KasSetup.exe'
        $sed = Join-Path $build 'KasSetup.SED'
        $sedText = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AppLaunched%
UserQuietInstCmd=%AppLaunched%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=Cai dat Kas ${version}? Cau hinh, anh xac nhan va cac ban sao luu hien co se duoc giu nguyen.
DisplayLicense=$build\KasSetup-License.txt
FinishMessage=Da cai dat Kas ${version}. Mo tep .env trong thu muc cai dat va dien DATABASE_URL, sau do nhan dup bieu tuong Kas tren Desktop.
TargetName=$setupExe
FriendlyName=Kas ${version} - Trung tam dieu phoi dat phong
AppLaunched=cmd.exe /c "KasSetup-Bootstrap.cmd"
PostInstallCmd=<None>
FILE0="KasSetup-Bootstrap.cmd"
FILE1="KasPayload.zip"
[SourceFiles]
SourceFiles0=$build
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
        Set-Content -LiteralPath $sed -Value $sedText -Encoding ASCII

        # /N builds without showing the wizard; /Q suppresses its own output.
        #
        # Start-Process -Wait, NOT the call operator. iexpress.exe is a GUI
        # application: PowerShell launches it and carries straight on without
        # waiting, so `&` returns no exit code at all and the existence check
        # below runs before a single byte has been written. It looked exactly
        # like a malformed SED.
        $build_ = Start-Process -FilePath $iexpress -ArgumentList '/N', '/Q', $sed -Wait -PassThru
        if ($build_.ExitCode -ne 0) {
            throw "IExpress that bai (ma $($build_.ExitCode))."
        }
        if (-not (Test-Path $setupExe)) {
            throw 'IExpress khong tao duoc KasSetup.exe. Xem thu muc .setup-build de chan doan.'
        }
        Remove-Item $build -Recurse -Force
        $exeSize = [math]::Round(((Get-Item $setupExe).Length / 1MB), 1)
        Write-Host "  KasSetup.exe ($exeSize MB)" -ForegroundColor Green
    }
}

# --- 8. Release metadata ---------------------------------------------------
# Written by the Node tool so the wording and the checksum format live in
# tested code, and so the version is never typed twice.
$metadataTool = Join-Path $RepoRoot 'server\dist\scripts\releaseMetadata.js'
if (Test-Path $metadataTool) {
    & node $metadataTool "--release-dir=$releaseDir" "--version=$version"
    if ($LASTEXITCODE -ne 0) { throw "Ghi metadata that bai (exit $LASTEXITCODE)." }
} else {
    Write-Host 'Bo qua metadata: chua build server (npm run build).' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "Ban phat hanh: $releaseDir" -ForegroundColor Green
Get-ChildItem $releaseDir -File | ForEach-Object {
    Write-Host ("  {0,-18} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB))
}
Write-Host ''
Write-Host 'Gui ca thu muc nay. Nguoi dung nhan dup KasSetup.exe.'
