# Publishes a GitHub release of orange_skin.html at the current commit of main. The release tag is the version:
# release-YYYYMMDDTHHMMSS+HHMM or release-YYYYMMDDTHHMMSS-HHMM, the local time and UTC offset when the release is
# made. Releases accumulate; the script deletes none. The website does not depend on a release:
# .github/workflows/pages.yml deploys every push to main.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ReleaseBranch = 'main'
$RemoteName = 'origin'
$ReleaseFile = 'orange_skin.html'
$PublicationDirectory = '.publication'
$TagPrefix = 'release-'

function Invoke-Git {
    param([string[]] $Arguments)

    $output = & git -C $PSScriptRoot @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $exitCode."
    }
    return $output
}

$branch = Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')
if ($branch -ne $ReleaseBranch) {
    throw "Releases are made from $ReleaseBranch; the current branch is $branch."
}

$uncommitted = @(Invoke-Git @('status', '--porcelain'))
if ($uncommitted.Count -ne 0) {
    throw "The working tree has uncommitted files. Commit and push them first:$([Environment]::NewLine)$($uncommitted -join [Environment]::NewLine)"
}

Invoke-Git @('fetch', $RemoteName, $ReleaseBranch) | Out-Null
$localCommit = Invoke-Git @('rev-parse', 'HEAD')
$remoteCommit = Invoke-Git @('rev-parse', "$RemoteName/$ReleaseBranch")
if ($localCommit -ne $remoteCommit) {
    throw "Local $ReleaseBranch ($localCommit) differs from $RemoteName/$ReleaseBranch ($remoteCommit). Push or pull first."
}

# The check .github/workflows/pages.yml runs before it deploys.
& node (Join-Path $PSScriptRoot 'scripts\csp.js')
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "node scripts\csp.js failed with exit code $exitCode."
}

$invariant = [Globalization.CultureInfo]::InvariantCulture
$tag = $TagPrefix + [DateTimeOffset]::Now.ToString("yyyyMMdd'T'HHmmsszzz", $invariant).Replace(':', '')
$commitTime = [DateTimeOffset]::Parse((Invoke-Git @('show', '-s', '--format=%cI', $localCommit)), $invariant)
$commitTimeUtc = $commitTime.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $invariant)

# The release attaches a copy of the page whose build line names the release; the committed page stays unstamped.
# The path is relative to the repository root, where git gh runs the GitHub CLI.
$stampedPage = "$PublicationDirectory/$ReleaseFile"
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot $PublicationDirectory) | Out-Null
& node (Join-Path $PSScriptRoot 'scripts\stamp.js') "--out=$(Join-Path $PSScriptRoot $stampedPage)" "--release=$tag"
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "node scripts\stamp.js failed with exit code $exitCode."
}

Write-Output "Tagging $localCommit as $tag..."
Invoke-Git @('tag', $tag, $localCommit) | Out-Null
Invoke-Git @('push', $RemoteName, "refs/tags/$tag") | Out-Null

# git gh is a git alias that runs the GitHub CLI with the GitHub account of this repository.
Invoke-Git @('gh', 'release', 'create', $tag, $stampedPage, '--verify-tag', '--title', "Orange Skin $tag",
    '--notes', "$ReleaseFile at commit $localCommit, committed $commitTimeUtc.") | Out-Null

$release = (Invoke-Git @('gh', 'release', 'view', $tag, '--json', 'url,assets')) -join "`n" | ConvertFrom-Json
$localBytes = (Get-Item -LiteralPath (Join-Path $PSScriptRoot $stampedPage)).Length
$assets = @($release.assets)
if ($assets.Count -ne 1 -or $assets[0].name -ne $ReleaseFile -or $assets[0].size -ne $localBytes) {
    throw "Release $tag ($($release.url)) does not hold exactly $ReleaseFile of $localBytes bytes; it holds: $(@($assets | ForEach-Object { "$($_.name) ($($_.size) bytes)" }) -join ', ')"
}
Write-Output "Released ${tag}: $($release.url)"
