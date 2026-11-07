# Keep an exclusive Windows share lock for as long as the supervisor owns the
# stdin pipe. Process death closes the pipe and disposes the file handle.
$ErrorActionPreference='Stop'
$stream=$null
try {
    $line=[Console]::In.ReadLine()
    if (-not $line -or $line.Length -gt 32768) { throw 'Invalid request' }
    $request=$line | ConvertFrom-Json
    $stream=[IO.FileStream]::new([string]$request.path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForgeOwnershipCommit {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool MoveFileEx(string source, string target, uint flags);
}
'@
    $directory=[IO.Path]::GetDirectoryName([string]$request.path)
    [Console]::Out.WriteLine('{"type":"locked"}')
    [Console]::Out.Flush()
    while ($null -ne ($line=[Console]::In.ReadLine())) {
        $reply=@{type='reply';id=$null;ok=$false;code='invalid'}
        $temp=$null
        try {
            if($line.Length -gt 131072){throw 'Input too large'}
            $command=$line | ConvertFrom-Json
            $reply.id=$command.id
            if($command.id -isnot [int] -and $command.id -isnot [long]){throw 'Invalid request ID'}
            if([string]$command.file -notmatch '^[a-z0-9][a-z0-9-]{0,63}\.json$'){throw 'Invalid file'}
            $target=[IO.Path]::Combine($directory,[string]$command.file)
            if([IO.File]::Exists($target) -and (([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'Invalid file'}
            if($command.operation -in @('replace','remove')){
                if(-not [IO.File]::Exists($target)){$reply.code='conflict';throw 'Missing record'}
                $old=[IO.File]::ReadAllText($target,[Text.Encoding]::UTF8)
                if($old -cne [string]$command.expected){$reply.code='conflict';throw 'Record changed'}
            }
            if($command.operation -in @('create','replace')){
                $content=[string]$command.content
                if($content.Length -gt 100000){throw 'Record too large'}
                $wrapper=$content | ConvertFrom-Json
                if($wrapper.version -ne 1 -or [string]$wrapper.ciphertext -notmatch '^[A-Za-z0-9+/]+={0,2}$' -or $wrapper.ciphertext.Length -gt 65536){throw 'Invalid record'}
                $temp=[IO.Path]::Combine($directory,('.ownership-'+[Guid]::NewGuid().ToString('N')+'.tmp'))
                $file=[IO.FileStream]::new($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes($content);$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
                if($command.operation -eq 'create'){
                    if([IO.File]::Exists($target)){$reply.code='conflict';throw 'Record exists'}
                    [IO.File]::Move($temp,$target)
                } else {
                    # Same-volume atomic replacement, with write-through. The
                    # exact old ciphertext was checked while holding the lock.
                    if(-not [ForgeOwnershipCommit]::MoveFileEx($temp,$target,0x9)){throw 'Replace failed'}
                }
                $temp=$null
            } elseif($command.operation -eq 'remove') {
                [IO.File]::Delete($target)
            } else {throw 'Invalid operation'}
            $reply.ok=$true;$reply.code='ok'
        } catch {
            if($reply.code -eq 'invalid'){$reply.code='error'}
        } finally {
            if($temp){try{[IO.File]::Delete($temp)}catch{}}
        }
        [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    }
} catch {
    [Console]::Error.Write('Ownership lock unavailable.')
    exit 1
} finally {
    if($stream){$stream.Dispose()}
}
