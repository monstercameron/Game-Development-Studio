param([ValidateRange(1,65535)][int]$Port = 5173)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$electron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$desktopEntry = Join-Path $projectRoot 'desktop\main.js'
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
    throw 'Electron is not installed. Run pnpm install, then pnpm rebuild electron.'
}
& (Join-Path $projectRoot 'start-server.ps1') -Port $Port
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'The Studio server could not start.' }
Start-Process -FilePath $electron -ArgumentList @("`"$desktopEntry`"", '--port', "$Port") -WorkingDirectory $projectRoot
