<#
.SYNOPSIS
  Opens a REVERSE SSH tunnel from this Windows machine to the OCRumra
  server, exposing this machine's local Chrome CDP port (see
  Start-VisitSaudiChrome.ps1) as a LOOPBACK-ONLY port on the server.

.DESCRIPTION
  Runs `ssh -N -R 127.0.0.1:<RemotePort>:127.0.0.1:<LocalPort> ...` in a
  retry loop so the tunnel reconnects automatically after a dropped
  connection (network blip, this machine sleeping, a server restart).
  Both sides of the -R argument are given an EXPLICIT 127.0.0.1 bind
  address -- matching, byte for byte, the exact form already confirmed
  working against this project's own server (whose sshd restricts the
  tunnel user to `PermitListen 127.0.0.1:<port>`, a literal address:port
  allow-list). An earlier version of this script omitted the explicit
  address (`-R <port>:localhost:<port>`); omitting it is expected, by
  OpenSSH's own documented GatewayPorts behavior, to resolve to the same
  loopback bind -- but that was never the form actually tested against
  this server's PermitListen rule, so it is no longer used here. This
  script never exposes anything to the public internet by itself; whether
  the forwarded port stays loopback-only ON THE SERVER depends entirely
  on the server's own sshd configuration (GatewayPorts) -- this script
  cannot and does not change that. See README.md's own
  "Server administratoriga kerak bo'ladigan sozlamalar" section for the
  exact settings to confirm with whoever administers the server; this
  script does not connect to or configure the server beyond opening the
  tunnel itself.

  Connection settings (host, username, SSH key path, ports) are read from
  a LOCAL, NEVER-COMMITTED config file -- copy
  visitsaudi-tunnel.config.example.json to visitsaudi-tunnel.config.json
  (next to this script) and fill in your own values. That file is listed
  in this repository's own .gitignore; no secret value is ever hardcoded
  in this script.

.PARAMETER ConfigPath
  Path to the JSON config file. Default: visitsaudi-tunnel.config.json
  next to this script.

.PARAMETER RetryDelaySeconds
  How long to wait before reconnecting after a dropped/failed connection.
  Default 5.

.EXAMPLE
  .\Start-VisitSaudiTunnel.ps1
  .\Start-VisitSaudiTunnel.ps1 -ConfigPath C:\secrets\my-tunnel.json
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'visitsaudi-tunnel.config.json'),
  [int]$RetryDelaySeconds = 5
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ConfigPath)) {
  throw "Config file not found: $ConfigPath`n`nCopy visitsaudi-tunnel.config.example.json to visitsaudi-tunnel.config.json (next to this script) and fill in your own SshHost / SshUser / SshKeyPath first. Never commit the real config file."
}

$config = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json

foreach ($requiredField in @('SshHost', 'SshUser', 'SshKeyPath', 'RemotePort', 'LocalPort')) {
  if (-not $config.$requiredField) {
    throw "Config file $ConfigPath is missing required field: $requiredField"
  }
}

if (-not (Test-Path $config.SshKeyPath)) {
  throw "SSH private key not found at $($config.SshKeyPath) -- check SshKeyPath in $ConfigPath."
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw "The 'ssh' command was not found. On Windows 10/11, enable it via: Settings -> Apps -> Optional Features -> Add a feature -> OpenSSH Client."
}

Write-Host "Reverse SSH tunnel: server's own 127.0.0.1:$($config.RemotePort) -> this machine's 127.0.0.1:$($config.LocalPort)"
Write-Host "  Target: $($config.SshUser)@$($config.SshHost)"
Write-Host "  Key:    $($config.SshKeyPath)"
Write-Host ""
Write-Host "Keep this window open while using /visa_start_submission. Press Ctrl+C to stop."
Write-Host ""

while ($true) {
  try {
    & ssh -N `
      -o ServerAliveInterval=15 `
      -o ServerAliveCountMax=3 `
      -o ExitOnForwardFailure=yes `
      -o StrictHostKeyChecking=accept-new `
      -i $config.SshKeyPath `
      -R "127.0.0.1:$($config.RemotePort):127.0.0.1:$($config.LocalPort)" `
      "$($config.SshUser)@$($config.SshHost)"
  } catch {
    Write-Warning "ssh exited unexpectedly: $_"
  }

  Write-Warning "Tunnel disconnected (or the server could not be reached). Retrying in $RetryDelaySeconds seconds... (Ctrl+C to stop)"
  Start-Sleep -Seconds $RetryDelaySeconds
}
