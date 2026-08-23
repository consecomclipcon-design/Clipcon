# Gera o ZIP distribuivel da extensao + metadados de versao para o web app.
# preauth.js (credenciais locais) NUNCA entra no pacote.
# Uso: powershell -File scripts\build-extension.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root "apps\extension"
$out = Join-Path $root "apps\web\public\downloads"

$manifest = Get-Content (Join-Path $ext "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version

New-Item -ItemType Directory -Force $out | Out-Null

# staging sem arquivos sensíveis
$staging = Join-Path $env:TEMP ("clipcon-ext-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force $staging | Out-Null
Get-ChildItem -Path $ext -Exclude "preauth.json", "preauth.json.example" | Copy-Item -Destination $staging -Recurse -Force

$zip = Join-Path $out "clipcon-extension-v$version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip
Remove-Item $staging -Recurse -Force

@{ version = $version; builtAt = (Get-Date).ToUniversalTime().ToString("o"); file = "clipcon-extension-v$version.zip" } |
  ConvertTo-Json | Set-Content (Join-Path $out "extension-meta.json") -Encoding utf8

Write-Output "Extensao v$version empacotada (preauth excluido):"
Get-ChildItem $out | Select-Object Name, Length
