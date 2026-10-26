<#
.SYNOPSIS
  Convenience launcher: starts the dedicated VisitSaudi Chrome window
  (Start-VisitSaudiChrome.ps1) AND the reverse SSH tunnel
  (Start-VisitSaudiTunnel.ps1), each in its own PowerShell window, so you
  can see both logs independently and close either one without closing
  the other.

.PARAMETER Port
  The local CDP port -- passed to Start-VisitSaudiChrome.ps1. Must match
  LocalPort in your visitsaudi-tunnel.config.json. Default 9222.

.PARAMETER ConfigPath
  Path to the tunnel config file -- passed to Start-VisitSaudiTunnel.ps1.
  Default: visitsaudi-tunnel.config.json next to this script.

.EXAMPLE
  .\Start-VisitSaudiSession.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 9222,
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'visitsaudi-tunnel.config.json')
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot

Write-Host "Opening the VisitSaudi Chrome window..."
Start-Process powershell -ArgumentList @(
  '-NoExit', '-ExecutionPolicy', 'Bypass', '-File',
  (Join-Path $scriptDir 'Start-VisitSaudiChrome.ps1'), '-Port', $Port
)

Start-Sleep -Seconds 2

Write-Host "Opening the reverse SSH tunnel..."
Start-Process powershell -ArgumentList @(
  '-NoExit', '-ExecutionPolicy', 'Bypass', '-File',
  (Join-Path $scriptDir 'Start-VisitSaudiTunnel.ps1'), '-ConfigPath', $ConfigPath
)

Write-Host ""
Write-Host "Started Chrome and the tunnel in two separate windows. Keep BOTH open."
Write-Host "Next, by hand: log in to VisitSaudi in the new Chrome window, then leave"
Write-Host "it on the 'Apply for eVisa' dashboard before using /visa_start_submission."
