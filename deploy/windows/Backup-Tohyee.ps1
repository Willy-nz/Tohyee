# Backs up Tohyee now: the same encrypted backup as the nightly one (each
# organisation and the server's own database), made by Tohyee itself with
# its command-line tool. The files go in the backup folder (see README.txt).
# Run it by double-clicking Backup-Tohyee.cmd in the same folder.

$ErrorActionPreference = 'Stop'

$ComposeFile = Join-Path $PSScriptRoot 'docker-compose.yml'
$EnvFile = Join-Path (Join-Path $env:LOCALAPPDATA 'Tohyee') 'tohyee.env'

if (-not (Test-Path $EnvFile)) {
  Write-Host "No Tohyee settings found at $EnvFile. Run Install-Tohyee.cmd first." -ForegroundColor Red
  exit 1
}

# Where /backups (inside Docker) is on this computer: TOHYEE_BACKUP_FOLDER
# from tohyee.env, or the backups folder next to this script.
$BackupFolder = Join-Path $PSScriptRoot 'backups'
foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
  if ($line -match '^\s*TOHYEE_BACKUP_FOLDER=(.+)$') { $BackupFolder = $Matches[1].Trim() }
}

& docker compose --file $ComposeFile --env-file $EnvFile exec -T tohyee node tohyee-admin.cjs backups run
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'The backup failed. Is Tohyee running? See the messages above.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'Backed up. The files are encrypted with the backup key.' -ForegroundColor Green
Write-Host "/backups above is $BackupFolder on this computer (unless the backup folder was changed in Tohyee's backup settings)."
Write-Host 'Copy that folder somewhere off this computer too (a USB drive or cloud storage), and keep the backup key somewhere else.'
