# Backs up every Tohyee database (the core database and each organisation)
# to one file in Documents\Tohyee backups. Started from the Start menu
# ("Back up Tohyee"); asks for Administrator permission because the database
# password is only readable by Administrators.

param([string]$BackupDir = '')

$ErrorActionPreference = 'Stop'
if (-not $BackupDir) {
  $BackupDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Tohyee backups'
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  # Run again as Administrator, keeping this user's Documents folder as the target.
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-BackupDir', "`"$BackupDir`"")
  exit 0
}

try {
  $installDir = Split-Path -Parent $PSScriptRoot
  $pgDumpAll = Join-Path $installDir 'pgsql\bin\pg_dumpall.exe'
  $envFile = Join-Path $env:ProgramData 'Tohyee\tohyee.env'
  $settings = @{}
  foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
  }
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  $target = Join-Path $BackupDir ("tohyee-{0}.sql" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))

  $env:PGPASSWORD = $settings['POSTGRES_PASSWORD']
  & $pgDumpAll -h localhost -p $settings['POSTGRES_PORT'] -U tohyee --clean --if-exists -f $target
  if ($LASTEXITCODE -ne 0) { throw "pg_dumpall failed (exit code $LASTEXITCODE). Is the TohyeePostgres service running?" }

  $size = [math]::Round((Get-Item $target).Length / 1MB, 2)
  Write-Host "Backed up to $target ($size MB)." -ForegroundColor Green
  Write-Host 'Copy it somewhere off this computer too (a USB drive or cloud storage).'
  Start-Process explorer.exe "/select,`"$target`""
} catch {
  Write-Host "The backup failed: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ''
Read-Host 'Press Enter to close'
