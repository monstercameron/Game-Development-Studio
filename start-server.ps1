param([ValidateRange(1,65535)][int]$Port = 5173)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runtimeDir = Join-Path $projectRoot '.forge-runtime'
$statePath = Join-Path $runtimeDir "server-$Port.json"
$entry = Join-Path $projectRoot 'server.js'
$url = "http://127.0.0.1:$Port"

function Get-StudioServer {
    try {
        $details = Invoke-RestMethod -Uri "$url/api/diagnostics" -TimeoutSec 2
        if ($details.server.port -ne $Port -or $details.server.projectDirectory -ne $projectRoot) { return $null }
        $trackedPid = if ($details.server.supervisorPid) { [int]$details.server.supervisorPid } else { [int]$details.server.pid }
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $trackedPid"
        if ($processInfo.Name -ne 'node.exe' -or -not $processInfo.CommandLine -or $processInfo.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
        if ($details.server.supervisorPid) {
            if ($processInfo.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $processInfo.CommandLine -notmatch "--port\s+$Port(?:\s|$)") { return $null }
        } elseif ($processInfo.CommandLine -notmatch 'vite[\\/]+bin[\\/]+vite\.js') { return $null }
        return $details.server
    } catch { return $null }
}
function Test-PortInUse {
    $client = [System.Net.Sockets.TcpClient]::new()
    try { $connect = $client.ConnectAsync('127.0.0.1', $Port); return $connect.Wait(500) -and $client.Connected } catch { return $false } finally { $client.Dispose() }
}

if (-not (Test-Path -LiteralPath $entry -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\express') -PathType Container)) { throw 'Studio dependencies are missing. Run npm install in the studio folder first.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html') -PathType Leaf)) { throw 'Studio build is missing. Run npm run build in the studio folder first.' }
$existing = Get-StudioServer
if ($existing) { Write-Host "Studio is already running at $url (HTTP PID $($existing.pid))."; exit 0 }
if (Test-PortInUse) { throw "Port $Port is already in use by another service. Choose another port with -Port." }
$node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-ffff'
$stdout = Join-Path $runtimeDir "server-$Port-$stamp.log"
$stderr = Join-Path $runtimeDir "server-$Port-$stamp-error.log"
$serverProcess = Start-Process -FilePath $node -ArgumentList @("`"$entry`"", '--port', "$Port") -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$state = @{ pid=$serverProcess.Id; startTimeUtcTicks=$serverProcess.StartTime.ToUniversalTime().Ticks; port=$Port; projectRoot=$projectRoot; stdout=$stdout; stderr=$stderr }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) { throw "Studio exited during startup. Check $stderr and $stdout." }
    $started = Get-StudioServer
    if ($started -and $started.supervisorPid -eq $serverProcess.Id) { Write-Host "Studio is running at $url (supervisor PID $($serverProcess.Id))."; Write-Host "Log: $stdout"; exit 0 }
}
throw "Studio did not become ready within 30 seconds. Check $stderr and $stdout; use stop-server.ps1 -Port $Port to stop its tracked process."
