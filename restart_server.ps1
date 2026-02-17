$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

# Para processo anterior na porta 3000
$existing = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
if ($existing) {
    $procId = $existing.OwningProcess | Select-Object -First 1
    Write-Output "Parando processo anterior na porta 3000 (PID $procId)..."
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

Set-Location "C:\Users\Maissistem\Desktop\SAIPOS API"
Remove-Item -Path "server.log","server_err.log" -ErrorAction SilentlyContinue

Write-Output "Iniciando servidor..."
Start-Process "C:\Program Files\nodejs\node.exe" `
    -ArgumentList "server.js" `
    -WorkingDirectory "C:\Users\Maissistem\Desktop\SAIPOS API" `
    -RedirectStandardOutput "C:\Users\Maissistem\Desktop\SAIPOS API\server.log" `
    -RedirectStandardError  "C:\Users\Maissistem\Desktop\SAIPOS API\server_err.log" `
    -NoNewWindow

Start-Sleep -Seconds 3
Write-Output "=== STDOUT ==="
Get-Content "C:\Users\Maissistem\Desktop\SAIPOS API\server.log" -ErrorAction SilentlyContinue
Write-Output "=== STDERR ==="
Get-Content "C:\Users\Maissistem\Desktop\SAIPOS API\server_err.log" -ErrorAction SilentlyContinue
