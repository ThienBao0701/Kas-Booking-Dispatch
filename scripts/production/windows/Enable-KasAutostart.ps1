<#
.SYNOPSIS
    Registers the two Windows Scheduled Tasks that run Kas unattended.

.DESCRIPTION
    The installer registers these itself when it is run elevated. This script
    exists for the case that actually happens: Kas was installed without
    Administrator rights, so the tasks were skipped and nobody noticed until
    the machine was next restarted and Kas did not come back.

        Kas          at Windows startup, as SYSTEM, before anyone logs in
        Kas Backup   daily at 22:00, as SYSTEM

    Both point at files inside the install directory. Registering a task
    against a path that does not exist would produce a boot failure discovered
    only after a reboot, so the files are checked first.

    ELEVATION IS REQUIRED, because both tasks run as SYSTEM. Without it the
    script says so and changes nothing.

.EXAMPLE
    Right-click -> Run with PowerShell (as Administrator)

    .\Enable-KasAutostart.ps1 -InstallDir 'C:\Kas'
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Kas'),
    # Report what would be registered and change nothing.
    [switch]$WhatIfOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$serviceCmd = Join-Path $InstallDir 'KasService.cmd'
$backupCmd = Join-Path $InstallDir 'KasBackup.cmd'

Write-Host ''
Write-Host '===============================================' -ForegroundColor Cyan
Write-Host '  Kas - bat tu dong khoi dong cung Windows' -ForegroundColor Cyan
Write-Host '===============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "  Thu muc cai dat : $InstallDir"

# --- The files the tasks will point at --------------------------------------
$missing = @()
foreach ($file in $serviceCmd, $backupCmd) {
    if (-not (Test-Path $file)) { $missing += $file }
}
if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host '  KHONG TIM THAY TEP CAN THIET:' -ForegroundColor Red
    foreach ($file in $missing) { Write-Host "    $file" -ForegroundColor Red }
    Write-Host ''
    Write-Host '  Dang ky mot Scheduled Task tro toi tep khong ton tai se tao ra loi' -ForegroundColor Red
    Write-Host '  chi phat hien duoc sau khi khoi dong lai may. Hay cai dat Kas truoc,' -ForegroundColor Red
    Write-Host '  hoac chi dinh dung thu muc bang -InstallDir.' -ForegroundColor Red
    exit 1
}

# --- Elevation ---------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host ''
    Write-Host '  CAN QUYEN ADMINISTRATOR.' -ForegroundColor Yellow
    Write-Host '  Ca hai tac vu chay duoi tai khoan SYSTEM nen Windows bat buoc phai co quyen nay.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Cach chay:' -ForegroundColor Yellow
    Write-Host '    1. Bam chuot phai vao Start > Windows PowerShell (Administrator)' -ForegroundColor Yellow
    Write-Host "    2. Chay:  & '$PSCommandPath' -InstallDir '$InstallDir'" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Khong co gi bi thay doi.' -ForegroundColor Yellow
    exit 1
}

if ($WhatIfOnly) {
    Write-Host ''
    Write-Host '  -WhatIfOnly: se dang ky' -ForegroundColor Cyan
    Write-Host "    Kas         ONSTART  SYSTEM  -> $serviceCmd"
    Write-Host "    Kas Backup  DAILY 22:00  SYSTEM  -> $backupCmd"
    exit 0
}

