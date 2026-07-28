[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$DryRun,
  [switch]$Force,
  [switch]$NoStart,
  [switch]$WithHooks,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ThreadnoteArgs
)

$ErrorActionPreference = 'Stop'
$supportedNodeRange = '^22.22.2 || ^24.15.0 || >=26.0.0'
$recommendedNodeVersion = '24.18.0'
$package = if ($env:THREADNOTE_PACKAGE) { $env:THREADNOTE_PACKAGE } else { 'threadnote@latest' }
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

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  $node = Get-Command node -ErrorAction SilentlyContinue
}
if (-not $node) {
  throw 'Node.js was not found on PATH. Install the current Node.js 24 LTS release, then rerun this installer.'
}
$nodeVersion = (& $node.Source -p 'process.versions.node').Trim()
$parts = $nodeVersion -split '\.'
$supportedNode = $parts.Count -ge 3 -and (
  ([int]$parts[0] -eq 22 -and ([int]$parts[1] -gt 22 -or ([int]$parts[1] -eq 22 -and [int]$parts[2] -ge 2))) -or
  ([int]$parts[0] -eq 24 -and [int]$parts[1] -ge 15) -or
  [int]$parts[0] -ge 26
)
if (-not $supportedNode) {
  $guidance = if ($env:NVM_HOME -or $node.Source -match '(?i)[\\/]nvm[\\/]') {
    "nvm-windows: nvm install $recommendedNodeVersion && nvm use $recommendedNodeVersion"
  } else {
    'Windows: winget upgrade --id OpenJS.NodeJS.LTS -e (or install the current Node.js LTS MSI).'
  }
  throw @"
Threadnote requires Node $supportedNodeRange; current runtime is $nodeVersion.
Upgrade Node, open a new terminal, and rerun this installer on the same stable or beta channel.
$guidance
For beta, set `$env:THREADNOTE_PACKAGE = 'threadnote@beta' before rerunning the installer.
Threadnote does not change the system Node installation automatically.
"@
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npm) {
  throw "npm was not found on PATH. Install Node.js $supportedNodeRange, then rerun this installer."
}

$loggedPackage = Format-InstallSourceForLog $package
$loggedRegistry = Format-InstallSourceForLog $registry
Write-Host "Installing $loggedPackage with npm from $loggedRegistry"
$previousNodeLlamaCppPostinstall = $env:NODE_LLAMA_CPP_POSTINSTALL
try {
  $env:NODE_LLAMA_CPP_POSTINSTALL = 'skip'
  & $npm.Source install --global $package "--registry=$registry"
  $installExitCode = $LASTEXITCODE
} finally {
  if ($null -eq $previousNodeLlamaCppPostinstall) {
    Remove-Item Env:NODE_LLAMA_CPP_POSTINSTALL -ErrorAction SilentlyContinue
  } else {
    $env:NODE_LLAMA_CPP_POSTINSTALL = $previousNodeLlamaCppPostinstall
  }
}
if ($installExitCode -ne 0) {
  throw "npm install failed with exit code $installExitCode."
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

$installArgs = @('install')
if ($DryRun) { $installArgs += '--dry-run' }
if ($Force) { $installArgs += '--force' }
if ($NoStart) { $installArgs += '--no-start' }
if ($WithHooks) { $installArgs += '--with-hooks' }
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
