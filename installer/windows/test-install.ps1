# Installs the freshly built TohyeeSetup on this (throwaway CI) Windows
# machine and checks it end to end: services, health, first-time setup
# (including two-step sign-in), creating an organisation, the Tohyee server
# app (tray) reaching its server settings, surviving a service
# restart, updating in place (signing in with a backup code), the bundled
# cloudflared, an analytics CSV load through the installed DuckDB, and
# uninstalling. Needs Administrator (GitHub's Windows runners are).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $root 'dist\windows'
$setup = Get-ChildItem (Join-Path $out 'TohyeeSetup-*.exe') | Select-Object -First 1
$dataRoot = Join-Path $env:ProgramData 'Tohyee'
$installDir = Join-Path $env:ProgramFiles 'Tohyee'
$url = 'http://localhost:3000'
$origin = @{ Origin = $url }
# Server settings: this computer only, on the main port + 1.
$adminUrl = 'http://localhost:3001'
$adminOrigin = @{ Origin = $adminUrl }

# Authenticator code (RFC 6238) for the two-step sign-in check.
function Get-TotpCode([string]$Secret, [long]$UnixSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) {
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  $key = New-Object System.Collections.Generic.List[byte]
  [long]$buffer = 0
  $bits = 0
  foreach ($char in $Secret.ToUpperInvariant().Replace(' ', '').ToCharArray()) {
    $buffer = (($buffer -shl 5) -bor $alphabet.IndexOf($char)) -band 0xFFFF
    $bits += 5
    if ($bits -ge 8) {
      $key.Add([byte](($buffer -shr ($bits - 8)) -band 255))
      $bits -= 8
    }
  }
  $counter = [BitConverter]::GetBytes([long][Math]::Floor($UnixSeconds / 30.0))
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($counter) }
  $hmac = New-Object System.Security.Cryptography.HMACSHA1 (, $key.ToArray())
  $hash = $hmac.ComputeHash($counter)
  $offset = $hash[$hash.Length - 1] -band 0x0f
  $binary = (([long]$hash[$offset] -band 0x7f) -shl 24) -bor ([long]$hash[$offset + 1] -shl 16) -bor ([long]$hash[$offset + 2] -shl 8) -bor [long]$hash[$offset + 3]
  return ($binary % 1000000).ToString('000000')
}

