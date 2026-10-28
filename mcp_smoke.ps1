# mcp_smoke.ps1 - wrapper around mcp_test.py
# The real protocol test lives in mcp_test.py (Python subprocess, reliable encoding).
$ErrorActionPreference = 'Continue'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $proj

python mcp_test.py
exit $LASTEXITCODE
