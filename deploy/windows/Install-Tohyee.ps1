# Installs or updates Tohyee with Docker Desktop, and starts it.
# Run it by double-clicking Install-Tohyee.cmd in the same folder.
#
# First run: creates random passwords in %LOCALAPPDATA%\Tohyee\tohyee.env,
# downloads Tohyee and PostgreSQL, starts them and opens first-time setup.
# Later runs (e.g. from a newer release's folder): keep your passwords and
# data, switch to this release's version and restart.

$ErrorActionPreference = 'Stop'
$TohyeeVersion = '__TOHYEE_VERSION__'

$ComposeFile = Join-Path $PSScriptRoot 'docker-compose.yml'
$SettingsDir = Join-Path $env:LOCALAPPDATA 'Tohyee'
$EnvFile = Join-Path $SettingsDir 'tohyee.env'

function Write-Step([string]$Message) {
  Write-Host ''
  Write-Host "== $Message" -ForegroundColor Cyan
}

function Stop-WithMessage([string]$Message) {
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  exit 1
}

function New-Secret([int]$Length) {
  # Letters and digits only, so they can go in a database URL as they are.
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  return -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Read-EnvFile([string]$Path) {
  $values = [ordered]@{}
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $values[$Matches[1]] = $Matches[2]
    }
  }
  return $values
}

function Write-EnvFile([string]$Path, $Values) {
  $lines = @('# Tohyee settings, created by Install-Tohyee. Keep this file safe and private:',
    '# it holds the database password. Losing it means losing access to your data.')
  foreach ($key in $Values.Keys) {
    $lines += "$key=$($Values[$key])"
  }
  # UTF-8 without a byte order mark, which Docker Compose reads cleanly.
  [System.IO.File]::WriteAllLines($Path, [string[]]$lines)
}

function Invoke-Compose([string[]]$Arguments) {
  & docker compose --file $ComposeFile --env-file $EnvFile @Arguments
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "docker compose $($Arguments -join ' ') failed. See the messages above."
  }
}

if ($TohyeeVersion -like '__*') {
  Stop-WithMessage 'This copy of the installer has no version. Download the Windows zip from a Tohyee release.'
}

Write-Step 'Checking Docker Desktop'
$null = & docker version --format '{{.Server.Version}}' 2>&1
if ($LASTEXITCODE -ne 0) {
  Stop-WithMessage ("Docker Desktop isn't running (or isn't installed).`n" +
    "Install it from https://www.docker.com/products/docker-desktop/, start it, wait until it says " +
    "it's running, then run Install-Tohyee.cmd again.")
}
$null = & docker compose version 2>&1
if ($LASTEXITCODE -ne 0) {
  Stop-WithMessage 'Docker Compose is missing. Update Docker Desktop and try again.'
}

Write-Step "Preparing settings in $SettingsDir"
New-Item -ItemType Directory -Force -Path $SettingsDir | Out-Null
$firstInstall = -not (Test-Path $EnvFile)
if ($firstInstall) {
  $settings = [ordered]@{
    POSTGRES_PASSWORD = New-Secret 32
    SETUP_TOKEN       = New-Secret 32
    TOHYEE_PORT       = '3000'
    TOHYEE_LISTEN     = '127.0.0.1'
    TOHYEE_VERSION    = $TohyeeVersion
  }
  Write-Host 'Created new passwords.'
} else {
  $settings = Read-EnvFile $EnvFile
  if (-not $settings.Contains('POSTGRES_PASSWORD')) {
    Stop-WithMessage "$EnvFile has no POSTGRES_PASSWORD. Restore it from a copy rather than deleting it."
  }
  $previous = $settings['TOHYEE_VERSION']
  $settings['TOHYEE_VERSION'] = $TohyeeVersion
  Write-Host "Kept your existing passwords. Version: $previous -> $TohyeeVersion"
}
# Encrypts bank feed tokens. Added on upgrade too; changing it later makes saved tokens unreadable.
if (-not $settings.Contains('TOHYEE_SECRET_KEY')) { $settings['TOHYEE_SECRET_KEY'] = New-Secret 48 }
Write-EnvFile $EnvFile $settings
$port = if ($settings.Contains('TOHYEE_PORT')) { $settings['TOHYEE_PORT'] } else { '3000' }

Write-Step "Downloading Tohyee $TohyeeVersion and PostgreSQL (the first time can take a few minutes)"
Invoke-Compose @('pull')

Write-Step 'Starting Tohyee'
Invoke-Compose @('up', '--detach', '--remove-orphans')

Write-Step 'Waiting for Tohyee to be ready'
$url = "http://localhost:$port"
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  try {
    $response = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $ready) {
  Write-Host 'Recent messages from Tohyee:'
  & docker compose --file $ComposeFile --env-file $EnvFile logs --tail 40 tohyee
  Stop-WithMessage "Tohyee didn't start within 3 minutes. The messages above should say why."
}

Write-Host ''
Write-Host "Tohyee $TohyeeVersion is running at $url" -ForegroundColor Green

$autoStartOff = $false
foreach ($name in @('settings-store.json', 'settings.json')) {
  $path = Join-Path $env:APPDATA "Docker\$name"
  if (Test-Path $path) {
    $text = [System.IO.File]::ReadAllText($path)
    if ($text -match '"[Aa]uto[Ss]tart"\s*:\s*false') { $autoStartOff = $true }
  }
}
if ($autoStartOff) {
  Write-Host ''
  Write-Host ("Docker Desktop is set NOT to start when you sign in, so Tohyee won't come back after a restart.`n" +
    "Turn on Docker Desktop > Settings > General > 'Start Docker Desktop when you sign in to your computer'.") -ForegroundColor Yellow
} else {
  Write-Host ("It starts again by itself after a restart, once you sign in to Windows " +
    "(as long as Docker Desktop's 'Start Docker Desktop when you sign in' setting stays on).")
}

if ($firstInstall) {
  Write-Host ''
  Write-Host 'First-time setup: create the first server admin in the page that opens.' -ForegroundColor Green
  Write-Host "Setup token (also copied to the clipboard): $($settings['SETUP_TOKEN'])"
  try { Set-Clipboard -Value $settings['SETUP_TOKEN'] } catch { }
  Start-Process "$url/setup"
} else {
  Start-Process $url
}
