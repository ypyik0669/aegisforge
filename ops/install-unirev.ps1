# AegisForge unirev module installer (idempotent).
#
# Borrowed pattern (engineering only, no upstream code): every mutating step is
# idempotent (skip when already done), backs up ~/.claude.json once before the
# first modification (.bak, kept as the known-good snapshot), and supports
# -Action restore to roll the registration back. Re-running is always safe.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/install-unirev.ps1                 # install (idempotent)
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/install-unirev.ps1 -Action doctor  # checks only
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/install-unirev.ps1 -Action restore # roll back ~/.claude.json
param([ValidateSet('install', 'doctor', 'restore')][string]$Action = 'install')

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot   # repo root (ops/ parent)
$claudeJson = "$env:USERPROFILE\.claude.json"
$claudeBak = "$claudeJson.aegisforge-unirev.bak"
$report = @()
function Note($status, $msg) { $script:report += "[$status] $msg"; Write-Host "[$status] $msg" }

if ($Action -eq 'restore') {
  if (-not (Test-Path $claudeBak)) { Note 'FAIL' "no backup at $claudeBak; nothing to restore"; exit 1 }
  Copy-Item $claudeBak $claudeJson -Force
  Note 'OK' "restored $claudeJson from $claudeBak"
  Write-Host ''; Write-Host '=== unirev restore report ==='; $report | ForEach-Object { Write-Host $_ }
  exit 0
}

$mutating = ($Action -eq 'install')

# 1) unirev reference tree (vendored asset: routing/testdata + skill docs).
$unirev = Join-Path $root 'reference/unirev'
if (Test-Path "$unirev/skills/unirev/references/routing.json") { Note 'OK' 'unirev reference tree present' }
else { Note 'FAIL' "unirev routing table missing at $unirev" }

# 2) Go router regression (the vendored 20 testdata cases run through the real Go router).
Push-Location $root
& go test ./pkg/pjtools/ -run 'TestUnirevRouteTest|TestRoutingConsistency' -count=1 2>&1 | Select-Object -Last 2 | ForEach-Object { Note 'INFO' "route-test: $_" }
Pop-Location
if ($LASTEXITCODE -eq 0) { Note 'OK' 'route-test green' } else { Note 'FAIL' 'route-test failed' }

# 3) rea-agents (>=6.8.0): probe ~/.claude.json registration first (nvm-safe), then npm global.
$rea = ''
try {
  if (Test-Path $claudeJson) {
    $raw = Get-Content $claudeJson -Raw
    $reaMjs = [regex]::Match($raw, '[A-Za-z]:\\\\[^"]*rea\.mjs').Value -replace '\\\\', '\'
    if (-not $reaMjs) { $reaMjs = [regex]::Match($raw, '[A-Za-z]:/[^"]*rea\.mjs').Value }
    if ($reaMjs) {
      $reaPkg = Join-Path (Split-Path -Parent $reaMjs) 'package.json'
      if (-not (Test-Path $reaPkg)) { $reaPkg = Join-Path (Split-Path -Parent (Split-Path -Parent $reaMjs)) 'package.json' }
      if (Test-Path $reaPkg) { $rea = (Get-Content $reaPkg -Raw | ConvertFrom-Json).version }
    }
  }
} catch { }
if (-not $rea) {
  $rea = & node -e "try{console.log(JSON.parse(require('child_process').execSync('npm ls -g rea-agents --json --depth=0').toString()).dependencies['rea-agents'].version)}catch(e){console.log('')}" 2>$null
}
if ($rea) {
  try {
    if ([version]$rea -ge [version]'6.8.0') { Note 'OK' "rea-agents $rea installed" }
    else { Note 'WARN' "rea-agents $rea < 6.8.0; run: npm i -g rea-agents" }
  } catch { Note 'WARN' "rea-agents version unparsable: '$rea'" }
} elseif ($mutating) {
  Note 'INFO' 'rea-agents not found; installing globally (idempotent)...'
  & npm install -g rea-agents
  if ($LASTEXITCODE -eq 0) { Note 'OK' 'rea-agents installed via npm install -g' }
  else { Note 'WARN' 'auto-install failed; run manually: npm install -g rea-agents' }
} else { Note 'WARN' 'rea-agents not found' }

# 4) craft-anything-cli.
$ca = @("$env:USERPROFILE\tools\craft-anything-bin\craft-anything-cli.exe",
  (Get-Command craft-anything-cli -ErrorAction SilentlyContinue).Source) |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($ca) { Note 'OK' "craft-anything-cli found: $ca" }
else { Note 'WARN' 'craft-anything-cli not found; download from https://github.com/storytold/craft-anything/releases' }

# 5) uv (reverse_lab_tools runtime). Falls back to the winget package dir because
#    a process spawned from an older shell inherits the stale PATH.
$uv = @((Get-Command uv -ErrorAction SilentlyContinue).Source,
  "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\uv.exe") |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($uv) { Note 'OK' "uv found: $uv" } else { Note 'WARN' 'uv not found; reverse_lab_tools MCP unavailable' }

