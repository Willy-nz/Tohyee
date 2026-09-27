# Builds dist\windows\TohyeeSetup-<version>.exe. Runs on a Windows machine
# (GitHub's windows-latest) after `npm ci` and `npm run build`.
# Downloads Node.js (same version as the build), PostgreSQL, WinSW and the
# Visual C++ runtime, stages them with the app, and compiles Tohyee.iss.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# PostgreSQL Windows x86-64 binaries from EDB's download page
# (https://www.enterprisedb.com/download-postgresql-binaries).
$PostgresVersion = '17.11'
$PostgresUrl = 'https://sbp.enterprisedb.com/getfile.jsp?fileid=1260569'
$WinSwUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$VcRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $root 'dist\windows'
$stage = Join-Path $out 'stage'
$downloads = Join-Path $out 'downloads'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

if (-not (Test-Path (Join-Path $root '.next\standalone\server.js'))) {
  throw 'Run npm run build first (.next\standalone is missing).'
}

Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage, $downloads, (Join-Path $stage 'node'), (Join-Path $stage 'service'), (Join-Path $stage 'scripts') | Out-Null

Write-Host "== App $version"
Copy-Item -Recurse (Join-Path $root '.next\standalone') (Join-Path $stage 'app')
Copy-Item -Recurse (Join-Path $root '.next\static') (Join-Path $stage 'app\.next\static')
Copy-Item -Recurse (Join-Path $root 'public') (Join-Path $stage 'app\public')
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $stage 'LICENSE.txt')

$nodeVersion = (& node -v).Trim()
Write-Host "== Node.js $nodeVersion"
$nodeZip = Join-Path $downloads 'node.zip'
Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip" -OutFile $nodeZip
Expand-Archive $nodeZip (Join-Path $downloads 'node') -Force
$nodeDir = Join-Path $downloads "node\node-$nodeVersion-win-x64"
Copy-Item (Join-Path $nodeDir 'node.exe') (Join-Path $stage 'node\node.exe')
Copy-Item (Join-Path $nodeDir 'LICENSE') (Join-Path $stage 'node\LICENSE.txt')

Write-Host "== PostgreSQL $PostgresVersion"
$pgZip = Join-Path $downloads 'pgsql.zip'
Invoke-WebRequest $PostgresUrl -OutFile $pgZip
Expand-Archive $pgZip (Join-Path $downloads 'pg') -Force
$pgDir = Join-Path $downloads 'pg\pgsql'
if (-not (Test-Path (Join-Path $pgDir 'bin\postgres.exe'))) { throw "The PostgreSQL download didn't contain pgsql\bin\postgres.exe." }
$pgActual = (& (Join-Path $pgDir 'bin\postgres.exe') --version)
Write-Host $pgActual
if ($pgActual -notmatch [regex]::Escape($PostgresVersion)) { throw "Expected PostgreSQL $PostgresVersion, got: $pgActual" }
Copy-Item -Recurse $pgDir (Join-Path $stage 'pgsql')
foreach ($unused in @('pgAdmin 4', 'StackBuilder', 'doc', 'include', 'symbols')) {
  Remove-Item -Recurse -Force (Join-Path $stage "pgsql\$unused") -ErrorAction SilentlyContinue
}

Write-Host '== WinSW and the Visual C++ runtime'
Invoke-WebRequest $WinSwUrl -OutFile (Join-Path $stage 'service\WinSW-x64.exe')
Invoke-WebRequest $VcRedistUrl -OutFile (Join-Path $stage 'vc_redist.x64.exe')

foreach ($script in @('configure-tohyee.ps1', 'remove-services.ps1', 'Backup-Tohyee.ps1')) {
  Copy-Item (Join-Path $PSScriptRoot $script) (Join-Path $stage "scripts\$script")
}

Write-Host '== Inno Setup'
$iscc = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
  choco install innosetup -y --no-progress | Out-Host
  $iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $iscc) { throw 'Inno Setup (ISCC.exe) not found.' }
& $iscc "/DAppVersion=$version" "/DSourceDir=$stage" "/DOutputDir=$out" (Join-Path $PSScriptRoot 'Tohyee.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

$setup = Join-Path $out "TohyeeSetup-$version.exe"
$hash = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$setup.sha256", "$hash  TohyeeSetup-$version.exe`n")
Write-Host ("Built {0} ({1:N0} MB)" -f $setup, ((Get-Item $setup).Length / 1MB))
