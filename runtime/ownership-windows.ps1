# Fixed helper invoked with JSON on stdin; never write input or exception details
# to logs. DPAPI is current-user scoped and protects the complete record.
$ErrorActionPreference = 'Stop'
try {
    $inputJson = [Console]::In.ReadToEnd()
    if ($inputJson.Length -gt 131072) { throw 'Input too large' }
    $request = $inputJson | ConvertFrom-Json
    switch ($request.operation) {
        'protect' {
            Add-Type -AssemblyName System.Security
            $bytes = [Text.Encoding]::UTF8.GetBytes([string]$request.value)
            $entropy = [Text.Encoding]::UTF8.GetBytes('Forge engine ownership journal v1')
            $sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
            [Console]::Out.Write(([Convert]::ToBase64String($sealed)))
        }
        'unprotect' {
            Add-Type -AssemblyName System.Security
            $bytes = [Convert]::FromBase64String([string]$request.value)
            $entropy = [Text.Encoding]::UTF8.GetBytes('Forge engine ownership journal v1')
            $clear = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
            [Console]::Out.Write([Text.Encoding]::UTF8.GetString($clear))
        }
        'secure-directory' {
            $directory = [IO.DirectoryInfo]::new([string]$request.path)
            if (-not $directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid directory' }
            $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $acl.SetOwner($sid)
            $acl.SetAccessRuleProtection($true, $false)
            $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
            $directory.SetAccessControl($acl)
            [Console]::Out.Write('ok')
        }
        'process' {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ForgeProcessInfo {
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint low, high; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inheritHandle, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Inspect(int pid) {
    IntPtr process=OpenProcess(0x1000, false, pid);
    if (process==IntPtr.Zero) return Marshal.GetLastWin32Error()==87 ? "absent" : "unknown";
    try {
      uint code; if(!GetExitCodeProcess(process,out code)) return "unknown";
      if(code!=259) return "absent";
      FileTime creation,exit,kernel,user;
      if(!GetProcessTimes(process,out creation,out exit,out kernel,out user)) return "unknown";
      long time=((long)creation.high<<32)|creation.low;
      string ticks=DateTime.FromFileTimeUtc(time).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
      var name=new StringBuilder(32768);int size=name.Capacity;
      if(!QueryFullProcessImageName(process,0,name,ref size)) return "unknown";
      return "alive\n"+ticks+"\n"+name.ToString();
    } finally { CloseHandle(process); }
  }
}
'@
            [Console]::Out.Write([ForgeProcessInfo]::Inspect([int]$request.pid))
        }
        'inspect' {
            $processInfo = Get-Process -Id ([int]$request.pid) -ErrorAction Stop
            $creationTicks = $processInfo.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
            $exe = $processInfo.Path
            if (-not $exe) { throw 'Process path unavailable' }
            Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class ForgeListenerInfo {
  [StructLayout(LayoutKind.Sequential)] struct Row { public uint state, localAddress, localPort, remoteAddress, remotePort, owningPid; }
  [DllImport("iphlpapi.dll", SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
  public static string[] Find(int port) {
    int size=0; uint result=GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
    if (result!=122 || size<=4 || size>67108864) throw new InvalidOperationException();
    IntPtr buffer=Marshal.AllocHGlobal(size);
    try {
      result=GetExtendedTcpTable(buffer, ref size, false, 2, 3, 0);
      if (result!=0) throw new InvalidOperationException();
      int count=Marshal.ReadInt32(buffer), stride=Marshal.SizeOf(typeof(Row));
      if(count<0 || (long)count*stride+4>size) throw new InvalidOperationException();
      var found=new List<string>();
      for(int i=0;i<count;i++) {
        Row row=(Row)Marshal.PtrToStructure(IntPtr.Add(buffer,4+i*stride),typeof(Row));
        int localPort=(int)(((row.localPort&255)<<8)|((row.localPort>>8)&255));
        if(localPort==port) found.Add(new IPAddress((long)row.localAddress).ToString()+":"+row.owningPid.ToString());
      }
      return found.ToArray();
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
'@
            $listeners = @( [ForgeListenerInfo]::Find([int]$request.port) )
            $result = @{pid=[int]$processInfo.Id; creationTicks=$creationTicks; executable=$exe; listeners=$listeners}
            [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
        }
        default { throw 'Unknown operation' }
    }
} catch {
    [Console]::Error.Write('Windows ownership operation failed.')
    exit 1
}
