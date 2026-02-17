$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    Write-Output "Node found at: $($nodeCmd.Source)"
    & node --version
} else {
    Write-Output "Node not found"
}

$dirs = @(
    "C:\Program Files\nodejs",
    "C:\Program Files (x86)\nodejs",
    "$env:APPDATA\nvm\current",
    "$env:LOCALAPPDATA\Programs\nodejs"
)

foreach ($dir in $dirs) {
    if (Test-Path "$dir\node.exe") {
        Write-Output "Found node at: $dir"
    }
}
