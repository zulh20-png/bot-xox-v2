<#
One-file portable VPS helper (copy to any project folder).

Works with:
- OpenSSH (ssh/scp) interactive (will prompt password if needed)
- PuTTY (plink/pscp) password mode for non-interactive exec/upload/download

No secrets are stored in this file. Use env vars or prompts.

Env vars (optional):
  VPS_HOST, VPS_USER, VPS_PORT, VPS_KEY_PATH
  VPS_PASSWORD (PuTTY only), VPS_HOSTKEY (PuTTY only; required for -batch)

Examples:
  powershell -ExecutionPolicy Bypass -File .\vps.ps1 -Action whoami -VpsHost 72.60.198.106 -User root -AcceptNewHostKey
  powershell -ExecutionPolicy Bypass -File .\vps.ps1 -Action ssh -VpsHost 72.60.198.106 -User root -AcceptNewHostKey
  powershell -ExecutionPolicy Bypass -File .\vps.ps1 -Action exec -Cmd "ls -la /opt" -VpsHost 72.60.198.106 -User root

Password non-interactive (plink/pscp):
  powershell -ExecutionPolicy Bypass -File .\vps.ps1 -Action exec -Cmd "whoami" -VpsHost 72.60.198.106 -User root -UsePassword -HostKey "ssh-ed25519 255 SHA256:..."
  powershell -ExecutionPolicy Bypass -File .\vps.ps1 -Action upload -Local ".\a.txt" -Remote "/root/a.txt" -VpsHost 72.60.198.106 -User root -UsePassword -HostKey "ssh-ed25519 255 SHA256:..."
#>

Param(
  [Parameter(Mandatory = $false)]
  [ValidateSet('init','init_env','ssh','exec','upload','download','whoami')]
  [string]$Action = 'ssh',

  [Parameter(Mandatory = $false)]
  [string]$Cmd = '',

  [Parameter(Mandatory = $false)]
  [string]$VpsHost = $env:VPS_HOST,

  [Parameter(Mandatory = $false)]
  [string]$User = $env:VPS_USER,

  [Parameter(Mandatory = $false)]
  [int]$Port = $(if ($env:VPS_PORT) { [int]$env:VPS_PORT } else { 22 }),

  # OpenSSH key auth (optional)
  [Parameter(Mandatory = $false)]
  [string]$KeyPath = $env:VPS_KEY_PATH,

  # Password mode (PuTTY plink/pscp)
  [Parameter(Mandatory = $false)]
  [switch]$UsePassword,

  [Parameter(Mandatory = $false)]
  [string]$Password = $env:VPS_PASSWORD,

  # PuTTY host key fingerprint string, e.g.: ssh-ed25519 255 SHA256:xxxxx
  [Parameter(Mandatory = $false)]
  [string]$HostKey = $env:VPS_HOSTKEY,

  # Upload/download paths
  [Parameter(Mandatory = $false)]
  [string]$Local = '',

  [Parameter(Mandatory = $false)]
  [string]$Remote = '',

  # For OpenSSH: auto accept new host key on first connect
  [Parameter(Mandatory = $false)]
  [switch]$AcceptNewHostKey
)

$ErrorActionPreference = "Stop"

function Get-LocalConfigPath {
  return (Join-Path $PSScriptRoot ".vps.local.json")
}

function Protect-Password {
  Param([string]$Plain)
  $sec = ConvertTo-SecureString -String $Plain -AsPlainText -Force
  return (ConvertFrom-SecureString -SecureString $sec) # DPAPI (current user, local machine)
}

