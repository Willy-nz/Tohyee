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
# The PostgreSQL major version existing installs' data folder
# (%ProgramData%\Tohyee\pgdata) was made with. A new major version can't
# start on an older major's data folder: an update would replace pgsql\bin
# and leave every Windows install without a running database (issue #156).
# Minor updates (17.x) are fine. Don't change this until configure-tohyee.ps1
# upgrades the data folder with pg_upgrade (keeping the old bin folder for it).
$PostgresMajorWithUpgradePath = '17'
if ($PostgresVersion.Split('.')[0] -ne $PostgresMajorWithUpgradePath) {
  throw "PostgreSQL $PostgresVersion is a different major version from $PostgresMajorWithUpgradePath. Installed data folders need pg_upgrade first: add that to configure-tohyee.ps1 before changing the major version."
}
$WinSwUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
# Visual C++ 2015-2022 runtime 14.44.35211.0, from Microsoft's versioned
# download URL (where https://aka.ms/vs/17/release/vc_redist.x64.exe pointed
# on 5 Oct 2026; the URL contains the file's SHA-256). To update, follow that
# aka.ms link and copy the new URL and hash.
$VcRedistUrl = 'https://download.visualstudio.microsoft.com/download/pr/bd1c8d9d-ba95-4eee-bc6e-df1fcc876373/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe'
$VcRedistSha256 = 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b'
# Inno Setup compiles the installer. Pinned, and checked against the SHA-256
# of the file downloaded from that GitHub release on 5 Oct 2026.
$InnoSetupVersion = '6.7.3'
$InnoSetupUrl = "https://github.com/jrsoftware/issrc/releases/download/is-$($InnoSetupVersion -replace '\.', '_')/innosetup-$InnoSetupVersion.exe"
$InnoSetupSha256 = '9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732'
# cloudflared runs the Cloudflare Tunnel for remote access (Server > Remote access).
# Pinned, and checked against the SHA-256 of that release's file.
$CloudflaredVersion = '2026.9.3'
$CloudflaredUrl = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe"
$CloudflaredSha256 = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'

# Throws unless the file's SHA-256 is the pinned one.
function Assert-Sha256([string] $Path, [string] $Expected, [string] $Name) {
  $actual = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "$Name download has SHA-256 $actual, expected $Expected." }
}

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
$vcRedist = Join-Path $stage 'vc_redist.x64.exe'
Invoke-WebRequest $VcRedistUrl -OutFile $vcRedist
Assert-Sha256 $vcRedist $VcRedistSha256 'Visual C++ runtime'

Write-Host "== cloudflared $CloudflaredVersion"
$cloudflaredExe = Join-Path $stage 'cloudflared\cloudflared.exe'
Invoke-WebRequest $CloudflaredUrl -OutFile $cloudflaredExe
Assert-Sha256 $cloudflaredExe $CloudflaredSha256 'cloudflared'
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

Write-Host "== Inno Setup $InnoSetupVersion"
# Always the pinned version rather than whatever the machine already has,
# installed into dist\windows\downloads.
$innoDir = Join-Path $downloads "innosetup-$InnoSetupVersion"
$iscc = Join-Path $innoDir 'ISCC.exe'
if (-not (Test-Path $iscc)) {
  $innoSetup = Join-Path $downloads "innosetup-$InnoSetupVersion.exe"
  Invoke-WebRequest $InnoSetupUrl -OutFile $innoSetup
  Assert-Sha256 $innoSetup $InnoSetupSha256 'Inno Setup'
  $p = Start-Process -FilePath $innoSetup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/CURRENTUSER', "/DIR=`"$innoDir`"") -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Installing Inno Setup failed with exit code $($p.ExitCode)" }
}
if (-not (Test-Path $iscc)) { throw "Inno Setup (ISCC.exe) not found in $innoDir." }
& $iscc "/DAppVersion=$version" "/DSourceDir=$stage" "/DOutputDir=$out" (Join-Path $PSScriptRoot 'Tohyee.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

$setup = Join-Path $out "TohyeeSetup-$version.exe"
$hash = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$setup.sha256", "$hash  TohyeeSetup-$version.exe`n")
Write-Host ("Built {0} ({1:N0} MB)" -f $setup, ((Get-Item $setup).Length / 1MB))
