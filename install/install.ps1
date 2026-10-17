<#
.SYNOPSIS
    Installs, updates or removes the M365 SMTP Proxy (Windows service + GUI).

.DESCRIPTION
    One-liner from a management server (the server fills in its address):
        irm https://<server>/install.ps1 | iex
    Standalone from GitHub (latest release):
        irm https://github.com/dominguez-posh/m365-SMTPProxy/releases/latest/download/install.ps1 | iex
    With parameters:
        & ([scriptblock]::Create((irm https://<server>/install.ps1))) -Port 2525

    The service runs this script of the NEW version with -Update -Source <folder> to update itself.
    Runs in Windows PowerShell 5.1 and PowerShell 7. ASCII only (5.1 reads files without BOM as ANSI).
#>
param(
    [string]$ServerUrl = '__SERVER_URL__',
    [string]$PackageUrl = '__PACKAGE_URL__',
    [int]$Port = 0,
    [switch]$Update,
    [string]$Source,
    [switch]$Uninstall,
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ServiceName = 'M365SmtpProxy'
$DisplayName = 'M365 SMTP Proxy'
$InstallDir = Join-Path $env:ProgramFiles 'M365SmtpProxy'
$DataDir = Join-Path $env:ProgramData 'M365SmtpProxy'
$ServiceExe = Join-Path $InstallDir 'M365SmtpProxy.Service.exe'
$GuiExe = Join-Path $InstallDir 'M365SmtpProxy.exe'
$UninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\M365SmtpProxy'
$Shortcut = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\M365 SMTP Proxy.lnk'

if ($ServerUrl -like '__*__') { $ServerUrl = '' }
if ($PackageUrl -like '__*__') { $PackageUrl = 'https://github.com/dominguez-posh/m365-SMTPProxy/releases/latest/download/M365SmtpProxy.zip' }

function Write-Step([string]$Text) { Write-Host "  > $Text" -ForegroundColor Cyan }

function Write-UpdateLog([string]$Text) {
    try {
        New-Item -ItemType Directory -Force (Join-Path $DataDir 'logs') | Out-Null
        Add-Content -Path (Join-Path $DataDir 'logs\update.log') -Value "$(Get-Date -Format s) $Text"
    } catch { }
}

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Bitte PowerShell als Administrator starten.'
    }
}

function Stop-Proxy {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
    }
    # GUI and service processes still holding files
    Get-Process -Name 'M365SmtpProxy', 'M365SmtpProxy.Service' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

function Copy-Files([string]$From) {
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    for ($i = 1; $i -le 5; $i++) {
        try {
            Copy-Item -Path (Join-Path $From '*') -Destination $InstallDir -Recurse -Force
            return
        } catch {
            if ($i -eq 5) { throw }
            Start-Sleep -Seconds 3
        }
    }
}

function Set-DataAcl {
    New-Item -ItemType Directory -Force $DataDir | Out-Null
    # SYSTEM and Administrators only: the configuration contains password hashes of the SMTP users
    & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
}

function Register-Proxy([string]$Version) {
    if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
        New-Service -Name $ServiceName -BinaryPathName "`"$ServiceExe`"" -DisplayName $DisplayName -StartupType Automatic `
            -Description 'Nimmt E-Mails per SMTP an und stellt sie ueber Microsoft Graph zu.' | Out-Null
    }
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
    & sc.exe config $ServiceName start= delayed-auto | Out-Null

    # firewall: inbound for the service program, independent of the configured port
    if (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue) {
        Get-NetFirewallRule -Name 'M365SmtpProxy-In' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -Name 'M365SmtpProxy-In' -DisplayName "$DisplayName (SMTP)" -Direction Inbound -Action Allow `
            -Program $ServiceExe -Protocol TCP -Profile Domain, Private | Out-Null
    }

    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Shortcut)
    $lnk.TargetPath = $GuiExe
    $lnk.WorkingDirectory = $InstallDir
    $lnk.Description = $DisplayName
    $lnk.Save()

    New-Item -Path $UninstallKey -Force | Out-Null
    $uninstall = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\install.ps1`" -Uninstall"
    Set-ItemProperty -Path $UninstallKey -Name DisplayName -Value $DisplayName
    Set-ItemProperty -Path $UninstallKey -Name DisplayVersion -Value $Version
    Set-ItemProperty -Path $UninstallKey -Name Publisher -Value 'M365 SMTP Proxy'
    Set-ItemProperty -Path $UninstallKey -Name InstallLocation -Value $InstallDir
    Set-ItemProperty -Path $UninstallKey -Name DisplayIcon -Value $GuiExe
    Set-ItemProperty -Path $UninstallKey -Name UninstallString -Value $uninstall
    Set-ItemProperty -Path $UninstallKey -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty -Path $UninstallKey -Name NoRepair -Value 1 -Type DWord
}

function Get-PackageVersion([string]$Folder) {
    $exe = Join-Path $Folder 'M365SmtpProxy.Service.exe'
    if (Test-Path $exe) { return (Get-Item $exe).VersionInfo.ProductVersion -replace '\+.*$', '' }
    return '0.0.0'
}

# ------------------------------------------------------------------ update (started by the service as SYSTEM)
if ($Update) {
    try {
        $version = Get-PackageVersion $Source
        Write-UpdateLog "Update auf $version aus $Source"
        Stop-Proxy
        Copy-Files $Source
        Register-Proxy $version
        Start-Service -Name $ServiceName
        Write-UpdateLog "Update auf $version abgeschlossen"
        Remove-Item -Recurse -Force $Source -ErrorAction SilentlyContinue
    } catch {
        Write-UpdateLog "Update fehlgeschlagen: $($_.Exception.Message)"
        Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
    }
    return
}

Assert-Admin

# ------------------------------------------------------------------ uninstall
if ($Uninstall) {
    Write-Host "$DisplayName wird entfernt ..." -ForegroundColor Cyan
    # leave the management server cleanly (the service would otherwise stay listed there)
    if (Test-Path $ServiceExe) { try { & $ServiceExe --unregister 2>$null | Out-Null } catch { } }
    Stop-Proxy
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { & sc.exe delete $ServiceName | Out-Null }
    Get-NetFirewallRule -Name 'M365SmtpProxy-In' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Remove-Item $Shortcut -Force -ErrorAction SilentlyContinue
    Remove-Item $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    # the script itself lives in the install folder: remove it after this process ends
    Start-Process -FilePath cmd.exe -ArgumentList "/c timeout /t 3 >nul & rmdir /s /q `"$InstallDir`"" -WindowStyle Hidden
    if ($RemoveData) { Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue }
    Write-Host "Entfernt. $(if (-not $RemoveData) { "Daten bleiben in $DataDir (mit -RemoveData loeschen). Das Zertifikat der App bleibt im Computerspeicher." })" -ForegroundColor Green
    return
}

# ------------------------------------------------------------------ install / reinstall
Write-Host "$DisplayName wird installiert ..." -ForegroundColor Cyan
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Nur 64-Bit-Windows wird unterstuetzt.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$tmp = Join-Path $env:TEMP "m365smtpproxy-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    $zip = Join-Path $tmp 'package.zip'
    Write-Step "Paket wird geladen: $PackageUrl"
    Invoke-WebRequest -Uri $PackageUrl -OutFile $zip -UseBasicParsing
    $expected = $null
    try {
        $content = (Invoke-WebRequest -Uri "$PackageUrl.sha256" -UseBasicParsing).Content
        if ($content -is [byte[]]) { $content = [Text.Encoding]::ASCII.GetString($content) }
        $expected = $content.Trim().Split(' ')[0]
    } catch { }
    if ($expected) {
        $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
        if ($actual -ne $expected) { throw "Pruefsumme des Pakets stimmt nicht (erwartet $expected, erhalten $actual)." }
        Write-Step 'Pruefsumme stimmt.'
    }
    $pkg = Join-Path $tmp 'pkg'
    Expand-Archive -Path $zip -DestinationPath $pkg -Force
    $version = Get-PackageVersion $pkg

    Write-Step "Version $version wird nach $InstallDir kopiert ..."
    Stop-Proxy
    Copy-Files $pkg
    Set-DataAcl

    # initial configuration: management server and port (only if given; an existing configuration is kept)
    $configFile = Join-Path $DataDir 'config.json'
    if ($ServerUrl -or $Port) {
        $cfg = if (Test-Path $configFile) { Get-Content -Raw $configFile | ConvertFrom-Json } else { [pscustomobject]@{} }
        if ($ServerUrl) {
            if (-not $cfg.management) { $cfg | Add-Member -NotePropertyName management -NotePropertyValue ([pscustomobject]@{}) }
            $cfg.management | Add-Member -NotePropertyName serverUrl -NotePropertyValue $ServerUrl.TrimEnd('/') -Force
            Write-Step "Verwaltungsserver: $ServerUrl"
        }
        if ($Port) {
            if (-not $cfg.smtp) { $cfg | Add-Member -NotePropertyName smtp -NotePropertyValue ([pscustomobject]@{}) }
            $cfg.smtp | Add-Member -NotePropertyName port -NotePropertyValue $Port -Force
            Write-Step "SMTP-Port: $Port"
        }
        if ($cfg.PSObject.Properties['revision']) { $cfg.revision = [long]$cfg.revision + 1 } else { $cfg | Add-Member -NotePropertyName revision -NotePropertyValue 1 }
        $cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $configFile -Encoding UTF8
    }

    Write-Step 'Dienst wird eingerichtet ...'
    Register-Proxy $version
    Start-Service -Name $ServiceName

    Write-Host ''
    Write-Host "$DisplayName $version ist installiert und gestartet." -ForegroundColor Green
    Write-Host "Oberflaeche: Startmenue > $DisplayName (verbindet mit Microsoft 365)."
    if ($ServerUrl) { Write-Host "Der Proxy meldet sich bei $ServerUrl an; dort die Verbindung freigeben." }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
