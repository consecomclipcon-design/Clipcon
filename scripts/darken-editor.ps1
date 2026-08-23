$ErrorActionPreference = "Stop"
$path = "apps\web\src\styles.css"
$c = Get-Content $path -Raw

$map = @{
    "#eef2f4" = "#14161a"; "#f2f5f7" = "#17191d"; "#f0f2f5" = "#15171c";
    "#f4f5f7" = "#17191d"; "#f5f7f8" = "#181a1f"; "#f4f7fb" = "#171a20";
    "#e0e5e8" = "#20242b"; "#e1e5e8" = "#20242b"; "#e2e6e9" = "#22262d";
    "#e7edf2" = "#232830"; "#f1f7ef" = "#18201a"; "#e1f0df" = "#1c261c";
    "#c3d9c1" = "#2c3a2c"; "#c9d3c8" = "#2a302a"; "#dff7fc" = "#12222a";
    "#ffffff99" = "rgba(255,255,255,.08)";
    "#16191d" = "#e6e9e2";
    "#65707a" = "#8b93a7"; "#6b737c" = "#8b93a7"; "#6f786e" = "#8b93a7";
    "#727c72" = "#8b93a7"; "#737a82" = "#8b93a7"; "#768075" = "#8b93a7";
    "#737c73" = "#8b93a7"; "#7c857c" = "#8b93a7"; "#7f897f" = "#8b93a7";
    "#909990" = "#969a91"; "#9298a2" = "#969a91"; "#858b94" = "#969a91";
    "#8d929b" = "#969a91"; "#9aa3ad" = "#969a91"; "#9ba69a" = "#969a91";
    "#9aa398" = "#969a91"; "#aab4a7" = "#aab0a6";
}

$ruleRe = [regex]'\.(?:editor|capcut|timeline|media-panel|properties-panel|playhead|ruler|track)[a-z-]*(?:[^{}]*?)?\{[^}]*\}'
$out = $ruleRe.Replace($c, {
    param($m)
    $s = $m.Value
    foreach ($k in $map.Keys) { $s = $s -replace [regex]::Escape($k), $map[$k] }
    # fundos brancos explicitos viram superficie escura (texto branco permanece)
    $s = $s -replace 'background:#fff(?![0-9a-fA-F])', 'background:#1a1d19'
    $s = $s -replace 'Arial,sans-serif', "'DM Sans',sans-serif"
    $s
})

Set-Content $path -Value $out -Encoding utf8 -NoNewline
Write-Output "editor convertido para dark"
