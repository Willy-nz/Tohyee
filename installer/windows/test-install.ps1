# Installs the freshly built TohyeeSetup on this (throwaway CI) Windows
# machine and checks it end to end: services, health, first-time setup,
# creating an organisation, surviving a service restart, updating in place
# and uninstalling. Needs Administrator (GitHub's Windows runners are).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $root 'dist\windows'
$setup = Get-ChildItem (Join-Path $out 'TohyeeSetup-*.exe') | Select-Object -First 1
$dataRoot = Join-Path $env:ProgramData 'Tohyee'
$installDir = Join-Path $env:ProgramFiles 'Tohyee'
$url = 'http://localhost:3000'
$origin = @{ Origin = $url }

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
}

try {
  Install-Tohyee 'first'
  Assert-Services
  Wait-Healthy
  $first = Read-Settings

  Write-Host '== First-time setup and an organisation'
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $body = @{ setupToken = $first['SETUP_TOKEN']; email = 'ci@example.com'; displayName = 'CI'; password = 'ci-password-long-enough-123' } | ConvertTo-Json
  Invoke-RestMethod -Uri "$url/api/auth/setup" -Method Post -ContentType 'application/json' -Headers $origin -Body $body -WebSession $session | Out-Null
  $org = @{ id = 'ci'; displayName = 'CI Ltd'; baseCurrency = 'NZD'; ownerEmail = 'ci@example.com' } | ConvertTo-Json
  $created = Invoke-RestMethod -Uri "$url/api/admin/organisations" -Method Post -ContentType 'application/json' -Headers $origin -Body $org -WebSession $session
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
  Invoke-RestMethod -Uri "$url/api/auth/login" -Method Post -ContentType 'application/json' -Headers $origin -Body $login | Out-Null
  Write-Host 'Signed in after the update: data kept.'

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
