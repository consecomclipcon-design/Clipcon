# Gera o ZIP distribuível da extensão + metadados de versão para o web app.
# Uso: powershell -File scripts\build-extension.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root "apps\extension"
$out = Join-Path $root "apps\web\public\downloads"

$manifest = Get-Content (Join-Path $ext "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version

New-Item -ItemType Directory -Force $out | Out-Null

$zip = Join-Path $out "clipcon-extension-v$version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $ext "*") -DestinationPath $zip

@{ version = $version; builtAt = (Get-Date).ToUniversalTime().ToString("o"); file = "clipcon-extension-v$version.zip" } |
  ConvertTo-Json | Set-Content (Join-Path $out "extension-meta.json") -Encoding utf8

Write-Output "Extensão v$version empacotada:"
Get-ChildItem $out | Select-Object Name, Length
