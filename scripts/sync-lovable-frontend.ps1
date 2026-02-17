$ErrorActionPreference = 'Stop'

$base = 'https://ana-food-delivery.lovable.app'
$out = 'public/lovable'

if (Test-Path $out) {
  Remove-Item $out -Recurse -Force
}

New-Item -ItemType Directory -Path $out | Out-Null

$root = (Invoke-WebRequest -Uri $base -UseBasicParsing).Content
Set-Content -Path (Join-Path $out 'index.html') -Value $root -Encoding utf8

$matches = [regex]::Matches($root, '(?:src|href)=["'']([^"'']+)["'']')
$paths = New-Object System.Collections.Generic.HashSet[string]
$paths.Add('/') | Out-Null

foreach ($m in $matches) {
  $p = $m.Groups[1].Value.Trim()
  if ([string]::IsNullOrWhiteSpace($p)) { continue }
  if ($p.StartsWith('http://') -or $p.StartsWith('https://') -or $p.StartsWith('//')) { continue }
  if (-not $p.StartsWith('/')) { continue }
  if ($p.StartsWith('/~')) { continue }
  if ($p.Contains('?')) { $p = $p.Split('?')[0] }
  $paths.Add($p) | Out-Null
}

$downloaded = @()
foreach ($p in $paths) {
  if ($p -eq '/') {
    $downloaded += 'index.html'
    continue
  }

  $url = "$base$p"
  $target = Join-Path $out ($p.TrimStart('/') -replace '/', [IO.Path]::DirectorySeparatorChar)
  $dir = Split-Path $target -Parent
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
  $downloaded += $p.TrimStart('/')
}

$manifest = @{
  source = $base
  syncedAt = (Get-Date).ToString('o')
  files = $downloaded
} | ConvertTo-Json -Depth 5

Set-Content -Path (Join-Path $out 'sync-manifest.json') -Value $manifest -Encoding utf8
Write-Output "Downloaded: $($downloaded.Count) files"
