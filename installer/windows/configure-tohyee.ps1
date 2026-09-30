# Sets up (or updates) Tohyee's database and Windows services. Run by
# TohyeeSetup.exe as Administrator after it copies the program files.
#
#   Program files: <InstallDir>  (node, pgsql, app, service, scripts, cloudflared)
#   Data:          %ProgramData%\Tohyee  (pgdata, service, logs, tohyee.env)
#
# Services (both start automatically when Windows starts, before anyone signs in):
#   TohyeePostgres  PostgreSQL, listening on localhost only
#   Tohyee          the Tohyee server (node), http://localhost:<port>, and its
#                   server settings address, http://127.0.0.1:<admin port>
#                   (this computer only; the tray app uses it)
#
# Safe to run again: existing passwords and data are kept.

param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  # Where to write what the installer's last page shows (optional).
  [string]$ResultFile = ''
)

$ErrorActionPreference = 'Stop'
$DataRoot = Join-Path $env:ProgramData 'Tohyee'
$LogDir = Join-Path $DataRoot 'logs'
New-Item -ItemType Directory -Force -Path $DataRoot, $LogDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir 'setup.log') -Append | Out-Null

try {
  $PgBin = Join-Path $InstallDir 'pgsql\bin'
  $PgData = Join-Path $DataRoot 'pgdata'
  $ServiceDir = Join-Path $DataRoot 'service'
  $EnvFile = Join-Path $DataRoot 'tohyee.env'
  $NodeExe = Join-Path $InstallDir 'node\node.exe'
  $AppDir = Join-Path $InstallDir 'app'
  $CloudflaredExe = Join-Path $InstallDir 'cloudflared\cloudflared.exe'

  function New-Secret([int]$Length) {
    $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    $bytes = New-Object byte[] $Length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    return -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
  }

  function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$([System.IO.Path]::GetFileName($Exe)) $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
  }

  # Only Administrators and SYSTEM can read a file or folder (it holds passwords).
  # Inheritance flags only apply to folders; on a file they'd lock everyone out.
  function Protect-Path([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Container) {
      $grants = @('*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F')
    } else {
      $grants = @('*S-1-5-32-544:F', '*S-1-5-18:F')
    }
    Invoke-Checked 'icacls.exe' (@($Path, '/inheritance:r', '/grant:r') + $grants + @('/Q'))
  }

  # --- Settings and passwords -------------------------------------------------
  $settings = [ordered]@{}
  if (Test-Path $EnvFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
    }
    Write-Host 'Keeping existing settings and passwords.'
  }
  $firstInstall = -not $settings.Contains('POSTGRES_PASSWORD')
  if ($firstInstall) {
    if (Test-Path (Join-Path $PgData 'PG_VERSION')) {
      throw "$PgData already has a database but $EnvFile has no password. Restore tohyee.env from a backup rather than reinstalling over it."
    }
    $settings['POSTGRES_PASSWORD'] = New-Secret 32
    $settings['SETUP_TOKEN'] = New-Secret 32
  }
  # Encrypts bank feed tokens. Added on upgrade too; changing it later makes saved tokens unreadable.
  if (-not $settings.Contains('TOHYEE_SECRET_KEY')) { $settings['TOHYEE_SECRET_KEY'] = New-Secret 48 }
  foreach ($default in @(@('TOHYEE_PORT', '3000'), @('TOHYEE_LISTEN', '127.0.0.1'), @('POSTGRES_PORT', '5433'))) {
    if (-not $settings.Contains($default[0])) { $settings[$default[0]] = $default[1] }
  }
  # Server settings: 127.0.0.1 only, used by the Tohyee server app (tray icon).
  if (-not $settings.Contains('TOHYEE_ADMIN_PORT')) { $settings['TOHYEE_ADMIN_PORT'] = [string]([int]$settings['TOHYEE_PORT'] + 1) }
  $lines = @('# Tohyee settings. Keep this file private and keep a copy with your backups:',
    '# it holds the database password, and a new one will not open your existing data.',
    '# After changing TOHYEE_PORT or TOHYEE_LISTEN, run the Tohyee setup again (Repair).')
  foreach ($key in $settings.Keys) { $lines += "$key=$($settings[$key])" }
  [System.IO.File]::WriteAllLines($EnvFile, [string[]]$lines)
  Protect-Path $EnvFile
  # Where the tray app finds Tohyee: ports only, nothing secret, readable by everyone.
  [System.IO.File]::WriteAllLines((Join-Path $DataRoot 'tray.ini'), [string[]]@(
    '# Written by the Tohyee installer for the tray app. Change the ports in tohyee.env instead.',
    "PORT=$($settings['TOHYEE_PORT'])",
    "ADMIN_PORT=$($settings['TOHYEE_ADMIN_PORT'])"))

  $pgPort = $settings['POSTGRES_PORT']
  $env:PGPASSWORD = $settings['POSTGRES_PASSWORD']

  # --- PostgreSQL ----------------------------------------------------------------
  if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) {
    Write-Host 'Creating the database cluster.'
    $pwFile = Join-Path $env:TEMP "tohyee-pw-$([guid]::NewGuid()).txt"
    [System.IO.File]::WriteAllText($pwFile, $settings['POSTGRES_PASSWORD'])
    try {
      Invoke-Checked (Join-Path $PgBin 'initdb.exe') @('-D', $PgData, '-U', 'tohyee', "--pwfile=$pwFile", '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256')
    } finally {
      Remove-Item -Force $pwFile -ErrorAction SilentlyContinue
    }
    Add-Content -Path (Join-Path $PgData 'postgresql.conf') -Encoding ascii -Value @(
      '', '# Tohyee', "listen_addresses = 'localhost'", "port = $pgPort")
  }
  # The database service runs as Network Service, which needs the data folder.
  Invoke-Checked 'icacls.exe' @($PgData, '/grant', '*S-1-5-20:(OI)(CI)F', '/T', '/Q')

  if (-not (Get-Service -Name 'TohyeePostgres' -ErrorAction SilentlyContinue)) {
    Write-Host 'Registering the TohyeePostgres service.'
    Invoke-Checked (Join-Path $PgBin 'pg_ctl.exe') @('register', '-N', 'TohyeePostgres', '-U', 'NT AUTHORITY\NetworkService', '-D', $PgData, '-S', 'auto', '-w')
  }
  Set-Service -Name 'TohyeePostgres' -StartupType Automatic
  if ((Get-Service 'TohyeePostgres').Status -ne 'Running') { Start-Service 'TohyeePostgres' }

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    & (Join-Path $PgBin 'pg_isready.exe') -h localhost -p $pgPort -U tohyee | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'PostgreSQL did not start. See the log in pgdata\log.' }

  $psql = Join-Path $PgBin 'psql.exe'
  $exists = & $psql -h localhost -p $pgPort -U tohyee -d postgres -tAc "select 1 from pg_database where datname = 'tohyee'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect to PostgreSQL.' }
  if ("$exists".Trim() -ne '1') {
    Write-Host 'Creating the tohyee database.'
    Invoke-Checked $psql @('-h', 'localhost', '-p', $pgPort, '-U', 'tohyee', '-d', 'postgres', '-c', 'create database tohyee')
  }

  # --- Tohyee service (WinSW) ------------------------------------------------------
  New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null
  Protect-Path $ServiceDir
  $serviceExe = Join-Path $ServiceDir 'TohyeeServer.exe'
  if (Test-Path $serviceExe) {
    if (Get-Service -Name 'Tohyee' -ErrorAction SilentlyContinue) {
      & $serviceExe stop | Out-Null
      & $serviceExe uninstall | Out-Null
      Start-Sleep -Seconds 2
    }
  }
  Copy-Item -Force (Join-Path $InstallDir 'service\WinSW-x64.exe') $serviceExe

  function X([string]$Value) { return [System.Security.SecurityElement]::Escape($Value) }
  # Optional: another Tohyee address service (Phone access > Tohyee address), set in tohyee.env.
  $addressServiceEnv = ''
  if ($settings.Contains('TOHYEE_ADDRESS_SERVICE_URL') -and $settings['TOHYEE_ADDRESS_SERVICE_URL']) {
    $addressServiceEnv = "  <env name=""TOHYEE_ADDRESS_SERVICE_URL"" value=""$(X $settings['TOHYEE_ADDRESS_SERVICE_URL'])""/>`r`n"
  }

  $databaseUrl = "postgresql://tohyee:$($settings['POSTGRES_PASSWORD'])@localhost:$pgPort/tohyee"
  $xml = @"
