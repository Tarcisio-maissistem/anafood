$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
Set-Location "C:\Users\Maissistem\Desktop\SAIPOS API"
Write-Output "Instalando openai e axios..."
& 'C:\Program Files\nodejs\npm.cmd' install openai axios
Write-Output "Concluido!"
& 'C:\Program Files\nodejs\npm.cmd' list --depth=0