function Unprotect-Password {
  Param([string]$Encrypted)
  if (-not $Encrypted) { return $null }
  $sec = ConvertTo-SecureString -String $Encrypted
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Load-LocalConfig {
  $p = Get-LocalConfigPath
  if (-not (Test-Path $p)) { return $null }
  try {
    return (Get-Content $p -Raw | ConvertFrom-Json)
  } catch {
    throw "Failed to parse $p. Delete it and run -Action init again."
  }
}

function Save-LocalConfig {
  Param([object]$Cfg)
  $p = Get-LocalConfigPath
  ($Cfg | ConvertTo-Json -Depth 10) | Set-Content -Encoding UTF8 $p
}

function Init-Config {
  $p = Get-LocalConfigPath
  Write-Host "Creating local VPS config at: $p"
  Write-Host "Note: password will be stored encrypted (Windows DPAPI) for this Windows user only."

  $cfg = [ordered]@{}
  while ($true) {
    $cfg.vps_host = Read-Host "VPS host (IP/domain) (example: 72.60.198.106)"
    if ($cfg.vps_host) { break }
    Write-Host "Host is required." -ForegroundColor Yellow
  }
  while ($true) {
    $cfg.vps_user = Read-Host "VPS user (example: root)"
    if ($cfg.vps_user) { break }
    Write-Host "User is required." -ForegroundColor Yellow
  }
  $portInput = Read-Host "VPS port (default 22)"
  $cfg.vps_port = $(if ($portInput) { [int]$portInput } else { 22 })

  $mode = Read-Host "Auth mode: key / password (default key if you have one)"
  if (-not $mode) { $mode = "key" }
  $mode = $mode.ToLowerInvariant()

  if ($mode -eq "password") {
    $cfg.use_password = $true
    $cfg.vps_hostkey = Read-Host "PuTTY hostkey fingerprint (example: ssh-ed25519 255 SHA256:...)"
    if (-not $cfg.vps_hostkey) { throw "Hostkey is required for password mode." }
    $pw = Read-Host "VPS password"
    if (-not $pw) { throw "Password is required for password mode." }
    $cfg.vps_password_enc = Protect-Password -Plain $pw
  } else {
    $cfg.use_password = $false
    $defaultKey = Join-Path $env:USERPROFILE ".ssh\\id_ed25519"
    $kp = Read-Host "SSH private key path (blank to skip) (example: $defaultKey)"
    if ($kp) { $cfg.vps_key_path = $kp }
  }

  Save-LocalConfig -Cfg $cfg
  Write-Host "Saved. You can now run: powershell -ExecutionPolicy Bypass -File .\\vps.ps1 -Action whoami"
}

function Init-FromEnv {
  $p = Get-LocalConfigPath
  $h = $env:VPS_HOST
  $u = $env:VPS_USER
  $port = $(if ($env:VPS_PORT) { [int]$env:VPS_PORT } else { 22 })
  $keyPath = $env:VPS_KEY_PATH
  $pw = $env:VPS_PASSWORD
  $hk = $env:VPS_HOSTKEY

  if (-not $h) { throw "VPS_HOST missing in env." }
  if (-not $u) { throw "VPS_USER missing in env." }

  $cfg = [ordered]@{
    vps_host = $h
    vps_user = $u
    vps_port = $port
  }

  if ($pw) {
    if (-not $hk) { throw "VPS_HOSTKEY missing in env (required when VPS_PASSWORD is set)." }
    $cfg.use_password = $true
    $cfg.vps_hostkey = $hk
    $cfg.vps_password_enc = Protect-Password -Plain $pw
  } else {
    $cfg.use_password = $false
    if ($keyPath) { $cfg.vps_key_path = $keyPath }
  }

  ($cfg | ConvertTo-Json -Depth 10) | Set-Content -Encoding UTF8 $p
  Write-Host "Wrote local VPS config from env: $p"
}

function Assert-Config {
  if (-not $VpsHost) { throw "Missing VPS host. Set `$env:VPS_HOST or pass -VpsHost." }
  if (-not $User) { throw "Missing VPS user. Set `$env:VPS_USER or pass -User." }
}

function Find-PuTTYTool {
  Param([string]$ExeName)
  $cmd = Get-Command $ExeName -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Path }

  # Known locations on this machine (edit if needed)
  $knownDirs = @(
    "C:\\Users\\pro_x\\bot-onexox",
    "C:\\Users\\pro_x\\bot-onexox-QRcode"
  )
  foreach ($d in $knownDirs) {
    $p = Join-Path $d $ExeName
    if (Test-Path $p) { return $p }
  }
  return $null
}

