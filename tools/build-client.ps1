<#
.SYNOPSIS
    Builds the client package: service and GUI self-contained for win-x64 in one folder, install.ps1, zip + SHA-256.
    Output: client-package/M365SmtpProxy.zip, .zip.sha256, version.json (copied into the server image).
#>
param([string]$Out = (Join-Path $PSScriptRoot '..\client-package'))

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$pub = Join-Path $root 'client\publish\pkg'
Remove-Item -Recurse -Force $pub -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $pub, $Out | Out-Null

foreach ($proj in 'SmtpProxy.Service', 'SmtpProxy.Gui') {
    dotnet publish (Join-Path $root "client\src\$proj") -c Release -r win-x64 --self-contained true -o $pub -p:DebugType=none -nologo -v q
    if ($LASTEXITCODE) { throw "dotnet publish $proj fehlgeschlagen" }
}
Copy-Item (Join-Path $root 'install\install.ps1') $pub

[xml]$props = Get-Content (Join-Path $root 'client\Directory.Build.props')
$version = $props.Project.PropertyGroup.Version
$zip = Join-Path $Out 'M365SmtpProxy.zip'
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $pub '*') -DestinationPath $zip -CompressionLevel Optimal
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path "$zip.sha256" -Value "$sha  M365SmtpProxy.zip" -NoNewline -Encoding ascii
@{ version = $version; sha256 = $sha; size = (Get-Item $zip).Length; builtAt = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -Path (Join-Path $Out 'version.json') -Encoding utf8
Copy-Item (Join-Path $root 'install\install.ps1') $Out
Write-Host "Client $version -> $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB, sha256 $sha)"
