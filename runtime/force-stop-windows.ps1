# Terminate only a process tree whose root identity was captured by Forge.
# Each process handle is opened and checked against the same OS snapshot before
# termination, so a reused PID is not accepted as the original process.
$ErrorActionPreference = 'Stop'
$held = @()
try {
    $text = [Console]::In.ReadToEnd()
    if ($text.Length -gt 8192) { throw 'Invalid request.' }
    $inputData = $text | ConvertFrom-Json
    $rootId = [int]$inputData.pid
    if ($rootId -le 0 -or [string]$inputData.creationTicks -notmatch '^[1-9][0-9]{14,20}$' -or -not [IO.Path]::IsPathRooted([string]$inputData.executable)) { throw 'Invalid process identity.' }
    $root = Get-Process -Id $rootId -ErrorAction Stop
    [void]$root.Handle
    $held += $root
    if ($root.HasExited -or $root.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$inputData.creationTicks -or -not [string]::Equals($root.Path,[string]$inputData.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Process identity changed.' }
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,CreationDate)
    $known = @{$rootId = $true}
    $depth = @{$rootId = 0}
    $items = @(@{process=$root;depth=0})
    for ($level=1; $level -le 32; $level++) {
        $found = @($snapshot | Where-Object { $known.ContainsKey([int]$_.ParentProcessId) -and -not $known.ContainsKey([int]$_.ProcessId) })
        if (-not $found.Count) { break }
        foreach ($row in $found) {
            $id=[int]$row.ProcessId; $parent=[int]$row.ParentProcessId
            if ($id -eq $PID -or $id -eq 0 -or $items.Count -ge 128 -or -not $row.CreationDate) { throw 'Process tree could not be verified.' }
            try { $child=Get-Process -Id $id -ErrorAction Stop; [void]$child.Handle }
            catch { throw 'Process tree changed before it could be verified.' }
            $held += $child
            if ($child.HasExited) { $known[$id]=$true; continue }
            # WMI creation timestamps are rounded to microseconds; the process
            # handle exposes 100 ns ticks. Allow only that sub-microsecond loss.
            $childTicks=[long]$child.StartTime.ToUniversalTime().Ticks
            $snapshotTicks=[long]$row.CreationDate.ToUniversalTime().Ticks
            if ([Math]::Abs([long]($childTicks-$snapshotTicks)) -gt 9 -or $childTicks -lt $root.StartTime.ToUniversalTime().Ticks) { throw 'Process tree changed.' }
            $known[$id]=$true; $depth[$id]=[int]$depth[$parent]+1; $items += @{process=$child;depth=$depth[$id]}
        }
    }
    if (@($snapshot | Where-Object { $known.ContainsKey([int]$_.ParentProcessId) -and -not $known.ContainsKey([int]$_.ProcessId) }).Count) { throw 'Process tree is too deep.' }
    if ($root.HasExited -or $root.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$inputData.creationTicks) { throw 'Process identity changed.' }
    foreach ($item in @($items | Sort-Object -Property depth -Descending)) {
        $process=$item.process
        try { if (-not $process.HasExited) { $process.Kill() } }
        catch { if (-not $process.HasExited) { throw 'A process could not be stopped.' } }
    }
    $timer=[Diagnostics.Stopwatch]::StartNew()
    foreach ($item in $items) {
        $remaining=[Math]::Max(0,12000-[int]$timer.ElapsedMilliseconds)
        if (-not $item.process.WaitForExit($remaining)) { throw 'A process did not exit in time.' }
    }
    # The held handles keep the already-verified PIDs pinned. Catch children
    # created after the initial snapshot, including children orphaned when the
    # parent was terminated, and refuse to report success if the tree changes
    # faster than it can be verified.
    for ($round=0; $round -lt 4; $round++) {
        $late = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $known.ContainsKey([int]$_.ParentProcessId) -and -not $known.ContainsKey([int]$_.ProcessId) })
        if (-not $late.Count) { break }
        foreach ($row in $late) {
            $id=[int]$row.ProcessId
            if ($id -eq $PID -or $id -eq 0 -or $items.Count -ge 128 -or -not $row.CreationDate) { throw 'Process tree could not be verified.' }
            $child=Get-Process -Id $id -ErrorAction Stop; [void]$child.Handle; $held += $child
            $childTicks=[long]$child.StartTime.ToUniversalTime().Ticks; $snapshotTicks=[long]$row.CreationDate.ToUniversalTime().Ticks
            if ([Math]::Abs([long]($childTicks-$snapshotTicks)) -gt 9 -or $childTicks -lt $root.StartTime.ToUniversalTime().Ticks) { throw 'Process tree changed.' }
            $known[$id]=$true; $items += @{process=$child;depth=1}
            if (-not $child.HasExited) { $child.Kill() }
            if (-not $child.WaitForExit([Math]::Max(0,12000-[int]$timer.ElapsedMilliseconds))) { throw 'A process did not exit in time.' }
        }
    }
    if (@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $known.ContainsKey([int]$_.ParentProcessId) -and -not $known.ContainsKey([int]$_.ProcessId) }).Count) { throw 'Process tree could not be verified.' }
    [Console]::Out.Write((@{stopped=$true;processes=$items.Count} | ConvertTo-Json -Compress))
} catch {
    [Console]::Error.Write('The verified process tree could not be stopped. Its state may need review.')
    exit 1
} finally {
    foreach ($process in $held) { try { $process.Dispose() } catch {} }
}