# 6) reverse_lab_tools MCP registration — idempotent, with one-time .bak snapshot.
# Raw-text probe: PS 5.1's ConvertFrom-Json rejects ~/.claude.json's duplicate keys.
$mcpRegistered = $false
if (Test-Path $claudeJson) {
  if ((Get-Content $claudeJson -Raw) -match '"reverse_lab_tools"\s*:') { $mcpRegistered = $true }
}
if ($mutating -and $uv -and (Test-Path $claudeJson)) {
  if ($mcpRegistered) {
    Note 'OK' 'reverse_lab_tools already registered (idempotent skip)'
  } else {
    if (-not (Test-Path $claudeBak)) {
      Copy-Item $claudeJson $claudeBak
      Note 'OK' "snapshot saved: $claudeBak (restore with -Action restore)"
    }
    $mcpDir = Join-Path $unirev 'vendors/open-reverselab/tools/skills/mcp/ReverseLabToolsMCP'
    if (Test-Path "$mcpDir/reverse_lab_tools_mcp.py") {
      # `claude mcp add ... --` form instead of add-json: PS 5.1 mangles quoted JSON args.
      $mcpDirFwd = $mcpDir -replace '\\', '/'
      & claude mcp add --scope user reverse_lab_tools -- uv run --project $mcpDirFwd --python '>=3.11' python "$mcpDirFwd/reverse_lab_tools_mcp.py"
      if ($LASTEXITCODE -eq 0) { Note 'OK' 'reverse_lab_tools registered (restart Claude Code to load)' }
      else { Note 'FAIL' 'claude mcp add failed' }
    } else { Note 'FAIL' "MCP entry not found: $mcpDir/reverse_lab_tools_mcp.py" }
  }
} elseif ($mutating -and -not $uv) {
  Note 'WARN' 'reverse_lab_tools registration skipped: uv not found'
} elseif ($mutating) {
  Note 'WARN' 'reverse_lab_tools registration skipped: ~/.claude.json not found'
} elseif ($mcpRegistered) {
  Note 'OK' 'reverse_lab_tools registered'
} else {
  Note 'INFO' 'reverse_lab_tools not registered (doctor mode, no changes)'
}

# 6b) rea MCP registration (idempotent; `rea mcp` serves the tool catalog over stdio).
$reaRegistered = $false
if (Test-Path $claudeJson) {
  if ((Get-Content $claudeJson -Raw) -match '"rea"\s*:') { $reaRegistered = $true }
}
if ($mutating -and $rea) {
  if ($reaRegistered) { Note 'OK' 'rea already registered (idempotent skip)' }
  else {
    $npmRoot = (& npm root -g).Trim()
    $reaMjs = (Join-Path $npmRoot 'rea-agents/scripts/rea.mjs') -replace '\\', '/'
    if (Test-Path $reaMjs) {
      & claude mcp add --scope user rea -- node $reaMjs mcp
      if ($LASTEXITCODE -eq 0) { Note 'OK' 'rea registered (restart Claude Code to load)' }
      else { Note 'FAIL' 'claude mcp add rea failed' }
    } else { Note 'FAIL' "rea.mjs not found at $reaMjs" }
  }
} elseif ($mutating -and -not $rea) {
  Note 'WARN' 'rea registration skipped: rea-agents not installed'
} elseif ($reaRegistered) {
  Note 'OK' 'rea registered'
} else {
  Note 'INFO' 'rea not registered (doctor mode, no changes)'
}

# 6c) craft-anything MCP registration (idempotent).
$caRegistered = $false
if (Test-Path $claudeJson) {
  if ((Get-Content $claudeJson -Raw) -match '"craft-anything"\s*:') { $caRegistered = $true }
}
if ($mutating -and $ca) {
  if ($caRegistered) { Note 'OK' 'craft-anything already registered (idempotent skip)' }
  else {
    & claude mcp add --scope user craft-anything -- $ca mcp
    if ($LASTEXITCODE -eq 0) { Note 'OK' 'craft-anything registered (restart Claude Code to load)' }
    else { Note 'FAIL' 'claude mcp add craft-anything failed' }
  }
} elseif ($mutating -and -not $ca) {
  Note 'WARN' 'craft-anything registration skipped: CLI not found'
} elseif ($caRegistered) {
  Note 'OK' 'craft-anything registered'
} else {
  Note 'INFO' 'craft-anything not registered (doctor mode, no changes)'
}

# 7) Health check: CA doctor when available.
if ($ca) { & $ca doctor 2>&1 | Select-Object -First 3 | ForEach-Object { Note 'INFO' "CA doctor: $_" } }

Write-Host ''
Write-Host '=== unirev install report ==='
$report | ForEach-Object { Write-Host $_ }
