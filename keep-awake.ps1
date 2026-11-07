param([Parameter(Mandatory=$true)][int]$ParentProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StudioPowerRequest {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
# This thread holds a Windows system-required request until the helper exits.
$result = [StudioPowerRequest]::SetThreadExecutionState([uint32]2147483649)
if ($result -eq 0) { throw 'Windows could not create a keep-awake request.' }
try {
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    while ($true) {
        Start-Sleep -Seconds 5
        if (-not (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { break }
    }
} finally {
    [void][StudioPowerRequest]::SetThreadExecutionState([uint32]2147483648)
}
