# Stops and removes Tohyee's Windows services. Run by the uninstaller.
# Your data in %ProgramData%\Tohyee (database, settings, logs) is kept.

param(
  [Parameter(Mandatory = $true)][string]$InstallDir
)

$DataRoot = Join-Path $env:ProgramData 'Tohyee'
$serviceExe = Join-Path $DataRoot 'service\TohyeeServer.exe'

if (Get-Service -Name 'Tohyee' -ErrorAction SilentlyContinue) {
  if (Test-Path $serviceExe) {
    & $serviceExe stop | Out-Null
    & $serviceExe uninstall | Out-Null
  } else {
    Stop-Service -Name 'Tohyee' -Force -ErrorAction SilentlyContinue
    & sc.exe delete Tohyee | Out-Null
  }
}

if (Get-Service -Name 'TohyeePostgres' -ErrorAction SilentlyContinue) {
  Stop-Service -Name 'TohyeePostgres' -Force -ErrorAction SilentlyContinue
  $pgCtl = Join-Path $InstallDir 'pgsql\bin\pg_ctl.exe'
  if (Test-Path $pgCtl) {
    & $pgCtl unregister -N TohyeePostgres | Out-Null
  } else {
    & sc.exe delete TohyeePostgres | Out-Null
  }
}
exit 0
