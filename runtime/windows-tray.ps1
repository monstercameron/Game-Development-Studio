param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Port,
    [Parameter(Mandatory = $true)][int]$OwnerPid,
    [switch]$TestQueueEvents,
    [switch]$TestResponsiveness,
    [switch]$TestWindowActions
)

$ErrorActionPreference = 'Stop'

# A baseline prevents replaying old jobs when the tray starts. A job first seen
# after the baseline can also finish between polls, so its creation time matters.
function Get-QueueEvents($Previous, $Jobs, $BaselineUtc) {
    $activeStates = @('queued', 'waiting_engine', 'waiting_memory', 'needs_attention', 'preparing', 'submitting', 'running', 'finalizing', 'interrupted')
    $next = @{}
    $finished = @()
    foreach ($job in @($Jobs)) {
        $next[[string]$job.id] = [string]$job.status
        if ($null -ne $Previous -and $job.status -in @('completed', 'failed')) {
            $old = $Previous[[string]$job.id]
            $created = [datetimeoffset]::MinValue
            $isNew = [datetimeoffset]::TryParse([string]$job.createdAt, [ref]$created) -and $created -gt $BaselineUtc
            if (($old -and $old -ne $job.status) -or (-not $old -and $isNew)) {
                $finished += $job
            }
        }
    }
    $wasActive = $false
    if ($null -ne $Previous) {
        foreach ($state in $Previous.Values) { if ($state -in $activeStates) { $wasActive = $true; break } }
    }
    $isActive = @($Jobs | Where-Object { $_.status -in $activeStates }).Count -gt 0
    return @{ states = $next; finished = $finished; queueFinished = (-not $isActive -and ($wasActive -or $finished.Count -gt 0)) }
}

if ($TestQueueEvents) {
    $start = [datetimeoffset]::UtcNow.AddSeconds(-5)
    $a = @{ id = 'a'; status = 'running'; createdAt = $start.ToString('o') }
    $b = @{ id = 'b'; status = 'queued'; createdAt = $start.ToString('o') }
    $first = Get-QueueEvents $null @($a, $b) $start
    $a.status = 'completed'
    $second = Get-QueueEvents $first.states @($a, $b) $start
    $b.status = 'completed'
    $third = Get-QueueEvents $second.states @($a, $b) $start
    if ($first.finished.Count -ne 0 -or $second.finished.Count -ne 1 -or $second.queueFinished -or $third.finished.Count -ne 1 -or -not $third.queueFinished) { throw 'Queue notification transition test failed.' }
    $fast = @{ id = 'c'; status = 'completed'; createdAt = [datetimeoffset]::UtcNow.ToString('o') }
    $fourth = Get-QueueEvents $third.states @($a, $b, $fast) $start
    if ($fourth.finished.Count -ne 1 -or -not $fourth.queueFinished) { throw 'Fast job notification test failed.' }
    $failed = @{ id = 'd'; status = 'failed'; createdAt = [datetimeoffset]::UtcNow.ToString('o') }
    $fifth = Get-QueueEvents $fourth.states @($a, $b, $fast, $failed) $start
    if ($fifth.finished.Count -ne 1 -or -not $fifth.queueFinished) { throw 'Failed job notification test failed.' }
    'Queue notification transitions passed.'
    exit 0
}

if ($env:OS -ne 'Windows_NT') { exit 0 }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForgeTrayWindows {
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
}
'@