<service>
  <id>Tohyee</id>
  <name>Tohyee</name>
  <description>Tohyee accounting server (http://localhost:$(X $settings['TOHYEE_PORT']))</description>
  <executable>$(X $NodeExe)</executable>
  <arguments>server.js</arguments>
  <workingdirectory>$(X $AppDir)</workingdirectory>
  <startmode>Automatic</startmode>
  <depend>TohyeePostgres</depend>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$(X $LogDir)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <env name="NODE_ENV" value="production"/>
  <env name="NEXT_TELEMETRY_DISABLED" value="1"/>
  <env name="PORT" value="$(X $settings['TOHYEE_PORT'])"/>
  <env name="HOSTNAME" value="$(X $settings['TOHYEE_LISTEN'])"/>
  <env name="TOHYEE_ADMIN_PORT" value="$(X $settings['TOHYEE_ADMIN_PORT'])"/>
  <env name="DATABASE_URL" value="$(X $databaseUrl)"/>
  <env name="SETUP_TOKEN" value="$(X $settings['SETUP_TOKEN'])"/>
  <env name="TOHYEE_SECRET_KEY" value="$(X $settings['TOHYEE_SECRET_KEY'])"/>
  <env name="TOHYEE_TIME_ZONE" value="Pacific/Auckland"/>
  <env name="TOHYEE_CLOUDFLARED_PATH" value="$(X $CloudflaredExe)"/>
  <env name="TOHYEE_PG_BIN" value="$(X $PgBin)"/>
  <env name="TOHYEE_BACKUP_DIR" value="$(X (Join-Path $DataRoot 'backups'))"/>
$addressServiceEnv</service>
"@
  [System.IO.File]::WriteAllText((Join-Path $ServiceDir 'TohyeeServer.xml'), $xml)

  Write-Host 'Installing and starting the Tohyee service.'
  Invoke-Checked $serviceExe @('install')
  Invoke-Checked 'sc.exe' @('config', 'Tohyee', 'start=', 'delayed-auto')
  Invoke-Checked $serviceExe @('start')

  $url = "http://localhost:$($settings['TOHYEE_PORT'])"
  $ready = $false
  for ($i = 0; $i -lt 90; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw "Tohyee did not answer at $url within 3 minutes. See $LogDir." }
  Write-Host "Tohyee is running at $url"

  # Tells the installer's last page what to show.
  $status = if ($firstInstall) { "first-install`r`n$($settings['SETUP_TOKEN'])`r`n$url" } else { "update`r`n`r`n$url" }
  if ($ResultFile) { [System.IO.File]::WriteAllText($ResultFile, $status) }
  exit 0
} catch {
  Write-Host "SETUP FAILED: $($_.Exception.Message)"
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
