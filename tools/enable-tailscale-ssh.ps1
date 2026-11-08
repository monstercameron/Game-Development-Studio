[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$tailscalePath = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$sshService = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
$tailscaleAdapter = @(Get-NetAdapter -IncludeHidden | Where-Object {
    $_.InterfaceDescription -eq 'Tailscale Tunnel'
})
$defaultRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
$forgeRule = Get-NetFirewallRule -Name 'Forge-Tailscale-OpenSSH' -ErrorAction SilentlyContinue
$sshConfigPath = Join-Path $env:ProgramData 'ssh\sshd_config'

Write-Output "Tailscale installed: $(Test-Path -LiteralPath $tailscalePath)"
Write-Output "Tailscale adapters found: $($tailscaleAdapter.Count)"
Write-Output "OpenSSH service present: $([bool]$sshService)"
Write-Output "Existing OpenSSH firewall rule: $([bool]$defaultRule)"
Write-Output "Forge Tailscale firewall rule: $([bool]$forgeRule)"
Write-Output "Existing OpenSSH configuration: $(Test-Path -LiteralPath $sshConfigPath)"

if ($CheckOnly) {
    return
}

$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdministrator) {
    throw 'Run this setup in an administrator PowerShell window. Use -CheckOnly for a read-only check.'
}
if (-not (Test-Path -LiteralPath $tailscalePath) -or $tailscaleAdapter.Count -ne 1) {
    throw 'Install Tailscale and verify that exactly one Tailscale Tunnel adapter exists first.'
}
if ($sshService -or $defaultRule -or $forgeRule -or (Test-Path -LiteralPath $sshConfigPath)) {
    throw 'Existing SSH service, configuration, or firewall rules were found. Nothing was changed; review the existing setup manually.'
}

$capabilityName = 'OpenSSH.Server~~~~0.0.1.0'
$capability = Get-WindowsCapability -Online -Name $capabilityName
if ($capability.State -ne 'NotPresent') {
    throw "OpenSSH Server is $($capability.State), not absent. Nothing was changed; review the existing setup manually."
}

if (-not $PSCmdlet.ShouldProcess('Windows OpenSSH Server', 'Install and allow SSH only on the Tailscale adapter')) {
    return
}

# Windows creates a broad inbound rule during installation. Keep the service
# stopped until that newly created rule is disabled and the scoped rule exists.
$installationStarted = $false
try {
    $installationStarted = $true
    Add-WindowsCapability -Online -Name $capabilityName | Out-Null
    $installedService = Get-Service -Name 'sshd' -ErrorAction Stop
    if ($installedService.Status -ne 'Stopped') {
        Stop-Service -Name 'sshd' -ErrorAction Stop
    }
    $createdDefaultRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
    if ($createdDefaultRule) {
        Disable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' | Out-Null
    }
    New-NetFirewallRule -Name 'Forge-Tailscale-OpenSSH' `
        -DisplayName 'Forge private access: OpenSSH over Tailscale' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 `
        -InterfaceAlias $tailscaleAdapter[0].Name -Profile Any | Out-Null
    Set-Service -Name 'sshd' -StartupType Automatic
    Start-Service -Name 'sshd'
} catch {
    if ($installationStarted) {
        Stop-Service -Name 'sshd' -ErrorAction SilentlyContinue
        Disable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Out-Null
    }
    throw "OpenSSH setup did not finish. It attempted to stop the service and disable the default inbound rule; verify both before retrying. $($_.Exception.Message)"
}

Write-Output 'OpenSSH is running. Its inbound firewall rule is limited to the Tailscale adapter.'
Write-Output 'SSH grants access to the Windows account, not only Forge; use a strong password or SSH key.'
Write-Output 'See docs/TAILSCALE_REMOTE.md for the laptop tunnel command.'