function Install-Tohyee([string]$Label) {
  Write-Host "== Install ($Label)"
  $log = Join-Path $out "install-$Label.log"
  $process = Start-Process -FilePath $setup.FullName -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$log`"") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Setup exited with $($process.ExitCode)" }
}

function Wait-Healthy {
  for ($i = 0; $i -lt 90; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { Write-Host "Healthy: $($response.Content)"; return }
    } catch { }
    Start-Sleep -Seconds 2
  }
  throw 'Tohyee did not become healthy.'
}

function Assert-Services {
  foreach ($name in @('TohyeePostgres', 'Tohyee')) {
    $service = Get-Service -Name $name
    Write-Host "$name : $($service.Status), $($service.StartType)"
    if ($service.Status -ne 'Running') { throw "$name isn't running" }
    if ($service.StartType -ne 'Automatic') { throw "$name doesn't start automatically" }
  }
}

function Read-Settings {
  $settings = @{}
  foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $dataRoot 'tohyee.env'))) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
  }
  return $settings
}

# Issue #152: Tohyee uses ordinary database logins, and local users can't read its data.
function Assert-LeastPrivilege($Settings) {
  Write-Host '== Database logins and data folder permissions (#152)'
  $serviceConfig = [xml](Get-Content (Join-Path $dataRoot 'service\TohyeeServer.xml') -Raw)
  $runtimeUrl = ($serviceConfig.service.env | Where-Object name -eq 'DATABASE_URL').value
  $adminDbUrl = ($serviceConfig.service.env | Where-Object name -eq 'DATABASE_ADMIN_URL').value
  if (-not $runtimeUrl.StartsWith('postgresql://tohyee_app:')) { throw 'DATABASE_URL does not use the tohyee_app login.' }
  if (-not $adminDbUrl.StartsWith('postgresql://tohyee_admin:')) { throw 'DATABASE_ADMIN_URL does not use the tohyee_admin login.' }

  $psql = Join-Path $installDir 'pgsql\bin\psql.exe'
  $env:PGPASSWORD = $Settings['POSTGRES_PASSWORD']
  try {
    $roles = & $psql -h localhost -p $Settings['POSTGRES_PORT'] -U tohyee -d postgres -tAc "select rolname || ':' || rolsuper || ':' || rolcreatedb from pg_roles where rolname in ('tohyee_admin', 'tohyee_app') order by rolname"
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the database logins.' }
    $roles = @($roles | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    Write-Host "Logins: $($roles -join ', ')"
    if (($roles -join ',') -ne 'tohyee_admin:false:true,tohyee_app:false:false') { throw "Unexpected database logins: $($roles -join ', ')" }
    $owners = & $psql -h localhost -p $Settings['POSTGRES_PORT'] -U tohyee -d postgres -tAc "select distinct pg_get_userbyid(datdba) from pg_database where datname = 'tohyee' or datname like 'tohyee\_org\_%'"
    $owners = @($owners | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    if (($owners -join ',') -ne 'tohyee_admin') { throw "Tohyee's databases should all belong to tohyee_admin, not: $($owners -join ', ')" }
  } finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  }

  # Users (S-1-5-32-545), Authenticated Users (S-1-5-11) and Everyone (S-1-1-0).
  $everyone = @('S-1-5-32-545', 'S-1-5-11', 'S-1-1-0')
  foreach ($path in @($dataRoot, (Join-Path $dataRoot 'pgdata'), (Join-Path $dataRoot 'pgdata\base'), (Join-Path $dataRoot 'analytics'),
      (Join-Path $dataRoot 'backups'), (Join-Path $dataRoot 'logs'), (Join-Path $dataRoot 'tohyee.env'), (Join-Path $dataRoot 'service'))) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $acl = Get-Acl -LiteralPath $path
    $sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })
    $open = @($sids | Where-Object { $everyone -contains $_ })
    if ($open.Count -ne 0) { throw "$path can be opened by every local user ($($open -join ', '))." }
    $owner = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne 'S-1-5-32-544' -and $owner -ne 'S-1-5-18' -and $path -ne (Join-Path $dataRoot 'pgdata\base')) { throw "$path belongs to $($acl.Owner), not Administrators." }
  }
  $trayAcl = Get-Acl -LiteralPath (Join-Path $dataRoot 'tray.ini')
  $traySids = @($trayAcl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })
  if (-not ($traySids -contains 'S-1-5-32-545')) { throw 'tray.ini is no longer readable by the tray app.' }
  Write-Host 'Database logins and data folder permissions are as expected.'
}

function Show-Logs {
  Write-Host '== Logs'
  Get-ChildItem $out -Filter 'install-*.log' -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "--- $($_.Name)"; Get-Content $_.FullName -Tail 60 }
  Get-ChildItem (Join-Path $dataRoot 'logs') -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "--- $($_.Name)"; Get-Content $_.FullName -Tail 80 }
  Get-ChildItem (Join-Path $dataRoot 'pgdata\log') -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "--- pg $($_.Name)"; Get-Content $_.FullName -Tail 40 }
  Get-Service -Name 'Tohyee*' -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-Host
  & icacls.exe (Join-Path $dataRoot 'tohyee.env') | Out-Host
  & whoami.exe /groups | Select-String 'S-1-5-32-544|Mandatory Label' | Out-Host
}

try {
  Install-Tohyee 'first'
  Assert-Services
  Wait-Healthy
  $first = Read-Settings

  Write-Host '== First-time setup and an organisation'
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $body = @{ setupToken = $first['SETUP_TOKEN']; email = 'ci@example.com'; displayName = 'CI'; password = 'ci-password-long-enough-123' } | ConvertTo-Json
  $setupResult = Invoke-RestMethod -Uri "$url/api/auth/setup" -Method Post -ContentType 'application/json' -Headers $origin -Body $body -WebSession $session
  # The installer sets TOHYEE_SECRET_KEY, so two-step sign-in is required: set up an authenticator first.
  if (-not $first['TOHYEE_SECRET_KEY']) { throw 'The installer did not create TOHYEE_SECRET_KEY.' }
  if ($setupResult.stage -ne 'enrol') { throw "Expected to set up two-step sign-in after setup, got stage '$($setupResult.stage)'." }
  $enrolment = Invoke-RestMethod -Uri "$url/api/auth/two-step/enrol" -WebSession $session
  $confirm = @{ code = (Get-TotpCode $enrolment.secret) } | ConvertTo-Json
  $enrolled = Invoke-RestMethod -Uri "$url/api/auth/two-step/enrol" -Method Post -ContentType 'application/json' -Headers $origin -Body $confirm -WebSession $session
  if ($enrolled.backupCodes.Count -ne 10) { throw 'Two-step set-up did not return 10 backup codes.' }
  Write-Host 'Two-step sign-in set up.'
  $org = @{ id = 'ci'; displayName = 'CI Ltd'; baseCurrency = 'NZD'; ownerEmail = 'ci@example.com' } | ConvertTo-Json
  # Server settings answer only on the local server settings address, not the main one.
  $refused = $null
  try {
    Invoke-RestMethod -Uri "$url/api/admin/organisations" -Method Post -ContentType 'application/json' -Headers $origin -Body $org -WebSession $session | Out-Null
  } catch {
    $refused = [int]$_.Exception.Response.StatusCode
  }
  if ($refused -ne 403) { throw "Expected server settings to be refused on the main address (403), got '$refused'." }
  $created = Invoke-RestMethod -Uri "$adminUrl/api/admin/organisations" -Method Post -ContentType 'application/json' -Headers $adminOrigin -Body $org -WebSession $session
  Write-Host "Organisation: $($created.organisation.provisioningStatus), schema $($created.organisation.schemaVersion)"
  if ($created.organisation.provisioningStatus -ne 'ready') { throw 'The organisation was not provisioned.' }

  Write-Host '== Analytics (the installed DuckDB native library and a real CSV load)'
  $bindings = Join-Path $installDir 'app\node_modules\@duckdb\node-bindings-win32-x64'
  foreach ($nativeFile in @('duckdb.node', 'duckdb.dll')) {
    if (-not (Test-Path (Join-Path $bindings $nativeFile) -PathType Leaf)) { throw "$nativeFile was not installed." }
  }
  $enabled = Invoke-RestMethod -Uri "$url/api/organisations/ci/settings" -Method Patch -ContentType 'application/json' -Headers $origin -Body '{"analyticsEnabled":true}' -WebSession $session
  if ($enabled.settings.analyticsEnabled -ne $true) { throw 'Analytics was not enabled.' }
  $sourceFolder = Join-Path $dataRoot 'analytics-sources\ci'
  New-Item -ItemType Directory -Force -Path $sourceFolder | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $sourceFolder 'sales.csv'), "order_date,region,quantity,unit_price`n2025-01-05,Auckland,2,0.10`n2025-02-06,Otago,3,19.99`n")
  # Use the installed Node and admin tool with the service's actual database settings.
  $serviceConfig = [xml](Get-Content (Join-Path $dataRoot 'service\TohyeeServer.xml') -Raw)
  $previousDatabaseUrl = $env:DATABASE_URL
  $previousDatabaseAdminUrl = $env:DATABASE_ADMIN_URL
  $previousAnalyticsDir = $env:TOHYEE_ANALYTICS_DIR
  try {
    $env:DATABASE_URL = ($serviceConfig.service.env | Where-Object name -eq 'DATABASE_URL').value
    $env:DATABASE_ADMIN_URL = ($serviceConfig.service.env | Where-Object name -eq 'DATABASE_ADMIN_URL').value
    $env:TOHYEE_ANALYTICS_DIR = ($serviceConfig.service.env | Where-Object name -eq 'TOHYEE_ANALYTICS_DIR').value
    & (Join-Path $installDir 'node\node.exe') (Join-Path $installDir 'app\tohyee-admin.cjs') analytics folder --id ci --folder $sourceFolder
    if ($LASTEXITCODE -ne 0) { throw "Setting the analytics folder failed with exit code $LASTEXITCODE" }
  } finally {
    $env:DATABASE_URL = $previousDatabaseUrl
    $env:DATABASE_ADMIN_URL = $previousDatabaseAdminUrl
    $env:TOHYEE_ANALYTICS_DIR = $previousAnalyticsDir
  }
  $sourceBody = @{
    organisationId = 'ci'; name = 'Installed sales'; tableName = 'sales'; fileName = 'sales.csv'; reloadDaily = $false
    columns = @(
      @{ source = 'order_date'; name = 'order_date'; kind = 'date' },
      @{ source = 'region'; name = 'region'; kind = 'text' },
      @{ source = 'quantity'; name = 'quantity'; kind = 'quantity' },
      @{ source = 'unit_price'; name = 'unit_price'; kind = 'money' }
    )
  } | ConvertTo-Json -Depth 5
  $source = Invoke-RestMethod -Uri "$url/api/analytics/sources" -Method Post -ContentType 'application/json' -Headers $origin -Body $sourceBody -WebSession $session
  $loaded = Invoke-RestMethod -Uri "$url/api/analytics/sources/$($source.source.id)/load" -Method Post -ContentType 'application/json' -Headers $origin -Body '{"organisationId":"ci"}' -WebSession $session -TimeoutSec 120
  Write-Host "Installed DuckDB load: $($loaded.run.status), $($loaded.run.rowsLoaded) rows, $($loaded.run.milliseconds) ms"
  if ($loaded.run.status -ne 'ok' -or $loaded.run.rowsLoaded -ne 2) { throw "Installed DuckDB load failed: $($loaded.run.error)" }
  $analytics = Invoke-RestMethod -Uri "$url/api/analytics?organisationId=ci" -WebSession $session
  $savedRun = @($analytics.loads | Where-Object id -eq $loaded.run.id)[0]
  if ($savedRun.status -ne 'ok' -or $savedRun.rowsLoaded -ne 2) { throw 'The successful analytics load was not recorded.' }

  Write-Host '== Backups (the bundled pg_dump and pg_restore) and a restore as a copy'
  $backups = Invoke-RestMethod -Uri "$adminUrl/api/admin/backups" -Method Post -ContentType 'application/json' -Headers $adminOrigin -Body '{}' -WebSession $session -TimeoutSec 600
  $backups.runs | ForEach-Object { Write-Host "  $($_.organisationId): $($_.status) $($_.filePath) $($_.error)" }
  if (@($backups.runs | Where-Object { $_.status -ne 'ok' }).Count -ne 0 -or @($backups.runs).Count -ne 2) { throw 'The backups did not all succeed.' }
  $listed = Invoke-RestMethod -Uri "$adminUrl/api/admin/backups" -WebSession $session
  if ($listed.settings.folder -ne (Join-Path $dataRoot 'backups')) { throw "Unexpected backup folder $($listed.settings.folder)." }
  $ciFile = @($listed.files | Where-Object { $_.header.organisationId -eq 'ci' })[0].name
  $restoreBody = @{ file = $ciFile; id = 'ci-restored' } | ConvertTo-Json
  $restored = Invoke-RestMethod -Uri "$adminUrl/api/admin/backups/restore" -Method Post -ContentType 'application/json' -Headers $adminOrigin -Body $restoreBody -WebSession $session -TimeoutSec 600
  Write-Host "Restored: $($restored.organisation.id), $($restored.organisation.provisioningStatus)"
  if ($restored.organisation.provisioningStatus -ne 'ready') { throw 'The restored copy is not ready.' }

  Assert-LeastPrivilege $first

  Write-Host '== The Tohyee server app (tray icon and server settings)'
  $trayExe = Join-Path $installDir 'tray\TohyeeTray.exe'
  if (-not (Test-Path $trayExe)) { throw 'TohyeeTray.exe was not installed.' }
  $trayIni = Join-Path $dataRoot 'tray.ini'
  if (-not (Test-Path $trayIni)) { throw 'The installer did not write tray.ini.' }
  Get-Content $trayIni | Write-Host
  # Signs in (with the next authenticator code, since this one is used) and lists the organisations.
  $trayResult = Join-Path $env:TEMP 'tohyee-tray-self-test.txt'
  $env:TOHYEE_TRAY_TEST_EMAIL = 'ci@example.com'
  $env:TOHYEE_TRAY_TEST_PASSWORD = 'ci-password-long-enough-123'
  $env:TOHYEE_TRAY_TEST_CODE = Get-TotpCode $enrolment.secret ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 30)
  try {
    $tray = Start-Process -FilePath $trayExe -ArgumentList @('--self-test', "`"$trayResult`"") -Wait -PassThru
  } finally {
    Remove-Item Env:TOHYEE_TRAY_TEST_EMAIL, Env:TOHYEE_TRAY_TEST_PASSWORD, Env:TOHYEE_TRAY_TEST_CODE -ErrorAction SilentlyContinue
  }
  if (Test-Path $trayResult) { Get-Content $trayResult | Write-Host }
  if ($tray.ExitCode -ne 0) { throw "The Tohyee server app's self-test failed (exit code $($tray.ExitCode))." }

  Write-Host '== Restart both services (as after a reboot)'
  Stop-Service Tohyee
  Restart-Service TohyeePostgres
  Start-Service Tohyee
  Assert-Services
  Wait-Healthy

  Install-Tohyee 'update'
  Assert-Services
  Wait-Healthy
  $second = Read-Settings
  foreach ($name in @('POSTGRES_PASSWORD', 'TOHYEE_DB_ADMIN_PASSWORD', 'TOHYEE_DB_APP_PASSWORD')) {
    if ($second[$name] -ne $first[$name]) { throw "The update changed $name." }
  }
  Assert-LeastPrivilege $second
  $login = @{ email = 'ci@example.com'; password = 'ci-password-long-enough-123' } | ConvertTo-Json
  $again = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $signedIn = Invoke-RestMethod -Uri "$url/api/auth/login" -Method Post -ContentType 'application/json' -Headers $origin -Body $login -WebSession $again
  if ($signedIn.stage -ne 'verify') { throw "Expected a two-step code after the password, got stage '$($signedIn.stage)'." }
  # A backup code, so this doesn't depend on waiting for a new authenticator code.
  $backup = @{ code = $enrolled.backupCodes[0] } | ConvertTo-Json
  Invoke-RestMethod -Uri "$url/api/auth/two-step/verify" -Method Post -ContentType 'application/json' -Headers $origin -Body $backup -WebSession $again | Out-Null
  $me = Invoke-RestMethod -Uri "$url/api/auth/session" -WebSession $again
  # Both the organisation and its restored copy (from the backup test above) are kept.
  $ids = @($me.organisations | ForEach-Object { $_.id })
  if (-not ($ids -contains 'ci') -or -not ($ids -contains 'ci-restored')) { throw "The organisations were not there after the update (found: $($ids -join ', '))." }
  Write-Host 'Signed in (password and backup code) after the update: data kept.'

  Write-Host '== After the update: the start record (decision 330) and the stats (decision 332)'
  # The tray icon reads this without a sign-in, on the local address only.
  $status = Invoke-RestMethod -Uri "$adminUrl/api/updates/status"
  Write-Host "Running v$($status.currentVersion); last start v$($status.lastStart.version) after v$($status.lastStart.previousVersion), $($status.lastStart.organisationsChecked) organisations, $($status.lastStart.organisationsBlocked) blocked"
  if ($status.lastStart.version -ne $status.currentVersion) { throw 'The server did not record this start.' }
  if ($status.lastStart.organisationsBlocked -ne 0 -or $status.lastStart.organisationsChecked -lt 2) { throw 'The organisations did not all come up after the update.' }
  $stats = Invoke-RestMethod -Uri "$adminUrl/api/admin/stats" -WebSession $again
  Write-Host "Stats: $($stats.computer.cores) cores, $(@($stats.disks).Count) disk(s), PostgreSQL $($stats.postgresVersion)"
  if (-not $stats.computer.cores -or @($stats.disks).Count -lt 1) { throw 'The stats are missing the computer or its disks.' }
  $cloudflared = Join-Path $installDir 'cloudflared\cloudflared.exe'
  if (-not (Test-Path $cloudflared)) { throw 'cloudflared.exe was not installed.' }
  Write-Host (& $cloudflared --version)

  Write-Host '== Uninstall'
  Start-Process -FilePath (Join-Path $installDir 'unins000.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait
  for ($i = 0; $i -lt 60 -and (Test-Path (Join-Path $installDir 'unins000.exe')); $i++) { Start-Sleep -Seconds 2 }
  if (Get-Service -Name 'Tohyee', 'TohyeePostgres' -ErrorAction SilentlyContinue) { throw 'Services still exist after uninstalling.' }
  if (-not (Test-Path (Join-Path $dataRoot 'pgdata\PG_VERSION'))) { throw 'Uninstalling removed the data.' }
  Write-Host 'Uninstalled; services removed, data kept.'
} catch {
  Show-Logs
  throw
}
