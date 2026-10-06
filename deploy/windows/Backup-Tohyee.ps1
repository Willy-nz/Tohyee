# Backs up every Tohyee database (the core database and each organisation)
# to one file in Documents\Tohyee backups.
# Run it by double-clicking Backup-Tohyee.cmd in the same folder.

$ErrorActionPreference = 'Stop'

$ComposeFile = Join-Path $PSScriptRoot 'docker-compose.yml'
$EnvFile = Join-Path (Join-Path $env:LOCALAPPDATA 'Tohyee') 'tohyee.env'
$BackupDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Tohyee backups'

if (-not (Test-Path $EnvFile)) {
  Write-Host "No Tohyee settings found at $EnvFile. Run Install-Tohyee.cmd first." -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$target = Join-Path $BackupDir "tohyee-$stamp.sql"
$inside = '/tmp/tohyee-backup.sql'

& docker compose --file $ComposeFile --env-file $EnvFile exec -T postgres pg_dumpall -U tohyee --clean --if-exists -f $inside
if ($LASTEXITCODE -ne 0) {
  Write-Host 'The backup failed. Is Tohyee running? See the messages above.' -ForegroundColor Red
  exit 1
}
& docker compose --file $ComposeFile --env-file $EnvFile cp "postgres:$inside" $target
$copied = $LASTEXITCODE
& docker compose --file $ComposeFile --env-file $EnvFile exec -T postgres rm -f $inside | Out-Null
if ($copied -ne 0) {
  Write-Host 'Copying the backup out of Docker failed. See the messages above.' -ForegroundColor Red
  exit 1
}

$size = [math]::Round((Get-Item $target).Length / 1MB, 2)
Write-Host "Backed up to $target ($size MB)." -ForegroundColor Green
Write-Host 'This file is NOT encrypted: anyone who can open it can read all your books.' -ForegroundColor Yellow
Write-Host 'Keep it out of OneDrive and other synced folders, copy it somewhere private, then delete it here.'
Write-Host 'The nightly backups are encrypted; see BACKUPS in README.txt.'
