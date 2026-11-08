param([ValidateRange(1,65535)][int]$Port = 5173)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$statePath = Join-Path $projectRoot ".forge-runtime\server-$Port.json"
$url = "http://127.0.0.1:$Port"
$state = $null
if (Test-Path -LiteralPath $statePath -PathType Leaf) { try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { throw "Cannot read studio process state at $statePath." } }
$details = $null
try { $details = Invoke-RestMethod -Uri "$url/api/diagnostics" -TimeoutSec 2 } catch {}
$serverPid = if ($details.server.port -eq $Port -and $details.server.projectDirectory -eq $projectRoot) { if($details.server.supervisorPid){[int]$details.server.supervisorPid}else{[int]$details.server.pid} } elseif ($state -and $state.projectRoot -eq $projectRoot -and $state.port -eq $Port) { [int]$state.pid } else { 0 }
if (-not $serverPid) { Write-Host "No matching studio server found on port $Port."; exit 0 }
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"
if (-not $processInfo) { Write-Host "Studio server is not running on port $Port."; exit 0 }
$entry = Join-Path $projectRoot 'server.js'
$isUnified = $processInfo.CommandLine -and $processInfo.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $processInfo.CommandLine -match "--port\s+$Port(?:\s|$)"
$isLegacy = $processInfo.CommandLine -and $processInfo.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $processInfo.CommandLine -match 'vite[\\/]+bin[\\/]+vite\.js'
if ($processInfo.Name -ne 'node.exe' -or (-not $isUnified -and -not $isLegacy)) { throw "PID $serverPid is not a verified studio server; nothing was stopped." }
if ($state -and [int]$state.pid -eq $serverPid -and $state.startTimeUtcTicks) {
    $actualTicks = (Get-Process -Id $serverPid -ErrorAction Stop).StartTime.ToUniversalTime().Ticks
    if ($actualTicks -ne [long]$state.startTimeUtcTicks) { throw "PID $serverPid has been reused; nothing was stopped." }
}
# Ask the studio to stop in an orderly way first: it closes SQLite, checkpoints the queue and writes
# the clean-shutdown marker. Terminate the process only if it is still running after the deadline
# (for example a studio started before this stop request existed).
try {
    $requestPath = Join-Path $projectRoot ".forge-runtime\stop-request-$Port.json"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $requestPath) | Out-Null
    $request = @{ pid = $serverPid; requestedAt = [datetime]::UtcNow.ToString('o'); reason = 'stop-server' } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($requestPath, $request)
    $deadline = [datetime]::UtcNow.AddSeconds(8)
    while ([datetime]::UtcNow -lt $deadline -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 200 }
} catch { Write-Host "Could not request an orderly stop: $($_.Exception.Message)" }
if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) {
    Write-Host 'The studio did not stop in time; terminating it.'
    Stop-Process -Id $serverPid -ErrorAction Stop
}
if ($state -and [int]$state.pid -eq $serverPid) { Remove-Item -LiteralPath $statePath -Force }
Write-Host "Stopped studio server on port $Port (PID $serverPid)."