$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\ForgeStudioTray-$Port", [ref]$created)
if (-not $created) { $mutex.Dispose(); exit 0 }
try { $owner = [System.Diagnostics.Process]::GetProcessById($OwnerPid) } catch { $mutex.ReleaseMutex(); $mutex.Dispose(); exit 1 }
$origin = "http://127.0.0.1:$Port"
$root = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = if ($env:FORGE_RUNTIME_DIR) { $env:FORGE_RUNTIME_DIR } else { Join-Path $root '.forge-runtime' }
[void][System.IO.Directory]::CreateDirectory($runtimeDirectory)
$preferencesPath = Join-Path $runtimeDirectory "tray-settings-$Port.json"
$heartbeatPath = Join-Path $runtimeDirectory "tray-status-$Port.json"
$logPath = Join-Path $runtimeDirectory "tray-$Port.log"
function Write-TrayLog([string]$Message) {
    try { Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8 } catch { }
}
$script:previous = $null
$script:baseline = [datetimeoffset]::UtcNow
$script:queueRequest = $null
$script:serviceRequest = $null
$script:nextQueuePoll = [datetime]::MinValue
$script:nextServicePoll = [datetime]::MinValue
$script:renderAlerts = $true
$script:queueAlerts = $true
$script:services = @()
$script:pending = $null
$script:toastNotifier = $null
$script:connectionFailed = $false
$script:servicesFailed = $false
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$http = [System.Net.Http.HttpClient]::new($handler)
$http.Timeout = [timespan]::FromSeconds(5)
try {
    if (Test-Path -LiteralPath $preferencesPath) {
        $preferences = Get-Content -LiteralPath $preferencesPath -Raw | ConvertFrom-Json
        if ($preferences.render -is [bool]) { $script:renderAlerts = $preferences.render }
        if ($preferences.queue -is [bool]) { $script:queueAlerts = $preferences.queue }
    }
} catch { Write-TrayLog 'Could not read tray notification preferences; using defaults.' }
function Save-Preferences {
    try { @{ render = $script:renderAlerts; queue = $script:queueAlerts } | ConvertTo-Json -Compress | Set-Content -LiteralPath $preferencesPath -Encoding UTF8 }
    catch { Write-TrayLog 'Could not save tray notification preferences.' }
}

