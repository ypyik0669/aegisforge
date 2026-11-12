# Start the AegisForge Go base server (cmd/artex) on 127.0.0.1:8787.
#
# Prereq: the postgresql-artex Windows service (PostgreSQL 16, superuser
# password "artex" -- local dev only). The artex binary creates the "artex"
# database and applies db/schema.sql automatically on first start.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-artex.ps1
#        (idempotent: exits OK if something is already listening on 8787)
param(
  [string]$DataDir = 'C:\aegisforge\data\artex',
  [string]$Dsn = 'postgres://postgres:artex@127.0.0.1:5432/artex?sslmode=disable',
  [string]$Exe = 'C:\aegisforge\bin\artex.exe'
)

$ErrorActionPreference = 'Stop'

# 1) PostgreSQL service up?
$svc = Get-Service | Where-Object { $_.Name -match 'postgresql' } | Select-Object -First 1
if (-not $svc) { Write-Host '[FAIL] no PostgreSQL service found (winget install PostgreSQL.PostgreSQL.16)'; exit 1 }
if ($svc.Status -ne 'Running') {
  Write-Host "[..] starting service $($svc.Name)"
  Start-Service $svc.Name
}

# 2) already listening on 8787?
$conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Write-Host "[OK] port 8787 already served (pid $($conn.OwningProcess)) -- nothing to do"
  exit 0
}

# 3) binary present?
if (-not (Test-Path $Exe)) {
  Write-Host "[..] $Exe missing, building from cmd/artex"
  Push-Location (Join-Path $PSScriptRoot '..')
  & go build -o bin/artex.exe ./cmd/artex
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host '[FAIL] go build failed'; exit 1 }
  Pop-Location
}

# 4) launch detached with its own log
$log = Join-Path $DataDir 'artex.log'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$env:ARTEX_PG_DSN = $Dsn
$proc = Start-Process -FilePath $Exe -ArgumentList @('-addr', '127.0.0.1:8787', '-data', $DataDir) `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
Write-Host "[OK] artex starting (pid $($proc.Id), log $log)"

# 5) wait for health
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2 -ErrorAction Stop
    if ($h.ok) { Write-Host '[OK] http://127.0.0.1:8787/api/health -> ok'; exit 0 }
  } catch { }
}
Write-Host '[FAIL] health check timed out; see the log files in ' + $DataDir
exit 1
