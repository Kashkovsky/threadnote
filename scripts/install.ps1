[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Beta,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$NoStart,
  [switch]$WithHooks,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ThreadnoteArgs
)

$ErrorActionPreference = 'Stop'
$repository = if ($env:THREADNOTE_REPOSITORY) { $env:THREADNOTE_REPOSITORY } else { 'Kashkovsky/threadnote' }
$channel = if ($Beta) { 'beta' } elseif ($env:THREADNOTE_CHANNEL) { $env:THREADNOTE_CHANNEL } else { 'latest' }
$releaseSource = if ($env:THREADNOTE_RELEASE_SOURCE) {
  $env:THREADNOTE_RELEASE_SOURCE
} else {
  "https://api.github.com/repos/$repository/releases?per_page=100"
}
$installationLockWait = [TimeSpan]::FromMinutes(10)
$installationLockPath = $null
$installationLockToken = $null

function Release-ThreadnoteInstallationLock {
  if (-not $script:installationLockPath -or -not $script:installationLockToken) { return }
  try {
    $observed = (Get-Content -LiteralPath $script:installationLockPath -Raw -ErrorAction Stop).Trim()
    if ($observed -ceq $script:installationLockToken) {
      Remove-Item -LiteralPath $script:installationLockPath -Force -ErrorAction Stop
    }
  } catch [System.IO.FileNotFoundException], [System.Management.Automation.ItemNotFoundException] {
  }
  $script:installationLockPath = $null
  $script:installationLockToken = $null
}

function Enter-ThreadnoteInstallationLock {
  param([Parameter(Mandatory = $true)][string]$Path)
  $script:installationLockPath = $Path
  $script:installationLockToken = "$PID`:bootstrap-installer:$([Guid]::NewGuid().ToString('N'))"
  $startedAt = [DateTimeOffset]::UtcNow
  while ($true) {
    try {
      $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $content = [Text.Encoding]::UTF8.GetBytes("$($script:installationLockToken)`n")
        $stream.Write($content, 0, $content.Length)
        $stream.Flush($true)
      } finally {
        $stream.Dispose()
      }
      return
    } catch [System.IO.IOException] {
      $observed = try {
        (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop).Trim()
      } catch {
        ''
      }
      $ownerText = ($observed -split ':', 2)[0]
      $ownerProcessId = 0
      if ([int]::TryParse($ownerText, [ref]$ownerProcessId)) {
        $owner = Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue
        if (-not $owner) {
          $current = try {
            (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop).Trim()
          } catch {
            ''
          }
          if ($current -ceq $observed) {
            Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            continue
          }
        }
      }
      if ([DateTimeOffset]::UtcNow - $startedAt -ge $installationLockWait) {
        throw "Timed out waiting for Threadnote installation lock: $Path"
      }
      Start-Sleep -Milliseconds 100
    }
  }
}

function ConvertTo-ThreadnoteSemver {
  param([Parameter(Mandatory = $true)][string]$Version)
  if ($Version -notmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$') {
    return $null
  }
  return [PSCustomObject]@{
    Major = [int64]$Matches[1]
    Minor = [int64]$Matches[2]
    Patch = [int64]$Matches[3]
    Prerelease = [string]$Matches[4]
  }
}

function Compare-ThreadnoteSemver {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )
  $leftVersion = ConvertTo-ThreadnoteSemver $Left
  $rightVersion = ConvertTo-ThreadnoteSemver $Right
  if (-not $leftVersion -or -not $rightVersion) {
    throw 'Cannot compare an invalid Threadnote release version.'
  }
  foreach ($field in @('Major', 'Minor', 'Patch')) {
    if ($leftVersion.$field -ne $rightVersion.$field) {
      return $(if ($leftVersion.$field -gt $rightVersion.$field) { 1 } else { -1 })
    }
  }
  if (-not $leftVersion.Prerelease -and $rightVersion.Prerelease) { return 1 }
  if ($leftVersion.Prerelease -and -not $rightVersion.Prerelease) { return -1 }
  if (-not $leftVersion.Prerelease) { return 0 }
  $leftIdentifiers = $leftVersion.Prerelease -split '\.'
  $rightIdentifiers = $rightVersion.Prerelease -split '\.'
  $count = [Math]::Min($leftIdentifiers.Count, $rightIdentifiers.Count)
  for ($index = 0; $index -lt $count; $index += 1) {
    $leftId = $leftIdentifiers[$index]
    $rightId = $rightIdentifiers[$index]
    if ($leftId -ceq $rightId) { continue }
    $leftNumber = 0L
    $rightNumber = 0L
    $leftNumeric = [int64]::TryParse($leftId, [ref]$leftNumber)
    $rightNumeric = [int64]::TryParse($rightId, [ref]$rightNumber)
    if ($leftNumeric -and $rightNumeric) { return $(if ($leftNumber -gt $rightNumber) { 1 } else { -1 }) }
    if ($leftNumeric -ne $rightNumeric) { return $(if ($leftNumeric) { -1 } else { 1 }) }
    return $(if ([string]::CompareOrdinal($leftId, $rightId) -gt 0) { 1 } else { -1 })
  }
  if ($leftIdentifiers.Count -eq $rightIdentifiers.Count) { return 0 }
  return $(if ($leftIdentifiers.Count -gt $rightIdentifiers.Count) { 1 } else { -1 })
}

