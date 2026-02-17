$response = Invoke-WebRequest -Uri "https://evo.anafood.vip/instance/fetchInstances" `
    -Headers @{ "apikey" = "reIB3UITLJOuKFLxEw54tpHz43OyXF3C6COjVr4uMdtncrfIil94fSGRD0QcOqQc" } `
    -UseBasicParsing
Write-Output $response.Content
