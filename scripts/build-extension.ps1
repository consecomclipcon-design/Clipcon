# Gera os ZIPs da extensao:
#   publico  -> apps/web/public/downloads/clipcon-extension-v<ver>.zip   (sem credenciais, vai pro git/deploy)
#   privado  -> private-builds/clipcon-extension-v<ver>-PRIVATE.zip      (com preauth.json; NUNCA vai pro git)
# Uso: powershell -File scripts\build-extension.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root "apps\extension"
$out = Join-Path $root "apps\web\public\downloads"
$privOut = Join-Path $root "private-builds"

$manifest = Get-Content (Join-Path $ext "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version

New-Item -ItemType Directory -Force $out | Out-Null
New-Item -ItemType Directory -Force $privOut | Out-Null

function Build-Zip($srcDir, $zipPath) {
    if (Test-Path $zipPath) { Remove-Item $zipPath }
    Compress-Archive -Path (Join-Path $srcDir "*") -DestinationPath $zipPath
}

# ---------- PUBLICO (sem preauth) ----------
$staging = Join-Path $env:TEMP ("clipcon-ext-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force $staging | Out-Null
Get-ChildItem -Path $ext -Exclude "preauth.json", "preauth.json.example" |
    Copy-Item -Destination $staging -Recurse -Force
Build-Zip $staging (Join-Path $out "clipcon-extension-v$version.zip")
Remove-Item $staging -Recurse -Force

@{ version = $version; builtAt = (Get-Date).ToUniversalTime().ToString("o"); file = "clipcon-extension-v$version.zip" } |
    ConvertTo-Json | Set-Content (Join-Path $out "extension-meta.json") -Encoding utf8

Write-Output "PUBLICO : clipcon-extension-v$version.zip"

# ---------- PRIVADO (com preauth.json preenchido) ----------
$preauthPath = Join-Path $ext "preauth.json"
if (Test-Path $preauthPath) {
    try { $pa = Get-Content $preauthPath -Raw | ConvertFrom-Json } catch { $pa = $null }
    if ($pa -and $pa.email -and $pa.password) {
        $pstage = Join-Path $env:TEMP ("clipcon-extp-" + [guid]::NewGuid().ToString("N").Substring(0,8))
        New-Item -ItemType Directory -Force $pstage | Out-Null
        Get-ChildItem -Path $ext -Exclude "preauth.json.example" |
            Copy-Item -Destination $pstage -Recurse -Force
        $privZip = Join-Path $privOut "clipcon-extension-v$version-PRIVATE.zip"
        Build-Zip $pstage $privZip
        Remove-Item $pstage -Recurse -Force
        Write-Output "PRIVADO : clipcon-extension-v$version-PRIVATE.zip (auto-login incluido)"
    } else {
        Write-Output "PRIVADO : pulado (preauth.json sem email/password preenchidos)"
    }
} else {
    Write-Output "PRIVADO : pulado (preauth.json nao existe)"
}
