<#
.SYNOPSIS
  Launches a DEDICATED Chrome window for VisitSaudi only, with its own
  isolated profile and a Chrome DevTools Protocol (CDP) debugging port
  bound to loopback only.

.DESCRIPTION
  This NEVER touches your everyday Chrome profile or session -- it uses a
  SEPARATE --user-data-dir, so VisitSaudi's own cookies/login never mix
  with your regular browsing, and your regular Chrome is never exposed
  over CDP.

  --remote-debugging-port is bound to 127.0.0.1 ONLY (Chrome's own
  default whenever --remote-debugging-address is not given) -- it is
  never reachable from your local network or the internet, only from
  this same Windows machine. The reverse SSH tunnel
  (Start-VisitSaudiTunnel.ps1) is what later makes this one port reachable
  from the server -- over an encrypted tunnel, still never as an open
  network port.

  This script does NOT log in to VisitSaudi for you and never will.
  Once Chrome opens, navigate to the VisitSaudi site and log in BY HAND,
  exactly as you always do. Leave that tab open on the "Apply for eVisa"
  dashboard (the page showing the "APPLY FOR GROUP" button) before
  triggering /visa_start_submission in Telegram -- the backend looks for
  that exact, already-confirmed text to find the right tab, and will
  safely refuse to guess if it is not there or if there are several
  matching tabs open.

.PARAMETER Port
  The local CDP debugging port Chrome listens on. Default 9222. Must
  match the LocalPort used in your visitsaudi-tunnel.config.json
  (Start-VisitSaudiTunnel.ps1).

.PARAMETER ProfileDir
  Where Chrome stores this DEDICATED, VisitSaudi-only profile. Default:
  $env:LOCALAPPDATA\VisitSaudiChromeProfile

.EXAMPLE
  .\Start-VisitSaudiChrome.ps1
  .\Start-VisitSaudiChrome.ps1 -Port 9333
#>
[CmdletBinding()]
param(
  [int]$Port = 9222,
  [string]$ProfileDir = (Join-Path $env:LOCALAPPDATA 'VisitSaudiChromeProfile')
)

$ErrorActionPreference = 'Stop'

function Find-ChromeExe {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }
  throw "Could not find chrome.exe in the usual install locations. Set an environment variable CHROME_EXE to the full path of chrome.exe and re-run this script."
}

$chromeExe = if ($env:CHROME_EXE -and (Test-Path $env:CHROME_EXE)) { $env:CHROME_EXE } else { Find-ChromeExe }

if (-not (Test-Path $ProfileDir)) {
  New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}

Write-Host "Starting a DEDICATED Chrome window for VisitSaudi only (never your regular Chrome profile)."
Write-Host "  Chrome:   $chromeExe"
Write-Host "  Profile:  $ProfileDir"
Write-Host "  CDP port: 127.0.0.1:$Port (loopback only -- never exposed to your network)"
Write-Host ""
Write-Host "Next steps, by hand, once Chrome opens:"
Write-Host "  1. Log in to VisitSaudi yourself, exactly as you always do."
Write-Host "  2. Leave the tab open on the 'Apply for eVisa' dashboard"
Write-Host "     (showing the APPLY FOR GROUP button) before using /visa_start_submission."
Write-Host "  3. Keep only ONE such tab open -- the backend refuses to guess if it finds more than one."
Write-Host ""

Start-Process -FilePath $chromeExe -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$ProfileDir`"",
  '--no-first-run',
  '--no-default-browser-check'
)
