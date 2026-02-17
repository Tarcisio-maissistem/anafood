$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
Set-Location "C:\Users\Maissistem\Desktop\SAIPOS API"
Write-Output "Iniciando servidor..."
& 'C:\Program Files\nodejs\node.exe' server.js
