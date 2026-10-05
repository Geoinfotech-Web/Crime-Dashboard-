param(
  [int]$Port = 8085,
  [string]$Root = $PSScriptRoot,
  [string]$Host = '0.0.0.0'
)

$ErrorActionPreference = 'Stop'

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  $python = Get-Command py -ErrorAction SilentlyContinue
}

if (-not $python) {
  throw 'Python is required to run dev_server.py, but no Python executable was found on PATH.'
}

& $python.Source (Join-Path $PSScriptRoot 'dev_server.py') --port $Port --root $Root --host $Host