function New-OpenSshArgs {
  $args = @("-p", "$Port")
  if ($KeyPath) { $args += @("-i", "$KeyPath") }
  if ($AcceptNewHostKey) { $args += @("-o", "StrictHostKeyChecking=accept-new") }
  return $args
}

function Ensure-PuTTYPasswordMode {
  if (-not $HostKey) { throw "Password mode requires -HostKey (or set `$env:VPS_HOSTKEY) to avoid host key prompts." }
  if (-not $Password) { $Password = Read-Host "VPS password (stored in this PowerShell session only)" }
}

function Invoke-PlinkBatch {
  Param([string]$RemoteCommand)
  $plink = Find-PuTTYTool "plink.exe"
  if (-not $plink) { throw "plink.exe not found. Put plink.exe on PATH or in known dirs." }
  Ensure-PuTTYPasswordMode

  $target = "$User@$VpsHost"
  $args = @("-batch", "-ssh", "-P", "$Port", "-pw", "$Password", "-hostkey", "$HostKey", $target, $RemoteCommand)
  & $plink @args
  if ($LASTEXITCODE -ne 0) { throw "plink failed (exit $LASTEXITCODE)" }
}

function Invoke-PlinkShell {
  $plink = Find-PuTTYTool "plink.exe"
  if (-not $plink) { throw "plink.exe not found. Put plink.exe on PATH or in known dirs." }
  Ensure-PuTTYPasswordMode

  $target = "$User@$VpsHost"
  $args = @("-ssh", "-P", "$Port", "-pw", "$Password", "-hostkey", "$HostKey", $target)
  & $plink @args
  if ($LASTEXITCODE -ne 0) { throw "plink failed (exit $LASTEXITCODE)" }
}

function Invoke-Remote {
  Param([string]$RemoteCommand)
  if ($UsePassword) { return Invoke-PlinkBatch -RemoteCommand $RemoteCommand }
  $args = New-OpenSshArgs
  & ssh.exe @args "$User@$VpsHost" $RemoteCommand
}

function Copy-ToRemote {
  Param([string]$LocalPath, [string]$RemotePath)
  if (-not $LocalPath -or -not $RemotePath) { throw "upload requires -Local and -Remote" }
  if (-not (Test-Path $LocalPath)) { throw "Local file not found: $LocalPath" }

  if ($UsePassword) {
    $pscp = Find-PuTTYTool "pscp.exe"
    if ($pscp) {
      Ensure-PuTTYPasswordMode
      $target = "${User}@${VpsHost}:$RemotePath"
      $args = @("-batch", "-P", "$Port", "-pw", "$Password", "-hostkey", "$HostKey", $LocalPath, $target)
      & $pscp @args
      if ($LASTEXITCODE -ne 0) { throw "pscp upload failed (exit $LASTEXITCODE)" }
      return
    }

    # Fallback: base64 upload via plink (avoids needing pscp.exe). Suitable for files.
    Ensure-PuTTYPasswordMode
    $plink = Find-PuTTYTool "plink.exe"
    if (-not $plink) { throw "plink.exe not found. Put plink.exe on PATH or in known dirs." }

    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $LocalPath))
    $b64 = [Convert]::ToBase64String($bytes)
    $remoteCmd = "sh -lc ""umask 077; base64 -d > '$RemotePath'"""

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $plink
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.Arguments = @(
      "-batch", "-ssh", "-P", "$Port", "-pw", "$Password", "-hostkey", "$HostKey",
      "$User@$VpsHost", $remoteCmd
    ) -join " "

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $proc.StandardInput.WriteLine($b64)
    $proc.StandardInput.Close()
    $out = $proc.StandardOutput.ReadToEnd()
    $err = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) { throw "plink base64 upload failed (exit $($proc.ExitCode)): $err" }
    return
  }

  $args = @("-P", "$Port")
  if ($KeyPath) { $args += @("-i", "$KeyPath") }
  if ($AcceptNewHostKey) { $args += @("-o", "StrictHostKeyChecking=accept-new") }
  & scp.exe @args $LocalPath "${User}@${VpsHost}:$RemotePath"
}

