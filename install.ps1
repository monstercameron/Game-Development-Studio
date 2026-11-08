[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$ListModels,
    [switch]$Plan,
    [switch]$SkipApp,
    [switch]$Rebuild,
    [switch]$ReinstallDependencies,
    [switch]$Activate,
    [string[]]$Models = @(),
    [string]$HfCli = '',
    [string]$StagingDirectory = ''
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$manifestPath = Join-Path $root 'install-models.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'install-models.json is missing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw 'Unsupported model manifest version.' }

function Get-Executable([string]$name) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}
function Get-HfExecutable {
    if ($HfCli) {
        if (-not (Test-Path -LiteralPath $HfCli -PathType Leaf)) { throw 'The specified Hugging Face CLI was not found.' }
        return (Resolve-Path -LiteralPath $HfCli).Path
    }
    $command = Get-Executable 'hf.exe'
    if (-not $command) { $command = Get-Executable 'hf.cmd' }
    if (-not $command) {
        $existing = Join-Path $env:USERPROFILE 'Desktop\Qwen Image Studio\.venv\Scripts\hf.exe'
        if (Test-Path -LiteralPath $existing -PathType Leaf) { $command = $existing }
    }
    return $command
}
function Invoke-Checked([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($exe)) exited with code $LASTEXITCODE." }
}
function Get-Sha256([string]$file) {
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($file)
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
}
function Get-NpmCommand {
    $npm = Get-Executable 'npm.cmd'
    if ($npm) { return @{ exe=$npm; prefix=@() } }
    $node = Get-Executable 'node.exe'
    $npmCli = Join-Path ${env:ProgramFiles} 'nodejs\node_modules\npm\bin\npm-cli.js'
    if ($node -and (Test-Path -LiteralPath $npmCli -PathType Leaf)) { return @{ exe=$node; prefix=@($npmCli) } }
    return $null
}
function Get-SafeDestination([string]$base, [string]$relative) {
    if ($relative -notmatch '^[A-Za-z0-9._/-]+$' -or $relative -match '(^|/)\.\.(/|$)') { throw 'Invalid model destination in the manifest.' }
    $baseFull = [IO.Path]::GetFullPath($base).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $target = [IO.Path]::GetFullPath((Join-Path $baseFull $relative))
    if (-not $target.StartsWith($baseFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Model destination escapes staging.' }
    return $target
}

$requested = @($Models | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($requested -contains 'all') {
    if ($requested.Count -ne 1) { throw "Use 'all' alone or list specific model IDs." }
    # Check access-sensitive models first so a missing approval is discovered
    # before starting the other very large downloads.
    # Entries marked "optional" are extra checkpoints for features beyond the studio's core set;
    # they are staged only when named explicitly.
    $requested = @('3d-trellis','segmentation','sfx') + @($manifest.models | Where-Object { $_.id -notin @('3d-trellis','segmentation','sfx') -and -not $_.optional } | ForEach-Object { $_.id })
}
$selected = @()
foreach ($id in $requested) {
    $matches = @($manifest.models | Where-Object { $_.id -eq $id })
    if ($matches.Count -ne 1) { throw "Unknown model '$id'. Use -ListModels to see available IDs." }
    $selected += $matches[0]
}
$managedFolders = @{'worldgen'='worldgen'; '3d-hunyuan'='Hunyuan3D-2.1'; 'motion-hy'='HY-Motion'; 'motion-bricks'='MotionBricks'; 'tts'='Qwen3-TTS-12Hz-1.7B-CustomVoice'; 'asr'='nemotron-speech-streaming-en-0.6b'; 'segmentation'='sam3.1'}
if ($Activate) {
    if (-not $selected.Count) { throw '-Activate requires at least one model ID.' }
    foreach ($model in $selected) { if (-not $managedFolders.ContainsKey($model.id)) { throw "$($model.id) cannot be activated automatically. Stage it without -Activate and follow its separate instructions." } }
}
if ($ListModels) {
    foreach ($model in $manifest.models) {
        Write-Host "`n$($model.id) - $($model.name)"
        Write-Host "  Expected: $($model.destination)"
        $method = if (-not @($model.downloads).Count) { 'manual setup' } elseif ($managedFolders.ContainsKey($model.id)) { 'download staging; optional new-folder activation' } else { 'download staging; manual activation' }
        Write-Host "  Installer: $method"
        foreach ($source in $model.sources) { Write-Host "  Source: $source" }
        Write-Host "  $($model.notes)"
    }
    return
}
if ($CheckOnly) {
    $node = Get-Executable 'node.exe'; $npm = Get-NpmCommand; $hf = Get-HfExecutable
    Write-Host "Studio folder: $root"
    if ($node) { Write-Host "Node: $(& $node --version) ($node)" } else { Write-Host 'Node: missing (Node.js 24 is required)' }
    if ($npm) { Write-Host "npm: available ($($npm.exe))" } else { Write-Host 'npm: missing' }
    if ($hf) { Write-Host "Hugging Face CLI: available ($hf)" } else { Write-Host 'Hugging Face CLI: missing; only required for staged downloads' }
    $smi = Get-Executable 'nvidia-smi.exe'
    if ($smi) { Write-Host 'NVIDIA devices:'; & $smi --query-gpu=name,memory.total --format=csv } else { Write-Host 'NVIDIA GPU: nvidia-smi not found' }
    foreach ($item in @(@('App dependencies','node_modules'),@('Built web app','dist\index.html'),@('WorldGen Q5 text','models\worldgen\flux1-dev-Q5_0.gguf'),@('WorldGen Q5 image','models\worldgen\flux1-fill-dev-Q5_0.gguf'),@('Qwen CUDA server','engines\llama-cuda\bin\llama-server.exe'))) {
        $state = if (Test-Path -LiteralPath (Join-Path $root $item[1])) { 'present' } else { 'missing' }
        Write-Host "$($item[0]): $state"
    }
    $desktop = Join-Path $env:USERPROFILE 'Desktop'
    $checks = @{
        'worldgen'=@((Join-Path $desktop 'WorldGen\.venv\Scripts\python.exe'),(Join-Path $root 'models\worldgen\flux1-dev-Q5_0.gguf'),(Join-Path $root 'models\worldgen\flux1-fill-dev-Q5_0.gguf'))
        'hy-world'=@((Join-Path $desktop 'HY-World-2.0\.venv\Scripts\python.exe'),(Join-Path $root 'models\HY-World-2.0\weights\HY-WorldMirror-2.0\model.safetensors'))
        'images'=@((Join-Path $desktop 'Qwen Image Studio\.venv\Scripts\python.exe'),(Join-Path $root 'models\Qwen-Image-2.1\.download-complete'))
        '3d-trellis'=@((Join-Path $root '.forge-runtime\trellis2-venv\Scripts\python.exe'),(Join-Path $root 'models\TRELLIS.2-4B\pipeline.json'),(Join-Path $root 'models\dinov3-vitl16-pretrain-lvd1689m\model.safetensors'))
        '3d-hunyuan'=@((Join-Path $root '.forge-runtime\hunyuan3d-venv\Scripts\python.exe'),(Join-Path $root 'models\Hunyuan3D-2.1\hunyuan3d-dit-v2-1\model.fp16.ckpt'))
        'motion-hy'=@((Join-Path $root '.forge-runtime\hunyuan3d-venv\Scripts\python.exe'),(Join-Path $root 'models\HY-Motion\HY-Motion-1.0\latest.ckpt'))
        'motion-bricks'=@((Join-Path $root '.forge-runtime\hunyuan3d-venv\Scripts\python.exe'),(Join-Path $root 'models\MotionBricks\checkpoints'))
        'video'=@((Join-Path $desktop 'H3 Studio\engine\node.exe'),(Join-Path $root 'models\MiniMax-H3\h3-studio'),(Join-Path $root 'models\MiniMax-H3\sol-engine\vae'))
        'music'=@((Join-Path $desktop 'Snapdargon-DJ\.runtime\python.exe'),(Join-Path $root 'models\YuE2-3B'),(Join-Path $root 'models\YuE2-Vae'))
        'sfx'=@((Join-Path $desktop 'Snapdargon-DJ\.runtime\python.exe'),(Join-Path $desktop 'Stable Audio Lab\bootstrap.py'),(Join-Path $root 'models\Stable-Audio-3\hub'))
        'tts'=@((Join-Path $root '.forge-runtime\tts-python-embed\python.exe'),(Join-Path $root 'models\Qwen3-TTS-12Hz-1.7B-CustomVoice\model.safetensors'))
        'asr'=@((Join-Path $root '.forge-runtime\nemo-speech-0.3.0\bin\nemo-speech.exe'),(Join-Path $root 'models\nemotron-speech-streaming-en-0.6b\nemotron-speech-streaming-en-0.6b.q8_0.gguf'))
        'segmentation'=@((Join-Path $root '.forge-runtime\sam3-python-embed\python.exe'),(Join-Path $root 'models\sam3.1\sam3.1_multiplex.pt'))
        'game'=@((Join-Path $desktop 'ComfyUI_windows_portable\python_embeded\python.exe'),(Join-Path $root 'models\Mammoth-1\mammoth-q4km\mammoth-1-Q4_K_M.gguf'))
        'chat'=@((Join-Path $root 'engines\llama-cuda\bin\llama-server.exe'),(Join-Path $root 'models\Qwen3.8-27B-GGUF\Qwen3.8-27B-Q4_K_M.gguf'))
    }
    Write-Host "`nSelected model prerequisite paths:"
    foreach ($model in $manifest.models) {
        $paths = @($checks[$model.id]); $found = @($paths | Where-Object { Test-Path -LiteralPath $_ }).Count
        Write-Host ("  {0}: {1}/{2} selected paths present" -f $model.id, $found, $paths.Count)
    }
    Write-Host 'File presence is not proof of a complete environment or a working model. See docs/INSTALLATION.md.'
    return
}

if ($Plan) {
    if (-not $SkipApp) { Write-Host 'Plan: install JavaScript dependencies if missing and build the web app if missing. Use -Rebuild or -ReinstallDependencies to refresh explicitly.' }
    foreach ($model in $selected) {
        Write-Host "`n$($model.id): $($model.name)"
        Write-Host "  Expected location: $($model.destination)"
        foreach ($source in $model.sources) { Write-Host "  Source: $source" }
        foreach ($part in $model.downloads) {
            Write-Host "  Stage: $($part.repo) @ $($part.revision) -> $($part.destination)"
            if ($part.files) { Write-Host "    Files: $($part.files -join ', ')" }
            if ($part.include) { Write-Host "    Include: $($part.include -join ', ')" }
        }
        Write-Host "  $($model.notes)"
    }
    if ($Activate) { Write-Host 'After download: activate supported models only if their target folders do not exist.' }
    Write-Host 'Plan only: no files were changed and no downloads were started.'
    return
}
if ($Activate) {
    foreach ($model in $selected) {
        $target = Join-Path (Join-Path $root 'models') $managedFolders[$model.id]
        if (Test-Path -LiteralPath $target) { throw "Model destination already exists; nothing will be replaced: $target" }
    }
}

if (-not $SkipApp) {
    $node = Get-Executable 'node.exe'; $npm = Get-NpmCommand
    if (-not $node -or -not $npm) { throw 'Node.js 24 and npm are required. Install them first, then rerun the script.' }
    $nodeVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 or newer is required.' }
    $modules = Join-Path $root 'node_modules'
    $mustInstall = $ReinstallDependencies -or -not (Test-Path -LiteralPath $modules -PathType Container)
    Push-Location $root
    try {
        if ($mustInstall) {
            if ($ReinstallDependencies -and (Test-Path -LiteralPath $modules)) { Write-Host 'Reinstalling dependencies as explicitly requested; npm ci replaces node_modules.' }
            Invoke-Checked $npm.exe ($npm.prefix + @('ci','--no-audit','--no-fund'))
        } else {
            Write-Host 'Keeping existing node_modules. Use -ReinstallDependencies to replace it.'
            & $node -e "import('vite').catch(() => process.exit(1))"
            if ($LASTEXITCODE -ne 0) { throw 'Existing dependencies are incomplete. Rerun with -ReinstallDependencies after checking active work.' }
        }
        if ($mustInstall -or $Rebuild -or -not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html') -PathType Leaf)) {
            Write-Host 'Building the web app. A running studio may briefly serve changing build files.'
            Invoke-Checked $npm.exe ($npm.prefix + @('run','build'))
        } else { Write-Host 'Keeping the existing web build. Use -Rebuild to refresh it.' }
    } finally { Pop-Location }
}

if ($selected.Count) {
    $downloadable = @($selected | Where-Object { @($_.downloads).Count -gt 0 })
    $manual = @($selected | Where-Object { @($_.downloads).Count -eq 0 })
    if ($manual.Count) { foreach ($model in $manual) { Write-Warning "$($model.name): manual setup required. $($model.notes)" } }
    if ($downloadable.Count) {
        $hf = Get-HfExecutable
        if (-not $hf) { throw 'Hugging Face CLI was not found. Install it or pass -HfCli; see docs/INSTALLATION.md. No model files were changed.' }
        if (-not $StagingDirectory) { $StagingDirectory = Join-Path $root ('models\forge-install-staging\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)) }
        $staging = [IO.Path]::GetFullPath($StagingDirectory)
        if (Test-Path -LiteralPath $staging) { throw "Staging directory already exists; choose a new path: $staging" }
        New-Item -ItemType Directory -Path $staging | Out-Null
        Write-Host "Staging selected model files in: $staging"
        foreach ($model in $downloadable) {
            Write-Host "`n$($model.name): $($model.notes)"
            foreach ($part in $model.downloads) {
                $target = Get-SafeDestination $staging $part.destination
                $arguments = @('download', $part.repo)
                if ($part.files) { $arguments += @($part.files) }
                if ($part.revision) { $arguments += @('--revision', $part.revision) }
                foreach ($pattern in @($part.include)) { if ($pattern) { $arguments += @('--include', $pattern) } }
                $arguments += @('--local-dir', $target)
                Write-Host "Downloading $($part.repo) @ $($part.revision)"
                Invoke-Checked $hf $arguments
                if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "Download did not create its staging directory: $target" }
                if ($part.files) { foreach ($file in $part.files) { $item = Get-SafeDestination $target $file; if (-not (Test-Path -LiteralPath $item -PathType Leaf)) { throw "Expected downloaded file is missing: $item" } } }
                else { $downloaded = @(Get-ChildItem -LiteralPath $target -File -Recurse | Where-Object { $_.FullName -notmatch '[\\/]\.cache[\\/]' }); if (-not $downloaded.Count) { throw "No model files were downloaded to $target." } }
                if ($part.sha256 -and $part.sha256File) {
                    $check = Get-SafeDestination $target $part.sha256File
                    Write-Host "Verifying SHA-256: $($part.sha256File)"
                    if ((Get-Sha256 $check) -ne $part.sha256) { throw "SHA-256 verification failed: $check" }
                }
            }
        }
        if ($Activate) {
            $modelRoot = Join-Path $root 'models'
            if (-not (Test-Path -LiteralPath $modelRoot)) { New-Item -ItemType Directory -Path $modelRoot | Out-Null }
            $rootInfo = Get-Item -LiteralPath $modelRoot -Force
            if (-not $rootInfo.PSIsContainer -or ($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The models root is not a regular directory.' }
            $modelRoot = (Resolve-Path -LiteralPath $modelRoot).Path
            # Preflight every destination before copying any model. Existing
            # folders are never merged, renamed, replaced, or deleted.
            foreach ($model in $downloadable) {
                $name = $managedFolders[$model.id]
                $source = Get-SafeDestination $staging $name
                $target = Get-SafeDestination $modelRoot $name
                if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Staged model folder is missing: $source" }
                if (Test-Path -LiteralPath $target) { throw "Model destination already exists; nothing will be replaced: $target" }
                if (@(Get-ChildItem -LiteralPath $source -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw "Staged model contains a link; review it before activation: $source" }
            }
            foreach ($model in $downloadable) {
                $name = $managedFolders[$model.id]
                $source = Get-SafeDestination $staging $name
                $target = Get-SafeDestination $modelRoot $name
                $temporary = Get-SafeDestination $modelRoot ('.forge-install-' + [guid]::NewGuid().ToString('N'))
                Write-Host "Activating $($model.name) in $target"
                New-Item -ItemType Directory -Path $temporary | Out-Null
                foreach ($item in Get-ChildItem -LiteralPath $source -Force) { Copy-Item -LiteralPath $item.FullName -Destination $temporary -Recurse }
                # Directory.Move fails if the destination appeared concurrently.
                [IO.Directory]::Move($temporary, $target)
            }
            Write-Host 'Model files were installed. Their Python environments, native engines and supporting checkpoints may still need separate setup.'
        } else {
            Write-Host "`nDownloads are staged in $staging. They are not activated. Review docs/INSTALLATION.md before placing files into the expected locations."
        }
    }
    if ($manual.Count) { Write-Host 'Some selected models require separate manual steps; see the source links in -ListModels and docs/INSTALLATION.md.' }
}
if (-not $SkipApp) { Write-Host "`nWeb app setup complete. Start it with: powershell -NoProfile -ExecutionPolicy Bypass -File `"$root\start-server.ps1`"" }
