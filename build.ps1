# ============================================================
# QYRead dual-arch build script (Windows / PowerShell 5+)
# Usage:
#   .\build.ps1                 auto bump patch version, then build both fpks
#   .\build.ps1 -Version 0.2.0  set a specific version, then build
#   .\build.ps1 -NoBump         build with the version currently in manifest
# Output: qyread-<version>-x86.fpk / qyread-<version>-arm.fpk
#
# Notes:
#   - Version sources are synced on bump: manifest, app/server/package.json,
#     asset cache-busting "?v=" tags in app/ui/index.html
#   - x86 package contains x64 native modules only (sqlite3)
#   - arm package replaces sqlite3 binary with build-assets arm64 prebuilt
#     and switches manifest platform to arm
#   - Builds run in a temp staging tree; build-assets and this script
#     itself are never packed into the fpk
# ============================================================
param(
    [string]$Version = "",
    [switch]$NoBump
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 1) Locate fnpack
$fnpack = Get-Command fnpack -ErrorAction SilentlyContinue
if ($fnpack) {
    $fnpackExe = "fnpack"
} elseif (Test-Path "d:\CODE\fnpack\fnpack.exe") {
    $fnpackExe = "d:\CODE\fnpack\fnpack.exe"
} else {
    Write-Host "fnpack not found. Install it or add to PATH: https://developer.fnnas.com/docs/cli/fnpack/" -ForegroundColor Red
    exit 1
}

# 2) Resolve versions
$manifestPath = "$root\manifest"
$pkgPath = "$root\app\server\package.json"
$htmlPath = "$root\app\ui\index.html"

$manifest = [System.IO.File]::ReadAllText($manifestPath, $Utf8NoBom)
if ($manifest -notmatch '(?m)^version\s*=\s*([0-9]+\.[0-9]+\.[0-9]+)') { throw "Cannot parse version from manifest" }
$curVersion = $Matches[1]

if ($Version) {
    if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "Invalid -Version format (expected e.g. 0.1.2): $Version" }
    $newVersion = $Version
    $doBump = $true
} elseif (-not $NoBump) {
    $p = $curVersion.Split('.')
    $p[2] = ([int]$p[2] + 1).ToString()
    $newVersion = ($p -join '.')
    $doBump = $true
} else {
    $newVersion = $curVersion
    $doBump = $false
}

# 3) Bump version across project files
if ($doBump) {
    Write-Host "[bump] $curVersion -> $newVersion" -ForegroundColor Yellow

    # 3.1 manifest (keep UTF-8 no BOM)
    $manifest = [System.IO.File]::ReadAllText($manifestPath, $Utf8NoBom)
    $manifest = [System.Text.RegularExpressions.Regex]::Replace(
        $manifest, '(?m)^version\s*=\s*[0-9]+\.[0-9]+\.[0-9]+',
        "version               = $newVersion")
    [System.IO.File]::WriteAllText($manifestPath, $manifest, $Utf8NoBom)

    # 3.2 server package.json
    $pkg = [System.IO.File]::ReadAllText($pkgPath, $Utf8NoBom)
    $pkg = [System.Text.RegularExpressions.Regex]::Replace(
        $pkg, '"version"\s*:\s*"[0-9]+\.[0-9]+\.[0-9]+"',
        "`"version`": `"$newVersion`"")
    [System.IO.File]::WriteAllText($pkgPath, $pkg, $Utf8NoBom)

    # 3.3 ui/index.html asset cache-busting tags (?v=x.y.z)
    $html = [System.IO.File]::ReadAllText($htmlPath, $Utf8NoBom)
    $html2 = [System.Text.RegularExpressions.Regex]::Replace(
        $html, '\?v=[0-9]+\.[0-9]+\.[0-9]+', "?v=$newVersion")
    if ($html2 -ne $html) {
        [System.IO.File]::WriteAllText($htmlPath, $html2, $Utf8NoBom)
        Write-Host "[bump] index.html asset tags synced" -ForegroundColor DarkGray
    }

    # 3.4 changelog reminder (bump does NOT invent release notes)
    if ($manifest -notmatch [regex]::Escape("v$newVersion")) {
        Write-Host ""
        Write-Host "[warn] manifest changelog has no 'v$newVersion' entry yet." -ForegroundColor Yellow
        Write-Host "       Add the release notes to the changelog line BEFORE publishing." -ForegroundColor Yellow
        Write-Host ""
    }
}

$version = $newVersion
$armSqlite = "$root\build-assets\node_sqlite3-linux-arm64.node"
if (-not (Test-Path $armSqlite)) { throw "Missing arm64 sqlite3 binary: $armSqlite" }

$staging = Join-Path $env:TEMP "qyread-fnpack"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }

function Build-Tree($arch) {
    Write-Host "[build] preparing $arch tree..." -ForegroundColor Cyan
    $tree = "$staging\$arch"

    $rcArgs = @($root, $tree, "/E", "/XD", "$root\build-assets", "/XF", "*.fpk", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    & robocopy @rcArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit=$LASTEXITCODE)" }
    # staging artifacts must never be packed
    Remove-Item "$tree\build.ps1" -Force -ErrorAction SilentlyContinue

    if ($arch -eq "arm") {
        Copy-Item $armSqlite "$tree\app\server\node_modules\sqlite3\build\Release\node_sqlite3.node" -Force
        $m = [System.IO.File]::ReadAllText("$tree\manifest", $Utf8NoBom)
        $m = $m -replace '(?m)^platform\s*=\s*x86', 'platform              = arm'
        [System.IO.File]::WriteAllText("$tree\manifest", $m, $Utf8NoBom)
    }

    Write-Host "[build] fnpack $arch ..." -ForegroundColor Cyan
    Push-Location $tree
    try {
        & $fnpackExe build --directory $tree
        if ($LASTEXITCODE -ne 0) { throw "fnpack build $arch failed" }
    } finally {
        Pop-Location
    }

    $out = "$root\qyread-$version-$arch.fpk"
    Move-Item "$tree\qyread.fpk" $out -Force
    Write-Host "[done] $out" -ForegroundColor Green
}

Build-Tree "x86"
Build-Tree "arm"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "All done: qyread-$version-x86.fpk / qyread-$version-arm.fpk" -ForegroundColor Green
