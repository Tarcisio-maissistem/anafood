# Check if winget is available
$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
    Write-Output "Using winget to install Node.js LTS..."
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    Write-Output "Done with winget"
} else {
    Write-Output "winget not found, trying direct MSI install..."
    $url = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
    $output = "$env:TEMP\node-installer.msi"
    Write-Output "Downloading $url to $output"
    Invoke-WebRequest -Uri $url -OutFile $output -UseBasicParsing
    Write-Output "Running installer..."
    $proc = Start-Process msiexec.exe -ArgumentList "/i `"$output`" /quiet /norestart ADDLOCAL=ALL" -Wait -PassThru
    Write-Output "Installer exit code: $($proc.ExitCode)"
}

# Check if node is now available
$refreshedPath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
$env:PATH = $refreshedPath
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    Write-Output "Node.js installed successfully at: $($nodeCmd.Source)"
    & node --version
} else {
    Write-Output "Node.js installation may require a new terminal session to take effect"
    # Try common paths
    if (Test-Path "C:\Program Files\nodejs\node.exe") {
        Write-Output "Node found at C:\Program Files\nodejs\node.exe"
        & "C:\Program Files\nodejs\node.exe" --version
    }
}