function Get-ThreadnoteSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $utilityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
  if (Test-Path -LiteralPath $utilityModule) {
    Import-Module $utilityModule -Force -ErrorAction Stop
    return (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }

  $stream = [IO.File]::OpenRead($Path)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $hasher.ComputeHash($stream)
      $hashText = [BitConverter]::ToString($hashBytes)
      return $hashText.Replace('-', '').ToLowerInvariant()
    } finally {
      $hasher.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Save-ThreadnoteDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $client = [System.Net.WebClient]::new()
  try {
    $client.Headers[[System.Net.HttpRequestHeader]::UserAgent] = 'threadnote-installer'
    $client.DownloadFile($Uri, $Path)
  } finally {
    $client.Dispose()
  }
}

function Resolve-ThreadnoteVersion {
  $requestedVersion = if ($env:THREADNOTE_VERSION) { $env:THREADNOTE_VERSION.TrimStart('v') } else { $null }
  $prerelease = if ($requestedVersion) {
    $null
  } else {
    switch ($channel) {
      'latest' { $false }
      'stable' { $false }
      'beta' { $true }
      default { throw 'THREADNOTE_CHANNEL must be latest, stable, or beta.' }
    }
  }
  $headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'threadnote-installer'
  }
  $release = $null
  $selectedVersion = $null
  # Windows PowerShell 5.1 emits a top-level REST JSON array as one pipeline
  # object. Store the response first so foreach enumerates the array itself.
  $releaseResponse = Invoke-RestMethod -Uri $releaseSource -Headers $headers
  foreach ($candidate in $releaseResponse) {
    if ($candidate.draft -or $candidate.immutable -ne $true) { continue }
    if (-not $requestedVersion -and [bool]$candidate.prerelease -ne $prerelease) { continue }
    $candidateVersion = ([string]$candidate.tag_name).TrimStart('v')
    if (-not (ConvertTo-ThreadnoteSemver $candidateVersion)) { continue }
    if ($requestedVersion -and $candidateVersion -cne $requestedVersion) { continue }
    if (-not $selectedVersion -or (Compare-ThreadnoteSemver $candidateVersion $selectedVersion) -gt 0) {
      $release = $candidate
      $selectedVersion = $candidateVersion
    }
  }
  if (-not $release) {
    if ($requestedVersion) {
      throw "Threadnote $requestedVersion is not a published immutable release."
    }
    throw "No immutable $channel Threadnote release is currently published."
  }
  return $selectedVersion
}

$architecture = switch ($env:PROCESSOR_ARCHITECTURE.ToUpperInvariant()) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { throw "Threadnote standalone releases do not support $env:PROCESSOR_ARCHITECTURE." }
}
$version = Resolve-ThreadnoteVersion
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
  throw 'Resolved release version is invalid.'
}
$artifact = "threadnote-windows-$architecture.tar.gz"
$tag = "v$version"
$downloadRoot = if ($env:THREADNOTE_RELEASE_DOWNLOAD_ROOT) {
  $env:THREADNOTE_RELEASE_DOWNLOAD_ROOT.TrimEnd('/')
} else {
  "https://github.com/$repository/releases/download/$tag"
}
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "threadnote-install-$([Guid]::NewGuid().ToString('N'))"
$archive = Join-Path $temporaryRoot $artifact
$checksumPath = "$archive.sha256"