function Show-Notice([string]$Title, [string]$Message) {
    if ($script:toastNotifier) {
        try {
            $titleXml = [System.Security.SecurityElement]::Escape($Title)
            $messageXml = [System.Security.SecurityElement]::Escape($Message)
            $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
            $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$titleXml</text><text>$messageXml</text></binding></visual></toast>")
            $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
            $script:toastNotifier.Show($toast)
            return
        } catch { }
    }
    # Older Windows configurations may not support unpackaged toast alerts.
    $script:icon.ShowBalloonTip(5000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Info)
}
function Open-DesktopWindow([string]$Action) {
    $electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
    if (Test-Path -LiteralPath $electron -PathType Leaf) {
        try {
            Start-Process -FilePath $electron -ArgumentList @("`"$(Join-Path $root 'desktop\main.js')`"", '--port', "$Port", '--window-action', $Action) -WorkingDirectory $root
        } catch { Show-Notice 'Forge desktop unavailable' 'The Studio window could not be opened. Check the desktop installation.' }
    } else {
        Show-Notice 'Forge desktop unavailable' 'Install the desktop dependencies, then run start-desktop.cmd.'
    }
}
function Start-Offload([string]$Id) {
    if ($script:pending) { Show-Notice 'Forge Studio' 'Wait for the current model offload to finish.'; return }
    $client = New-Object System.Net.WebClient
    $client.Headers['Content-Type'] = 'application/json'
    $client.Headers['Origin'] = $origin
    $client.Headers['X-Forge-Request'] = 'runtime'
    try {
        $task = $client.UploadStringTaskAsync("$origin/api/runtime/models/$Id/offload", 'POST', '{}')
        $script:pending = @{ client = $client; task = $task; id = $Id }
        Show-Notice 'Forge Studio' "Offloading $Id..."
    } catch { $client.Dispose(); Show-Notice 'Offload failed' 'Could not contact the Studio.' }
}

$bitmap = New-Object System.Drawing.Bitmap(32, 32)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 46, 18, 37))
$fg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 171, 139))
$graphics.FillEllipse($bg, 0, 0, 31, 31)
$font = New-Object System.Drawing.Font('Segoe UI', 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString('F', $font, $fg, 8, 3)
$iconHandle = $bitmap.GetHicon()
$nativeIcon = [System.Drawing.Icon]::FromHandle($iconHandle).Clone()
$graphics.Dispose(); $font.Dispose(); $bg.Dispose(); $fg.Dispose(); $bitmap.Dispose()
[void][ForgeTrayWindows]::DestroyIcon($iconHandle)
try {
    if ($env:FORGE_TRAY_TEST_NO_TOAST -eq '1') { throw 'Toast registration disabled for an isolated tray test.' }
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-toast.cs')
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $iconPath = Join-Path $runtimeDirectory 'forge-tray.ico'
    if (-not (Test-Path -LiteralPath $iconPath)) {
        $iconFile = [System.IO.File]::Open($iconPath, [System.IO.FileMode]::CreateNew)
        try { $nativeIcon.Save($iconFile) } finally { $iconFile.Dispose() }
    }
    $shortcutName = if ($Port -eq 5173) { 'Forge Studio Notifications.lnk' } else { "Forge Studio Notifications $Port.lnk" }
    $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $root 'start-server.ps1') + '" -Port ' + $Port
    [ForgeToastShortcut]::Ensure($shortcut, (Join-Path $PSHOME 'powershell.exe'), $arguments, $root, $iconPath)
    $script:toastNotifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([ForgeToastShortcut]::AppId)
} catch {
    # A tray balloon remains available if Windows denies toast registration.
    Write-TrayLog 'Windows toast registration failed; using notification-area balloons.'
}
$script:icon = New-Object System.Windows.Forms.NotifyIcon
$script:icon.Icon = $nativeIcon
$script:icon.Text = 'Forge Studio'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open Studio')
$open.Add_Click({ Open-DesktopWindow 'open' })
$minimize = $menu.Items.Add('Minimize Studio window')
$minimize.Add_Click({ Open-DesktopWindow 'minimize' })
$maximize = $menu.Items.Add('Maximize Studio window')
$maximize.Add_Click({ Open-DesktopWindow 'maximize' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$modelMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Offload idle model')
[void]$menu.Items.Add($modelMenu)
$modelMenu.Add_DropDownOpening({
    $modelMenu.DropDownItems.Clear()
    $eligible = @($script:services | Where-Object { $_.managed -eq $true -and $_.canUnload -eq $true })
    if ($eligible.Count -eq 0) {
        $empty = $modelMenu.DropDownItems.Add('No verified idle models')
        $empty.Enabled = $false
    } else {
        foreach ($service in $eligible) {
            $item = $modelMenu.DropDownItems.Add([string]$service.name)
            $item.Tag = [string]$service.id
            $item.Add_Click({ Start-Offload ([string]$this.Tag) })
        }
    }
})
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$renderItem = $menu.Items.Add('Notify when a render finishes')
$renderItem.CheckOnClick = $true; $renderItem.Checked = $script:renderAlerts
$renderItem.Add_CheckedChanged({ $script:renderAlerts = $renderItem.Checked; Save-Preferences })
$queueItem = $menu.Items.Add('Notify when the queue finishes')
$queueItem.CheckOnClick = $true; $queueItem.Checked = $script:queueAlerts
$queueItem.Add_CheckedChanged({ $script:queueAlerts = $queueItem.Checked; Save-Preferences })
$testItem = $menu.Items.Add('Test Windows notification')
$testItem.Add_Click({ Show-Notice 'Forge Studio' 'Windows notifications are ready.' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$stop = $menu.Items.Add('Stop Studio...')
$stop.Add_Click({
    $answer = [System.Windows.Forms.MessageBox]::Show('Stop the Studio service? An active render may be interrupted. Model workers may remain running.', 'Stop Forge Studio', 'YesNo', 'Warning')
    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $root 'stop-server.ps1')`"", '-Port', "$Port") -WindowStyle Hidden
    }
})
$script:icon.ContextMenuStrip = $menu
$script:icon.Add_DoubleClick({ Open-DesktopWindow 'open' })
$script:icon.Visible = $true

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    try { $owner.Refresh(); if ($owner.HasExited) { [System.Windows.Forms.Application]::ExitThread(); return } } catch { [System.Windows.Forms.Application]::ExitThread(); return }
    if ($script:pending -and $script:pending.task.IsCompleted) {
        try { $null = $script:pending.task.GetAwaiter().GetResult(); Show-Notice 'Model offloaded' "$($script:pending.id) was stopped and its memory can be reclaimed."; $script:nextServicePoll = [datetime]::MinValue }
        catch { Show-Notice 'Offload failed' 'The model may be busy or unavailable. Check Models & services.' }
        finally { $script:pending.client.Dispose(); $script:pending = $null }
    }
    if ($script:queueRequest -and $script:queueRequest.IsCompleted) {
      try {
        $result = $script:queueRequest.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($null -eq $result.jobs) { throw 'Queue response was invalid.' }
        $events = Get-QueueEvents $script:previous @($result.jobs) $script:baseline
        foreach ($job in @($events.finished)) {
            if ($script:renderAlerts) {
                if ($job.status -eq 'completed') { Show-Notice 'Forge render complete' 'A new asset is ready in your project.' }
                else { Show-Notice 'Forge render failed' 'Open the render queue to inspect the error.' }
            }
        }
        if ($events.queueFinished -and $script:queueAlerts) { Show-Notice 'Forge render queue finished' 'No renders are waiting or running. Check the queue for results.' }
        $script:previous = $events.states
        try {
            $heartbeatTemp = Join-Path $runtimeDirectory "tray-status-$Port-$PID.tmp"
            @{ render = $script:renderAlerts; queue = $script:queueAlerts; pid = $PID; ownerPid = $OwnerPid } | ConvertTo-Json -Compress | Set-Content -LiteralPath $heartbeatTemp -Encoding UTF8
            Move-Item -LiteralPath $heartbeatTemp -Destination $heartbeatPath -Force
        } catch { Write-TrayLog 'Could not update the tray heartbeat.' }
        if ($script:connectionFailed) { Write-TrayLog 'Studio queue connection restored.'; $script:connectionFailed = $false }
      } catch { if (-not $script:connectionFailed) { Write-TrayLog 'Studio queue is temporarily unavailable.'; $script:connectionFailed = $true } }
      finally { $script:queueRequest = $null }
    }
    if ($script:serviceRequest -and $script:serviceRequest.IsCompleted) {
      try {
        $status = $script:serviceRequest.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($null -eq $status.services) { throw 'Service response was invalid.' }
        $script:services = @($status.services)
        if ($script:servicesFailed) { Write-TrayLog 'Studio service status connection restored.'; $script:servicesFailed = $false }
      } catch {
        $script:services = @()
        if (-not $script:servicesFailed) { Write-TrayLog 'Studio service status is temporarily unavailable.'; $script:servicesFailed = $true }
      } finally { $script:serviceRequest = $null }
    }
    $now = [datetime]::UtcNow
    if (-not $script:queueRequest -and $now -ge $script:nextQueuePoll) {
        $script:queueRequest = $http.GetStringAsync("$origin/api/runtime/jobs")
        $script:nextQueuePoll = $now.AddSeconds(3)
    }
    if (-not $script:serviceRequest -and $now -ge $script:nextServicePoll) {
        $script:serviceRequest = $http.GetStringAsync("$origin/api/runtime/services")
        $script:nextServicePoll = $now.AddSeconds(9)
    }
})
$timer.Start()
if ($TestResponsiveness) {
    $probeTimer = New-Object System.Windows.Forms.Timer
    $probeTimer.Interval = 1200
    $probeTimer.Add_Tick({
        $probeTimer.Stop()
        Set-Content -LiteralPath (Join-Path $runtimeDirectory "tray-responsive-$Port.txt") -Value 'responsive' -Encoding UTF8
    })
    $probeTimer.Start()
}
if ($TestWindowActions) {
    $script:lastTestSequence = 0
    $actionTimer = New-Object System.Windows.Forms.Timer
    $actionTimer.Interval = 200
    $actionTimer.Add_Tick({
        try {
            $commandPath = Join-Path $runtimeDirectory "tray-test-command-$Port.json"
            if (-not (Test-Path -LiteralPath $commandPath)) { return }
            $command = Get-Content -LiteralPath $commandPath -Raw | ConvertFrom-Json
            if ($command.sequence -le $script:lastTestSequence) { return }
            $script:lastTestSequence = $command.sequence
            switch ($command.action) {
                'open' { $open.PerformClick() }
                'minimize' { $minimize.PerformClick() }
                'maximize' { $maximize.PerformClick() }
            }
        } catch { Write-TrayLog 'Could not run the isolated window-action test.' }
    })
    $actionTimer.Start()
}
try { [System.Windows.Forms.Application]::Run() }
finally {
    if ($probeTimer) { $probeTimer.Stop(); $probeTimer.Dispose() }
    if ($actionTimer) { $actionTimer.Stop(); $actionTimer.Dispose() }
    $http.Dispose()
    $timer.Stop(); $timer.Dispose(); $script:icon.Visible = $false; $script:icon.Dispose(); $menu.Dispose(); $nativeIcon.Dispose()
    if ($script:pending) { $script:pending.client.Dispose() }
    $owner.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose()
}
