<# Integration test: genuine junctions point only into a disposable fixture. #>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ScratchRoot)
$ErrorActionPreference = 'Stop'
$checker = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../skills/pi-worker/scripts/check-worktree-removal.ps1'))
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not [IO.Path]::IsPathFullyQualified($ScratchRoot)) { throw 'ScratchRoot must be absolute.' }
$base = [IO.Path]::GetFullPath($ScratchRoot).TrimEnd('\', '/')
New-Item -ItemType Directory -Path $base -Force | Out-Null
$fixture = Join-Path $base ('worktree-guard-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$repo = Join-Path $fixture 'repo'
$wt = Join-Path $fixture 'candidate'
$payload = Join-Path $fixture 'payload'
$sentinel = Join-Path $payload 'keep.txt'
$links = [Collections.Generic.List[string]]::new()
$results = [Collections.Generic.List[object]]::new()

function Check([string]$Name, [string]$Target, [bool]$Pass) {
    $output = @(& pwsh -NoProfile -NonInteractive -File $checker -Repository $repo -Worktree $Target 2>&1)
    $code = $LASTEXITCODE
    if (($code -eq 0) -ne $Pass) { throw "$Name unexpected exit ${code}: $output" }
    if ((Get-Content -LiteralPath $sentinel -Raw) -ne 'keep') { throw 'Sentinel changed.' }
    $results.Add([pscustomobject]@{ Case = $Name; ExitCode = $code; Passed = $true })
}
function Junction([string]$Path, [string]$Target) {
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
    $links.Add($Path)
}

try {
    & git clone --quiet --shared --no-hardlinks --no-checkout $source $repo
    if ($LASTEXITCODE) { throw 'Fixture clone failed.' }
    & git -C $repo worktree add --quiet --detach --no-checkout $wt HEAD
    if ($LASTEXITCODE) { throw 'Fixture worktree failed.' }
    New-Item -ItemType Directory -Path $payload | Out-Null
    [IO.File]::WriteAllText($sentinel, 'keep')
    Check 'clean registered worktree' $wt $true
    Check 'main checkout' $repo $false
    Check 'unregistered directory' $payload $false
    Check 'missing directory / read error' (Join-Path $fixture 'missing') $false
    Check 'relative path' 'candidate' $false
    Check 'drive-relative path' 'D:candidate' $false
    Check 'filesystem root' ([IO.Path]::GetPathRoot($fixture)) $false

    $unreadable = Join-Path $wt 'unreadable'
    New-Item -ItemType Directory -Path $unreadable | Out-Null
    $originalAcl = Get-Acl -LiteralPath $unreadable
    $deniedAcl = Get-Acl -LiteralPath $unreadable
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $deny = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity, [Security.AccessControl.FileSystemRights]::ListDirectory,
        [Security.AccessControl.AccessControlType]::Deny)
    $deniedAcl.AddAccessRule($deny)
    try {
        Set-Acl -LiteralPath $unreadable -AclObject $deniedAcl
        Check 'descendant enumeration denied' $wt $false
    } finally {
        Set-Acl -LiteralPath $unreadable -AclObject $originalAcl
    }

    $rootLink = Join-Path $fixture 'root-link'
    Junction $rootLink $wt
    Check 'target junction' $rootLink $false
    $parentLink = Join-Path $fixture 'parent-link'
    Junction $parentLink $fixture
    Check 'ancestor junction' (Join-Path $parentLink 'candidate') $false
    $hidden = Join-Path $wt '.ignored/deep'
    New-Item -ItemType Directory -Path $hidden -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $wt '.gitignore'), '.ignored/')
    (Get-Item -LiteralPath (Join-Path $wt '.ignored') -Force).Attributes = 'Directory, Hidden'
    $deepLink = Join-Path $hidden 'runtime'
    Junction $deepLink $payload
    Check 'hidden ignored descendant junction' $wt $false
    # Remove only this fixture's link object, never the linked directory.
    [IO.Directory]::Delete($deepLink, $false)
    $links.Remove($deepLink) | Out-Null
    Check 'clean after link object removed' $wt $true
    $results | ConvertTo-Json
} finally {
    foreach ($link in $links) {
        $item = Get-Item -LiteralPath $link -Force -ErrorAction Stop
        if (-not $item.FullName.StartsWith($fixture + '\', [StringComparison]::OrdinalIgnoreCase) -or
            -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe fixture link cleanup.' }
        [IO.Directory]::Delete($link, $false)
    }
    # Explicit containment and a no-follow scan before recursive fixture cleanup.
    if (-not [IO.Path]::GetFullPath($fixture).StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Fixture escaped scratch root.'
    }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($fixture)
    while ($pending.Count) {
        $directory = $pending.Pop()
        if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Linked fixture; preserve for inspection.'
        }
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked fixture; preserve for inspection.' }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
