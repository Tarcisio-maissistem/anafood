$envContent = @"
HOMOLOGATION_EMAIL=mais-sistem@saipos.com
HOMOLOGATION_PASSWORD=mais-sistem@saipos1

PRODUCTION_EMAIL=atendimento@canais.saipos.com
PRODUCTION_PASSWORD=atendimento
"@
Set-Content -Path "C:\Users\Maissistem\Desktop\SAIPOS API\.env" -Value $envContent -Encoding UTF8
Write-Output "Arquivo .env criado com sucesso"
