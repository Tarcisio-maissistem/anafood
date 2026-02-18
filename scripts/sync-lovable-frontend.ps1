$ErrorActionPreference = 'Stop'

$base = 'https://ana-food-delivery.lovable.app'
$fallbackBase = 'https://id-preview--986b9a1c-633d-4003-a1d6-4e93905a5dcf.lovable.app'
$out = 'public/lovable'

if (Test-Path $out) {
  Remove-Item $out -Recurse -Force
}

New-Item -ItemType Directory -Path $out | Out-Null

$root = (Invoke-WebRequest -Uri $base -UseBasicParsing).Content
Set-Content -Path (Join-Path $out 'index.html') -Value $root -Encoding utf8

$paths = New-Object System.Collections.Generic.HashSet[string]
$toProcess = New-Object System.Collections.Generic.Queue[string]
$processed = New-Object System.Collections.Generic.HashSet[string]
$paths.Add('/') | Out-Null
$toProcess.Enqueue('/') | Out-Null

function Add-PathIfValid([string]$candidate) {
  if ([string]::IsNullOrWhiteSpace($candidate)) { return }
  $p = $candidate.Trim()
  if ($p.StartsWith('http://') -or $p.StartsWith('https://') -or $p.StartsWith('//')) { return }
  if (-not $p.StartsWith('/')) { return }
  if ($p.StartsWith('/~')) { return }
  if ($p.Contains('?')) { $p = $p.Split('?')[0] }
  if ($paths.Add($p)) {
    $toProcess.Enqueue($p) | Out-Null
  }
}

function Add-RelativePath([string]$basePath, [string]$relativePath) {
  if ([string]::IsNullOrWhiteSpace($relativePath)) { return }
  try {
    $baseUri = [System.Uri]::new("$base$basePath")
    $absolute = [System.Uri]::new($baseUri, $relativePath)
    Add-PathIfValid $absolute.AbsolutePath
  } catch {}
}

$downloaded = @()
while ($toProcess.Count -gt 0) {
  $p = $toProcess.Dequeue()
  if ($processed.Contains($p)) { continue }
  $processed.Add($p) | Out-Null

  $contentText = $null
  if ($p -eq '/') {
    $downloaded += 'index.html'
    $contentText = $root
  } else {
    $url = "$base$p"
    $target = Join-Path $out ($p.TrimStart('/') -replace '/', [IO.Path]::DirectorySeparatorChar)
    $dir = Split-Path $target -Parent
    if (-not (Test-Path $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $response = $null
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing
    } catch {
      if ($fallbackBase) {
        $fallbackUrl = "$fallbackBase$p"
        $response = Invoke-WebRequest -Uri $fallbackUrl -UseBasicParsing
      } else {
        throw
      }
    }
    $bytes = $response.Content
    if ($bytes -is [string]) {
      Set-Content -Path $target -Value $bytes -Encoding utf8
      $contentText = $bytes
    } else {
      [System.IO.File]::WriteAllBytes($target, $bytes)
    }
    $downloaded += $p.TrimStart('/')
  }

  if ($null -ne $contentText) {
    $refs = [regex]::Matches($contentText, '(?:src|href)=["'']([^"'']+)["'']')
    foreach ($m in $refs) {
      Add-PathIfValid $m.Groups[1].Value
    }

    $assetRefs = [regex]::Matches($contentText, '/assets/[A-Za-z0-9_\-./]+')
    foreach ($m in $assetRefs) {
      Add-PathIfValid $m.Value
    }

    $assetRefsNoSlash = [regex]::Matches($contentText, '(?<![A-Za-z0-9_./-])assets/[A-Za-z0-9_\-./]+')
    foreach ($m in $assetRefsNoSlash) {
      Add-PathIfValid ('/' + $m.Value.TrimStart('/'))
    }

    $relativeRefs = [regex]::Matches($contentText, '(?:import\(|from\s+|new URL\()["''](\./[^"'']+)["'']')
    foreach ($m in $relativeRefs) {
      Add-RelativePath $p $m.Groups[1].Value
    }
  }
}

$manifest = @{
  source = $base
  syncedAt = (Get-Date).ToString('o')
  files = $downloaded
} | ConvertTo-Json -Depth 5

Set-Content -Path (Join-Path $out 'sync-manifest.json') -Value $manifest -Encoding utf8
Write-Output "Downloaded: $($downloaded.Count) files"
