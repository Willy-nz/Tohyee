# Builds dist\windows\TohyeeSetup-<version>.exe. Runs on a Windows machine
# (GitHub's windows-latest) after `npm ci` and `npm run build`.
# Downloads Node.js (same version as the build), PostgreSQL, WinSW, the
# Visual C++ runtime and Cloudflare's cloudflared (for remote access), builds
# the Tohyee server app (installer\windows\tray, needs the .NET SDK), stages
# them with the app, and compiles Tohyee.iss.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# PostgreSQL Windows x86-64 binaries from EDB's download page
# (https://www.enterprisedb.com/download-postgresql-binaries).
$PostgresVersion = '17.11'
$PostgresUrl = 'https://sbp.enterprisedb.com/getfile.jsp?fileid=1260569'
# The major version every installed data folder (%ProgramData%\Tohyee\pgdata)
# was made with. An update replaces pgsql\bin, and a new major version can't
# start on the old data folder, so moving to another major version needs
# pg_upgrade in configure-tohyee.ps1 first (issue #156). Until then the build
# refuses it.
$PostgresMajor = '17'
if ($PostgresVersion.Split('.')[0] -ne $PostgresMajor) {
  throw "PostgreSQL $PostgresVersion isn't version $PostgresMajor. Installed servers can't start on a new major version until configure-tohyee.ps1 runs pg_upgrade (issue #156)."
}
$WinSwUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$VcRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
# cloudflared runs the Cloudflare Tunnel for remote access (Server > Remote access).
# Pinned, and checked against the SHA-256 of that release's file.
$CloudflaredVersion = '2026.9.3'
$CloudflaredUrl = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe"
$CloudflaredSha256 = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $root 'dist\windows'
$stage = Join-Path $out 'stage'
$downloads = Join-Path $out 'downloads'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

if (-not (Test-Path (Join-Path $root '.next\standalone\server.js'))) {
  throw 'Run npm run build first (.next\standalone is missing).'
}

Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage, $downloads, (Join-Path $stage 'node'), (Join-Path $stage 'service'), (Join-Path $stage 'scripts'), (Join-Path $stage 'cloudflared') | Out-Null

Write-Host "== App $version"
Copy-Item -Recurse (Join-Path $root '.next\standalone') (Join-Path $stage 'app')
# The build can trace data a development server wrote into the working copy
# (DuckDB copies of real books, backups) into .next\standalone (issue #155).
# It's never part of a release.
foreach ($data in @('analytics', 'backups', 'data')) {
  Remove-Item -Recurse -Force (Join-Path $stage "app\$data") -ErrorAction SilentlyContinue
}
Copy-Item -Recurse (Join-Path $root '.next\static') (Join-Path $stage 'app\.next\static')
Copy-Item -Recurse (Join-Path $root 'public') (Join-Path $stage 'app\public')
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $stage 'LICENSE.txt')

& node (Join-Path $root 'scripts\build-admin.mjs')
if ($LASTEXITCODE -ne 0) { throw "Building the command-line tool failed with exit code $LASTEXITCODE" }
Copy-Item (Join-Path $root 'dist\tohyee-admin.cjs') (Join-Path $stage 'app\tohyee-admin.cjs')

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

Write-Host "== cloudflared $CloudflaredVersion"
$cloudflaredExe = Join-Path $stage 'cloudflared\cloudflared.exe'
Invoke-WebRequest $CloudflaredUrl -OutFile $cloudflaredExe
$cloudflaredHash = (Get-FileHash $cloudflaredExe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cloudflaredHash -ne $CloudflaredSha256) { throw "cloudflared download has SHA-256 $cloudflaredHash, expected $CloudflaredSha256." }
Invoke-WebRequest "https://raw.githubusercontent.com/cloudflare/cloudflared/$CloudflaredVersion/LICENSE" -OutFile (Join-Path $stage 'cloudflared\LICENSE.txt')

Write-Host '== Tohyee server app (tray icon and server settings)'
# .NET Framework 4.8 comes with Windows 10 and 11, so nothing extra is installed.
& dotnet build (Join-Path $PSScriptRoot 'tray\TohyeeTray.csproj') -c Release -o (Join-Path $stage 'tray') "-p:Version=$version" --nologo
if ($LASTEXITCODE -ne 0) { throw "Building the Tohyee server app failed with exit code $LASTEXITCODE" }
if (-not (Test-Path (Join-Path $stage 'tray\TohyeeTray.exe'))) { throw 'The Tohyee server app (TohyeeTray.exe) was not built.' }
Get-ChildItem (Join-Path $stage 'tray') -Include *.pdb, *.xml -Recurse | Remove-Item -Force

foreach ($script in @('configure-tohyee.ps1', 'remove-services.ps1')) {
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
