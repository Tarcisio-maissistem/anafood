$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
Set-Location "C:\Users\Maissistem\Desktop\SAIPOS API"

Write-Output "Iniciando servidor SAIPOS API na porta 3000..."
Write-Output "Pressione Ctrl+C para parar o servidor"
Write-Output ""

& 'C:\Program Files\nodejs\node.exe' server.js
