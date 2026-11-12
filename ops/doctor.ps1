# AegisForge one-shot health check ("doctor").
#
# Checks the live stack end to end and prints a per-item [OK]/[WARN]/[FAIL]
# report; exits non-zero only on FAIL. Read-only: never restarts or mutates
# anything. Use -Json for machine-readable output.
param([switch]$Json)

$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Generic.List[object]

function Check($name, $status, $detail) {
  $script:results.Add(@{ name = $name; status = $status; detail = $detail })
  if (-not $Json) { Write-Host "[$status] $name -- $detail" }
}

# 1) standalone toolbridge (:8901) -- registry reachable, tool count.
$bridge = $null
try {
  $bridge = Invoke-RestMethod -Uri 'http://127.0.0.1:8901/api/tools/registry' -TimeoutSec 5 -ErrorAction Stop
} catch { }
if ($bridge -and $bridge.tools) {
  $n = @($bridge.tools).Count
  if ($n -ge 20) { Check 'toolbridge.bridge' 'OK' "registry reachable, $n tools" }
  else { Check 'toolbridge.bridge' 'WARN' "registry reachable but only $n tools (expected >=20; rebuild cmd/flowdbridge)" }
} else {
  Check 'toolbridge.bridge' 'FAIL' 'unreachable on :8901 (start cmd/flowdbridge with AF_BRIDGE_ADDR=127.0.0.1:8901 AF_BRIDGE_DATA=<data>)'
}

# 2) pj_selftest round trip through the bridge.
if ($bridge) {
  try {
    $body = @{ tool = 'pj_selftest'; args = @{} } | ConvertTo-Json -Compress
    $st = Invoke-RestMethod -Uri 'http://127.0.0.1:8901/api/tools/invoke' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30 -ErrorAction Stop
    if ($st.content -match 'selftest: all green') { Check 'pjtools.selftest' 'OK' 'store/routing/patch paths all green' }
    else { Check 'pjtools.selftest' 'FAIL' ($st.content -split "`n" | Select-Object -Last 1) }
  } catch { Check 'pjtools.selftest' 'FAIL' "invoke failed: $_" }
}

# 3) flowd (:8899) -- health endpoint.
$flowd = $null
try { $flowd = Invoke-RestMethod -Uri 'http://127.0.0.1:8899/api/health' -TimeoutSec 5 -ErrorAction Stop } catch { }
if ($flowd -and $flowd.ok) { Check 'flowd.health' 'OK' "flowd up (dataDir=$($flowd.dataDir))" }
else { Check 'flowd.health' 'FAIL' 'unreachable on :8899 (start services/flowd: npm start)' }

# 4) flowd <- bridge attachment (env of the running flowd matters; probe via a registry hit).
if ($flowd) {
  Check 'flowd.toolbridge' 'INFO' 'attached when flowd was started with AF_TOOLS_BRIDGE_URL=http://127.0.0.1:8901'
}

# 5) router regression through the real Go matcher.
Push-Location (Join-Path $PSScriptRoot '..')
& go test ./pkg/pjtools/ -run 'TestUnirevRouteTest|TestRoutingConsistency' -count=1 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Check 'unirev.routing' 'OK' 'vendored testdata green' }
else { Check 'unirev.routing' 'FAIL' 'route-test failed (go test ./pkg/pjtools/)' }
Pop-Location

# 6) Go toolchain + full pjtools/toolbridge unit tests.
Push-Location (Join-Path $PSScriptRoot '..')
& go build ./pkg/pjtools/ ./pkg/toolbridge/ ./cmd/flowdbridge/ 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Check 'go.build' 'OK' 'pjtools/toolbridge/flowdbridge compile' }
else { Check 'go.build' 'FAIL' 'go build failed' }
& go test -count=1 ./pkg/pjtools/ ./pkg/toolbridge/ 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Check 'go.tests' 'OK' 'unit tests green' }
else { Check 'go.tests' 'FAIL' 'unit tests failing' }
Pop-Location