New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
  Write-Host "Downloading Threadnote $version for windows-$architecture"
  Save-ThreadnoteDownload "$downloadRoot/$artifact" $archive
  Save-ThreadnoteDownload "$downloadRoot/$artifact.sha256" $checksumPath
  $checksumLine = (Get-Content -LiteralPath $checksumPath | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
  if ($checksumLine -notmatch '^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$') {
    throw "Release checksum document is invalid for $artifact."
  }
  if ($Matches[2] -and $Matches[2] -ne $artifact) {
    throw "Release checksum document names $($Matches[2]) instead of $artifact."
  }
  $expected = $Matches[1].ToLowerInvariant()
  $actual = Get-ThreadnoteSha256 $archive
  if ($actual -ne $expected) {
    throw "Checksum verification failed for $artifact (expected $expected, received $actual)."
  }

  $installRoot = if ($env:THREADNOTE_INSTALL_ROOT) {
    $env:THREADNOTE_INSTALL_ROOT
  } elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'Threadnote'
  } else {
    Join-Path $HOME '.local\share\threadnote'
  }
  $launcherRoot = if ($env:THREADNOTE_BIN_DIR) {
    $env:THREADNOTE_BIN_DIR
  } elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'Threadnote\bin'
  } else {
    Join-Path $HOME '.local\bin'
  }
  $versionsRoot = Join-Path $installRoot 'versions'
  $releaseRoot = Join-Path $versionsRoot $version
  New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
  Enter-ThreadnoteInstallationLock (Join-Path $installRoot '.installation.lock')
  $operationId = [Guid]::NewGuid().ToString('N')
  $stagedRoot = Join-Path $versionsRoot ".$version.$operationId.staging"
  $backupRoot = Join-Path $versionsRoot ".$version.$operationId.backup"
  Remove-Item -LiteralPath $stagedRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $stagedRoot | Out-Null
  & tar.exe -xzf $archive -C $stagedRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Could not extract $artifact."
  }
  $metadataPath = Join-Path $stagedRoot 'release.json'
  $executable = Join-Path $stagedRoot 'threadnote.exe'
  $nativeRuntime = Join-Path $stagedRoot 'runtime\node-llama-cpp.js'
  if (
    -not (Test-Path -LiteralPath $metadataPath) -or
    -not (Test-Path -LiteralPath $executable) -or
    -not (Test-Path -LiteralPath $nativeRuntime)
  ) {
    throw 'Release artifact validation failed: executable, metadata, or native runtime is missing.'
  }
  $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
  if ($metadata.version -ne $version -or $metadata.executable -ne 'threadnote.exe') {
    throw "Release metadata does not match Threadnote $version."
  }
  $officialRelease = (
    $repository -ceq 'Kashkovsky/threadnote' -and
    -not $env:THREADNOTE_RELEASE_SOURCE -and
    -not $env:THREADNOTE_RELEASE_DOWNLOAD_ROOT
  )
  if ($officialRelease) {
    $signedFiles = @((Get-Item -LiteralPath $executable)) + @(
      Get-ChildItem -LiteralPath (Join-Path $stagedRoot 'runtime') -Recurse -File |
        Where-Object { $_.Extension -in '.dll', '.node' }
    )
    foreach ($file in $signedFiles) {
      $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
      if ($signature.Status -ne 'Valid') {
        throw "Invalid Authenticode signature for $($file.FullName): $($signature.Status)"
      }
    }
  }

  if (Test-Path -LiteralPath $releaseRoot) {
    Move-Item -LiteralPath $releaseRoot -Destination $backupRoot
  }
  try {
    Move-Item -LiteralPath $stagedRoot -Destination $releaseRoot
  } catch {
    if (Test-Path -LiteralPath $backupRoot) {
      Move-Item -LiteralPath $backupRoot -Destination $releaseRoot
    }
    throw
  }
  Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
  Release-ThreadnoteInstallationLock

  Write-Host "Installed standalone Threadnote $version"
  $installArgs = @('install')
  if ($DryRun) { $installArgs += '--dry-run' }
  if ($Force) { $installArgs += '--force' }
  if ($NoStart) { $installArgs += '--no-start' }
  if ($WithHooks) { $installArgs += '--with-hooks' }
  if ($ThreadnoteArgs) { $installArgs += $ThreadnoteArgs }

  $previousInstallRoot = $env:THREADNOTE_INSTALL_ROOT
  try {
    $env:THREADNOTE_INSTALL_ROOT = $installRoot
    & (Join-Path $releaseRoot 'threadnote.exe') @installArgs
    if ($LASTEXITCODE -ne 0) {
      throw "threadnote install failed with exit code $LASTEXITCODE."
    }
  } finally {
    if ($null -eq $previousInstallRoot) {
      Remove-Item Env:THREADNOTE_INSTALL_ROOT -ErrorAction SilentlyContinue
    } else {
      $env:THREADNOTE_INSTALL_ROOT = $previousInstallRoot
    }
  }
  if (-not $env:THREADNOTE_BIN_DIR) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userPathEntries = @($userPath -split ';' | Where-Object { $_ })
    if (-not ($userPathEntries | Where-Object { $_.TrimEnd('\') -ieq $launcherRoot.TrimEnd('\') })) {
      $updatedUserPath = (@($launcherRoot) + $userPathEntries) -join ';'
      [Environment]::SetEnvironmentVariable('Path', $updatedUserPath, 'User')
      Write-Host "Added Threadnote command directory to the user PATH: $launcherRoot"
      Write-Host 'Open a new terminal before running threadnote.'
    }
  }
} finally {
  Release-ThreadnoteInstallationLock
  if ($stagedRoot) {
    Remove-Item -LiteralPath $stagedRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Threadnote is installed. Next:'
Write-Host '  threadnote doctor --dry-run'
Write-Host '  threadnote mcp-install codex --apply    # if you use Codex'
Write-Host '  threadnote mcp-install claude --apply   # if you use Claude'
Write-Host '  threadnote mcp-install cursor --apply   # if you use Cursor'