function Copy-FromRemote {
  Param([string]$RemotePath, [string]$LocalPath)
  if (-not $LocalPath -or -not $RemotePath) { throw "download requires -Local and -Remote" }

  if ($UsePassword) {
    $pscp = Find-PuTTYTool "pscp.exe"
    if ($pscp) {
      Ensure-PuTTYPasswordMode
      $src = "${User}@${VpsHost}:$RemotePath"
      $args = @("-batch", "-P", "$Port", "-pw", "$Password", "-hostkey", "$HostKey", $src, $LocalPath)
      & $pscp @args
      if ($LASTEXITCODE -ne 0) { throw "pscp download failed (exit $LASTEXITCODE)" }
      return
    }

    # Fallback: base64 download via plink (avoids needing pscp.exe). Suitable for files.
    Ensure-PuTTYPasswordMode
    $plink = Find-PuTTYTool "plink.exe"
    if (-not $plink) { throw "plink.exe not found. Put plink.exe on PATH or in known dirs." }

    $remoteCmd = "sh -lc ""base64 -w0 '$RemotePath'"""
    $b64 = Invoke-PlinkBatch -RemoteCommand $remoteCmd
    if (-not $b64) { throw "No data received from remote file (maybe missing?): $RemotePath" }
    $bytes = [Convert]::FromBase64String(($b64 -replace '\\s+',''))
    $dir = Split-Path $LocalPath -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllBytes($LocalPath, $bytes)
    return
  }

  $args = @("-P", "$Port")
  if ($KeyPath) { $args += @("-i", "$KeyPath") }
  if ($AcceptNewHostKey) { $args += @("-o", "StrictHostKeyChecking=accept-new") }
  & scp.exe @args "${User}@${VpsHost}:$RemotePath" $LocalPath
}

if ($Action -eq 'init') {
  Init-Config
  exit 0
}

if ($Action -eq 'init_env') {
  Init-FromEnv
  exit 0
}

# Load local config if present and fill missing values.
$localCfg = Load-LocalConfig
if ($localCfg) {
  if (-not $VpsHost -and $localCfg.vps_host) { $VpsHost = $localCfg.vps_host }
  if (-not $User -and $localCfg.vps_user) { $User = $localCfg.vps_user }
  if (-not $Port -and $localCfg.vps_port) { $Port = [int]$localCfg.vps_port }
  if (-not $KeyPath -and $localCfg.vps_key_path) { $KeyPath = $localCfg.vps_key_path }
  if (-not $HostKey -and $localCfg.vps_hostkey) { $HostKey = $localCfg.vps_hostkey }
  if (-not $UsePassword -and $localCfg.use_password) { $UsePassword = [bool]$localCfg.use_password }
  if ($UsePassword -and -not $Password -and $localCfg.vps_password_enc) {
    $Password = Unprotect-Password -Encrypted $localCfg.vps_password_enc
  }
}

Assert-Config

switch ($Action) {
  'ssh' {
    if ($UsePassword) {
      Invoke-PlinkShell
    } else {
      $args = New-OpenSshArgs
      & ssh.exe @args "$User@$VpsHost"
    }
  }
  'exec' {
    if (-not $Cmd) { throw "exec requires -Cmd" }
    Invoke-Remote -RemoteCommand $Cmd
  }
  'upload' {
    Copy-ToRemote -LocalPath $Local -RemotePath $Remote
  }
  'download' {
    Copy-FromRemote -RemotePath $Remote -LocalPath $Local
  }
  'whoami' {
    Invoke-Remote -RemoteCommand "whoami && hostname && pwd"
  }
}
