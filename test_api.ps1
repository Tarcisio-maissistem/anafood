$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
$base = "http://localhost:3000"

function Invoke-Api($method, $path, $body = $null) {
    $uri = "$base$path"
    Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "$method $uri" -ForegroundColor Yellow
    $params = @{ Method = $method; Uri = $uri; ContentType = "application/json"; UseBasicParsing = $true }
    if ($body) {
        $params.Body = ($body | ConvertTo-Json -Depth 10)
        Write-Host "Body: $($params.Body)" -ForegroundColor Gray
    }
    try {
        $response = Invoke-WebRequest @params
        $json = $response.Content | ConvertFrom-Json
        Write-Host "Status: $($response.StatusCode) OK" -ForegroundColor Green
        Write-Host ($json | ConvertTo-Json -Depth 10) -ForegroundColor White
        return $json
    } catch {
        $errBody = $_.ErrorDetails.Message
        Write-Host "ERRO: $($_.Exception.Message)" -ForegroundColor Red
        if ($errBody) { Write-Host $errBody -ForegroundColor Red }
        return $null
    }
}

# ── Teste 1: Rota raiz (documentação)
Write-Host "`n[TESTE 1] Rota raiz - listagem de endpoints" -ForegroundColor Magenta
Invoke-Api "GET" "/"

# ── Teste 2: Autenticação
Write-Host "`n[TESTE 2] Autenticação - obter token" -ForegroundColor Magenta
Invoke-Api "GET" "/api/auth?environment=homologation"

# ── Teste 3: Catálogo
Write-Host "`n[TESTE 3] Catálogo de produtos" -ForegroundColor Magenta
Invoke-Api "GET" "/api/catalog?environment=homologation"

# ── Teste 4: Enviar pedido de comanda (TICKET) com item de teste
Write-Host "`n[TESTE 4] Criar comanda TICKET com cliente e item" -ForegroundColor Magenta
$ticketBody = @{
    ticket_reference = "Comanda Teste 01"
    customer = @{
        id    = "TESTE-001"
        name  = "Cliente Teste"
        phone = "51999999999"
    }
    notes = "Pedido de teste - integração SAIPOS API"
    items = @(
        @{
            integration_code = "1234"
            desc_item        = "PEDIDO DE TESTE - PEQUENO"
            quantity         = 1
            unit_price       = 0
        }
    )
    payment_types = @(
        @{ code = "DIN"; amount = 0 }
    )
}
$ticket = Invoke-Api "POST" "/api/orders/ticket?environment=homologation" $ticketBody

# ── Teste 5: Enviar pedido TAKEOUT (retirada)
Write-Host "`n[TESTE 5] Criar pedido TAKEOUT (retirada)" -ForegroundColor Magenta
$takeoutBody = @{
    mode = "TAKEOUT"
    customer = @{
        id    = "TESTE-002"
        name  = "Cliente Retirada"
        phone = "51988888888"
    }
    notes        = "Pedido de retirada - integração SAIPOS API"
    total_amount = 0
    items = @(
        @{
            integration_code = "1234"
            desc_item        = "PEDIDO DE TESTE - PEQUENO"
            quantity         = 1
            unit_price       = 0
        }
    )
    payment_types = @(
        @{ code = "DIN"; amount = 0 }
    )
}
Invoke-Api "POST" "/api/orders/delivery?environment=homologation" $takeoutBody

Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "Testes concluídos! Verifique os resultados acima." -ForegroundColor Green
