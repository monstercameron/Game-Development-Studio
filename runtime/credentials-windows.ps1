# Receives secrets over stdin, never command-line arguments or logs.
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Security
  $entropy = [Text.Encoding]::UTF8.GetBytes('Forge Studio API credentials v1')
  if ($request.operation -eq 'protect') {
    $value = [Text.Encoding]::UTF8.GetBytes([string]$request.value)
    $result = [Security.Cryptography.ProtectedData]::Protect($value,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($result))
    [Array]::Clear($value,0,$value.Length)
  } elseif ($request.operation -eq 'unprotect') {
    $value = [Convert]::FromBase64String([string]$request.value)
    $result = [Security.Cryptography.ProtectedData]::Unprotect($value,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))
    [Array]::Clear($result,0,$result.Length)
  } else { throw 'Invalid operation' }
} catch { exit 1 }
