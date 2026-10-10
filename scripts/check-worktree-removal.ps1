<# Read-only preflight. Stop writers before checking; this never deletes a path. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Worktree
)

$ErrorActionPreference = 'Stop'

function Get-AbsoluteDirectory([string]$Value) {
    if (-not [System.IO.Path]::IsPathFullyQualified($Value)) {
        throw "An absolute directory path is required: $Value"
    }
    $absolute = [System.IO.Path]::GetFullPath($Value)
    if ($absolute -eq [System.IO.Path]::GetPathRoot($absolute)) {
        throw "A filesystem root is not a worktree: $absolute"
    }
    $item = Get-Item -LiteralPath $absolute -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "Not a directory: $absolute" }
    return $absolute.TrimEnd([char[]]@('\', '/'))
}

function Assert-UnlinkedParents([string]$Directory) {
    $current = [System.IO.Path]::GetFullPath($Directory)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Reparse point on the path; keep the worktree: $current"
        }
        $current = [System.IO.Path]::GetDirectoryName($current)
    }
}

try {
    $repositoryPath = Get-AbsoluteDirectory $Repository
    $worktreePath = Get-AbsoluteDirectory $Worktree
    Assert-UnlinkedParents $repositoryPath
    Assert-UnlinkedParents $worktreePath

    $listing = @(& git -c core.quotepath=false -C $repositoryPath worktree list --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read registered worktrees.' }
    $registered = @($listing | Where-Object { $_.StartsWith('worktree ') } |
        ForEach-Object { [System.IO.Path]::GetFullPath($_.Substring(9)).TrimEnd([char[]]@('\', '/')) })
    if ($registered.Count -eq 0) { throw 'No registered worktrees found.' }
    if ($worktreePath -eq $registered[0]) { throw 'The main checkout cannot be removed.' }
    if ($worktreePath -notin $registered) { throw 'The exact target is not a registered worktree.' }

    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($worktreePath)
    $directories = 0
    $entries = 0
    while ($pending.Count) {
        $directory = $pending.Pop()
        $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Directory changed into a reparse point; keep the worktree: $directory"
        }
        $directories++
        foreach ($child in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
            $entries++
            if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Reparse point inside the worktree; keep it: $($child.FullName)"
            }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }
    [pscustomobject]@{
        Worktree = $worktreePath
        Directories = $directories
        Entries = $entries
        ReparsePoints = 0
        ReadOnly = $true
    } | ConvertTo-Json
    exit 0
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
