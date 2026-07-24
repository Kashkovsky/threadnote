[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$DryRun,
  [switch]$Force,
  [switch]$NoStart,
  [switch]$WithHooks,
  [ValidateSet('uv', 'pipx', 'pip')]
  [string]$PackageManager,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ThreadnoteArgs
)

$ErrorActionPreference = 'Stop'
$package = if ($env:THREADNOTE_PACKAGE) { $env:THREADNOTE_PACKAGE } else { 'threadnote@beta' }
$registry = if ($env:THREADNOTE_NPM_REGISTRY) {
  $env:THREADNOTE_NPM_REGISTRY
} else {
  'https://registry.npmjs.org/'
}

function Format-InstallSourceForLog {
  param([Parameter(Mandatory = $true)][string]$Value)

  $redacted = $Value -replace '(?i)(https?://)[^/@\s]+@', '$1[REDACTED]@'
  return $redacted -replace '(\?)[^#\s]+', '$1[REDACTED]'
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npm) {
  throw 'npm was not found on PATH. Install Node.js 22.19 or newer, then rerun this installer.'
}

$loggedPackage = Format-InstallSourceForLog $package
$loggedRegistry = Format-InstallSourceForLog $registry
Write-Host "Installing $loggedPackage with npm from $loggedRegistry"
& $npm.Source install --global $package "--registry=$registry"
if ($LASTEXITCODE -ne 0) {
  throw "npm install failed with exit code $LASTEXITCODE."
}

$prefix = (& $npm.Source prefix --global).Trim()
$threadnotePath = if ($prefix) { Join-Path $prefix 'threadnote.cmd' } else { $null }
if (-not $threadnotePath -or -not (Test-Path -LiteralPath $threadnotePath)) {
  $threadnote = Get-Command threadnote.cmd -ErrorAction SilentlyContinue
  if (-not $threadnote) {
    throw "Installed $package, but threadnote.cmd could not be found."
  }
  $threadnotePath = $threadnote.Source
}

$needsUv = -not $PackageManager -or $PackageManager -eq 'uv'
if ($needsUv -and -not (Get-Command uv.exe -ErrorAction SilentlyContinue) -and -not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing uv for the isolated OpenViking environment'
  $powerShellModulePath = Join-Path $PSHOME 'Modules'
  if (-not (($env:PSModulePath -split ';') -contains $powerShellModulePath)) {
    $env:PSModulePath = "$powerShellModulePath;$env:PSModulePath"
  }
  $securityModule = Join-Path $powerShellModulePath 'Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
  if (Test-Path -LiteralPath $securityModule) {
    Import-Module $securityModule -Force -ErrorAction Stop
  }
  Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
  $uvBin = Join-Path $HOME '.local\bin'
  if (Test-Path -LiteralPath $uvBin) {
    $env:Path = "$uvBin;$env:Path"
  }
}

$installArgs = @('install')
if ($DryRun) { $installArgs += '--dry-run' }
if ($Force) { $installArgs += '--force' }
if ($NoStart) { $installArgs += '--no-start' }
if ($WithHooks) { $installArgs += '--with-hooks' }
if ($PackageManager) { $installArgs += @('--package-manager', $PackageManager) }
if ($ThreadnoteArgs) { $installArgs += $ThreadnoteArgs }

Write-Host 'Running threadnote install'
& $threadnotePath @installArgs
if ($LASTEXITCODE -ne 0) {
  throw "threadnote install failed with exit code $LASTEXITCODE."
}

Write-Host ''
Write-Host 'Threadnote is installed. Next:'
Write-Host '  threadnote doctor --dry-run'
Write-Host '  threadnote mcp-install codex --apply    # if you use Codex'
Write-Host '  threadnote mcp-install claude --apply   # if you use Claude'
Write-Host '  threadnote mcp-install cursor --apply   # if you use Cursor'
