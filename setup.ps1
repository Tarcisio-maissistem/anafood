$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
Set-Location "C:\Users\Maissistem\Desktop\SAIPOS API"

Write-Output "Node version: $(& 'C:\Program Files\nodejs\node.exe' --version)"
Write-Output "NPM version: $(& 'C:\Program Files\nodejs\npm.cmd' --version)"

Write-Output "Criando package.json..."
& 'C:\Program Files\nodejs\npm.cmd' init -y

Write-Output "Instalando dependencias..."
& 'C:\Program Files\nodejs\npm.cmd' install express dotenv puppeteer

Write-Output "Instalacao concluida!"
& 'C:\Program Files\nodejs\npm.cmd' list --depth=0