# 7) unirev module installer doctor (optional components are WARNs there).
$unirev = Join-Path $PSScriptRoot 'install-unirev.ps1'
if (Test-Path $unirev) {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $unirev -Action doctor 2>&1
  $fails = @($out | Where-Object { $_ -match '^\[FAIL\]' })
  if ($fails.Count -eq 0) { Check 'unirev.installer' 'OK' 'no FAIL lines (optional externals may WARN)' }
  else { Check 'unirev.installer' 'FAIL' ($fails -join '; ') }
}

# 8) flowd unit tests.
Push-Location (Join-Path $PSScriptRoot '..\services\flowd')
& npx tsc --noEmit 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Check 'flowd.typecheck' 'OK' 'tsc clean' }
else { Check 'flowd.typecheck' 'FAIL' 'tsc errors' }
Pop-Location

# 9) notifications configured? (informational)
if ($env:AF_NOTIFY_WEBHOOK -or $env:AF_NOTIFY_DINGTALK -or $env:AF_NOTIFY_FEISHU -or $env:AF_NOTIFY_TELEGRAM -or $env:AF_NOTIFY_SMTP_HOST) {
  Check 'notify.config' 'OK' 'notification channel env present'
} else {
  Check 'notify.config' 'INFO' 'no AF_NOTIFY_* env set -- run completion notices stay local-only'
}

# 10) profiles file present? (informational)
$profiles = Join-Path $PSScriptRoot '..\data\flowd\llm_profiles.json'
if (Test-Path $profiles) { Check 'llm.profiles' 'OK' "profiles file present: $profiles" }
else { Check 'llm.profiles' 'INFO' "no profiles file (flowd uses built-in model); create $profiles" }

# 11) approvals center reachable? (informational; live only when flowd has AF_APPROVALS=1)
if ($flowd) {
  $appr = $null
  try { $appr = Invoke-RestMethod -Uri 'http://127.0.0.1:8899/api/approvals/pending' -TimeoutSec 5 -ErrorAction Stop } catch { }
  if ($appr -and $appr.enabled) {
    $n = @($appr.pending).Count
    Check 'flowd.approvals' 'OK' "approvals enabled, $n pending"
  } else {
    Check 'flowd.approvals' 'INFO' 'approvals disabled (start flowd with AF_APPROVALS=1 to gate side-effect tools)'
  }
}

# 12) mirror target configured? (informational; Go side refuses without ARTEX_MIRROR_TOKEN)
if ($env:AF_MIRROR_URL) {
  Check 'mirror.config' 'OK' "AF_MIRROR_URL=$($env:AF_MIRROR_URL) (Go side needs ARTEX_MIRROR_TOKEN)"
} else {
  Check 'mirror.config' 'INFO' 'AF_MIRROR_URL unset -- run terminal mirror stays off (standalone default)'
}

# 13) Go base server (artex on :8787) -- the backend behind the web /api proxy.
$artex = $null
try { $artex = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 5 -ErrorAction Stop } catch { }
if ($artex -and $artex.ok) { Check 'artex.health' 'OK' 'Go base server up on :8787 (web /api proxy target)' }
else { Check 'artex.health' 'FAIL' 'unreachable on :8787 -- web /api/* rewrites 500 (run ops/start-artex.ps1)' }

# 14) PostgreSQL service (artex hard-depends on it).
$pgsvc = Get-Service | Where-Object { $_.Name -match 'postgresql' } | Select-Object -First 1
if ($pgsvc -and $pgsvc.Status -eq 'Running') { Check 'postgres.service' 'OK' "$($pgsvc.Name) running" }
elseif ($pgsvc) { Check 'postgres.service' 'FAIL' "$($pgsvc.Name) installed but $($pgsvc.Status)" }
else { Check 'postgres.service' 'FAIL' 'no PostgreSQL service (winget install PostgreSQL.PostgreSQL.16)' }

if ($Json) {
  $results | ConvertTo-Json -Depth 3
} else {
  $fails = @($results | Where-Object { $_.status -eq 'FAIL' }).Count
  Write-Host ''
  if ($fails -gt 0) { Write-Host "=== doctor: $fails FAILURES ==="; exit 1 }
  Write-Host '=== doctor: ALL READY ==='
}
