$ErrorActionPreference = "Stop"
$files = Get-ChildItem apps\web\src -Filter *.tsx
$css = Get-Content apps\web\src\styles.css -Raw

$missing = @{}
foreach ($f in $files) {
    $src = Get-Content $f.FullName -Raw
    $ms = [regex]::Matches($src, 'className=["`{]([^"`}]*)')
    foreach ($m in $ms) {
        $raw = $m.Groups[1].Value
        # extrai tokens estaticos (ignora expressoes ${...})
        $tokens = [regex]::Matches($raw, '[a-z][a-z0-9-]{2,}') | ForEach-Object { $_.Value }
        foreach ($t in $tokens) {
            if ($t -match '^(px|rem|auto|none|flex|true|false)$') { continue }
            if ($null -ne $missing[$t]) { $missing[$t] += ",$($f.Name)"; continue }
            if ($css -notmatch ('\.' + [regex]::Escape($t) + '[^a-z0-9-]')) {
                if ($css -notmatch ('\.' + [regex]::Escape($t) + '$')) {
                    $missing[$t] = $f.Name
                }
            }
        }
    }
}
Write-Output "Classes SEM regra no styles.css:"
$missing.GetEnumerator() | Sort-Object Name | ForEach-Object { "  .$($_.Key)   [$($_.Value)]" }
