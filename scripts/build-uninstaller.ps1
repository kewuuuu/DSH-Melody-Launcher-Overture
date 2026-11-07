# Build the standalone KEWU uninstaller EXE with the .NET Framework 4.x csc compiler.
# Offline only: no npm, no network, no third-party libraries.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-uninstaller.ps1
#
# Falls back to the 32-bit csc.exe when the 64-bit one is missing, prints the raw
# compiler output on failure and exits non-zero.

[CmdletBinding()]
param(
    [string]$OutputPath,
    [string]$IconPath,
    [switch]$Use32Bit
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
    Write-Host ("[build-uninstaller] " + $message) -ForegroundColor Red
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($repoRoot)) { Fail "cannot resolve the repository root from $PSScriptRoot" }

$sourceDir = Join-Path $repoRoot "tools\uninstaller\src"
if (-not (Test-Path -LiteralPath $sourceDir)) { Fail "source directory not found: $sourceDir" }

$sources = @(Get-ChildItem -LiteralPath $sourceDir -Filter *.cs -File | Sort-Object Name | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) { Fail "no C# sources in $sourceDir" }

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repoRoot "tools\uninstaller\bin\KEWU-Uninstaller.exe"
}
$outputFull = [System.IO.Path]::GetFullPath($OutputPath)
$outputDir = Split-Path -Parent $outputFull
if (-not (Test-Path -LiteralPath $outputDir)) { New-Item -ItemType Directory -Path $outputDir -Force | Out-Null }

if ([string]::IsNullOrWhiteSpace($IconPath)) { $IconPath = Join-Path $repoRoot "build\icon.ico" }

$windirPath = $env:WINDIR
if ([string]::IsNullOrWhiteSpace($windirPath)) { $windirPath = $env:SystemRoot }

$candidates = @()
if (-not $Use32Bit) { $candidates += (Join-Path $windirPath "Microsoft.NET\Framework64\v4.0.30319\csc.exe") }
$candidates += (Join-Path $windirPath "Microsoft.NET\Framework\v4.0.30319\csc.exe")

$csc = $null
foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { $csc = $candidate; break }
}
if ($null -eq $csc) {
    Write-Host "[build-uninstaller] no C# compiler found. Tried:" -ForegroundColor Red
    foreach ($candidate in $candidates) { Write-Host ("  - " + $candidate) -ForegroundColor Red }
    Write-Host "[build-uninstaller] the .NET Framework 4.x (or a newer .NET SDK) must be installed." -ForegroundColor Red
    exit 1
}

$cscArgs = @(
    "/nologo",
    "/target:winexe",
    "/platform:anycpu",
    "/optimize+",
    "/utf8output",
    "/codepage:65001",
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    ("/out:" + $outputFull)
)
if (Test-Path -LiteralPath $IconPath) {
    $cscArgs += ("/win32icon:" + $IconPath)
}
else {
    Write-Host ("[build-uninstaller] note: icon not found, building without one: " + $IconPath)
}
foreach ($source in $sources) { $cscArgs += $source }

Write-Host ("[build-uninstaller] compiler: " + $csc)
Write-Host ("[build-uninstaller] sources:  " + ($sources -join ", "))
Write-Host ("[build-uninstaller] output:   " + $outputFull)

$compilerOutput = & $csc $cscArgs 2>&1
$exitCode = $LASTEXITCODE
foreach ($line in $compilerOutput) { Write-Host ([string]$line) }

if ($exitCode -ne 0) {
    Write-Host ("[build-uninstaller] csc failed with exit code " + $exitCode) -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $outputFull)) { Fail "csc reported success but the output file is missing: $outputFull" }

$size = (Get-Item -LiteralPath $outputFull).Length
if ($size -le 0) { Fail "the produced executable is empty: $outputFull" }

Write-Host ("[build-uninstaller] OK " + $outputFull + " (" + $size + " bytes)")
exit 0