# --- Register -----------------------------------------------------------------
#
# Registered through the ScheduledTasks module, not schtasks.exe.
#
# WHAT WENT WRONG WITH schtasks.exe. The intention was to lift the default
# 72-hour execution limit, which would otherwise stop a healthy server every
# three days, and `/Change /ET` read like the way to say it. It is not. `/ET`
# sets the TRIGGER'S END BOUNDARY - the moment after which the trigger stops
# firing at all - so
#
#     schtasks /Change /TN 'Kas Backup' /ET 02:00
#
# asked Windows for a trigger that begins at 22:00 today and expires at 02:00
# today, sixteen hours earlier. Windows said so, exactly:
#
#     ERROR: The task XML contains a value which is incorrectly formatted or
#     out of range.
#     (11,42):EndBoundary:2026-08-06T02:00:00
#
# Reproduced on this machine before the fix was written. The limit that was
# actually wanted is ExecutionTimeLimit, which schtasks.exe cannot set from the
# command line under any spelling - which is why the wrong knob got turned.
#
# `/Change` has a second disqualifying habit: it prompts on stdin for the run-as
# password. In an unattended installer that is not an error, it is a hang.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Stop'
$failed = $false

function Register-KasTask {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][object]$Trigger,
        # [TimeSpan]::Zero means no limit. Anything else is a kill deadline.
        [Parameter(Mandatory)][timespan]$TimeLimit
    )

    $action = New-ScheduledTaskAction -Execute $Command -WorkingDirectory $WorkingDirectory
    # ServiceAccount is the logon type SYSTEM requires; RunLevel Highest is what
    # /RL HIGHEST said before.
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit $TimeLimit `
        -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable
    # -Force replaces an existing registration, which is what makes this safe to
    # re-run after an upgrade moved the install.
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
}

try {
    # A boot trigger fires while Windows is still starting its services. Thirty
    # seconds lets PostgreSQL get as far as accepting connections, so the first
    # attempt is a start rather than a restart.
    $bootTrigger = New-ScheduledTaskTrigger -AtStartup
    $bootTrigger.Delay = 'PT30S'
    Register-KasTask -Name 'Kas' -Command $serviceCmd -WorkingDirectory $InstallDir `
        -Trigger $bootTrigger -TimeLimit ([TimeSpan]::Zero)
    Write-Host '  [OK] Kas          - khoi dong cung Windows (khong gioi han thoi gian chay)' -ForegroundColor Green

    # Two hours is far longer than a backup takes. Here it means what /ET 02:00
    # was mistakenly asked to mean: stop an overrun before it can overlap the
    # next night's run.
    Register-KasTask -Name 'Kas Backup' -Command $backupCmd -WorkingDirectory $InstallDir `
        -Trigger (New-ScheduledTaskTrigger -Daily -At '22:00') -TimeLimit (New-TimeSpan -Hours 2)
    Write-Host '  [OK] Kas Backup   - sao luu hang ngay 22:00' -ForegroundColor Green
} catch {
    $failed = $true
    Write-Host "  [LOI] $($_.Exception.Message)" -ForegroundColor Red
} finally {
    $ErrorActionPreference = $previousPreference
}

if ($failed) { exit 1 }

# --- Prove it -----------------------------------------------------------------
#
# Read back from Windows rather than trusting that the call returned. The
# previous version reported [OK] on a task whose /Change had just been rejected,
# because only the /Create exit code was ever examined.
Write-Host ''
Write-Host '  Kiem tra lai:' -ForegroundColor Cyan
foreach ($task in 'Kas', 'Kas Backup') {
    $registered = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if ($null -eq $registered) {
        Write-Host ("    {0,-12} KHONG THAY" -f $task) -ForegroundColor Red
        $failed = $true
        continue
    }
    $limit = $registered.Settings.ExecutionTimeLimit
    $when = ($registered.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','
    Write-Host ("    {0,-12} da dang ky  [{1}]  gioi han: {2}  chay duoi: {3}" -f `
        $task, $when, $limit, $registered.Principal.UserId)
}

if ($failed) { exit 1 }

Write-Host ''
Write-Host '  Xong. Kas se tu chay sau lan khoi dong may tiep theo.' -ForegroundColor Green
Write-Host '  Chay ngay khong can khoi dong lai:  schtasks /Run /TN "Kas"' -ForegroundColor Green
Write-Host '  Kiem tra toan bo he thong:          Kas.cmd --diagnose' -ForegroundColor Green
exit 0
