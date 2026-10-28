# pack.ps1 - build a distributable zip (no downloads needed)
$ErrorActionPreference = 'Continue'
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$stamp = Get-Date -Format 'yyyyMMdd'
$dist = Join-Path $proj 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

$tmp = Join-Path $env:TEMP ('hm-pack-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null

foreach ($pat in @('*.py', '*.md', '*.ps1', '*.bat', '*.toml')) {
    Get-ChildItem -Path (Join-Path $proj $pat) -File -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item $_.FullName $tmp }
}

$zip = Join-Path $dist ("human-memory-$stamp.zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip -Force
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Output "PACKED: $zip ($size KB)"
exit 0
