# Installs the freshly built TohyeeSetup on this (throwaway CI) Windows
# machine and checks it end to end: services, health, first-time setup
# (including two-step sign-in), creating an organisation, surviving a service
# restart, updating in place (signing in with a backup code), the bundled
# cloudflared, and uninstalling. Needs Administrator (GitHub's Windows runners are).

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
  if ($second['POSTGRES_PASSWORD'] -ne $first['POSTGRES_PASSWORD']) { throw 'The update changed the database password.' }
  $login = @{ email = 'ci@example.com'; password = 'ci-password-long-enough-123' } | ConvertTo-Json
  $again = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $signedIn = Invoke-RestMethod -Uri "$url/api/auth/login" -Method Post -ContentType 'application/json' -Headers $origin -Body $login -WebSession $again
  if ($signedIn.stage -ne 'verify') { throw "Expected a two-step code after the password, got stage '$($signedIn.stage)'." }
  # A backup code, so this doesn't depend on waiting for a new authenticator code.
  $backup = @{ code = $enrolled.backupCodes[0] } | ConvertTo-Json
  Invoke-RestMethod -Uri "$url/api/auth/two-step/verify" -Method Post -ContentType 'application/json' -Headers $origin -Body $backup -WebSession $again | Out-Null
  $me = Invoke-RestMethod -Uri "$url/api/auth/session" -WebSession $again
  if ($me.organisations.Count -ne 1) { throw 'The organisation was not there after the update.' }
  Write-Host 'Signed in (password and backup code) after the update: data kept.'
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
