$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
$base = "http://localhost:3000"
$resultados = @()

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
        Write-Host "ERRO $($_.Exception.Message)" -ForegroundColor Red
        if ($errBody) { Write-Host $errBody -ForegroundColor Red }
        return $null
    }
}

# IDs para reutilizar nos testes
$ticketId = $null
$tableId  = $null
$cancelId = $null

# ── TESTE 1: Listar garçons
Write-Host "`n[TESTE 1] Garçons disponíveis" -ForegroundColor Magenta
Invoke-Api "GET" "/api/waiters?environment=homologation"

# ── TESTE 2: Listar pedidos
Write-Host "`n[TESTE 2] Listar todos os pedidos" -ForegroundColor Magenta
Invoke-Api "GET" "/api/orders?environment=homologation"

# ── TESTE 3: Criar comanda TICKET (ficha)
Write-Host "`n[TESTE 3] Criar comanda TICKET" -ForegroundColor Magenta
$ticketBody = @{
    ticket_reference = "Ficha Teste 02"
    customer = @{ id = "CLI-003"; name = "João da Silva"; phone = "51911111111" }
    notes = "Teste completo - TICKET"
    items = @(@{ integration_code = "1234"; desc_item = "PEDIDO DE TESTE - PEQUENO"; quantity = 2; unit_price = 0 })
    payment_types = @(@{ code = "DIN"; amount = 0 })
}
$ticketResult = Invoke-Api "POST" "/api/orders/ticket?environment=homologation" $ticketBody
if ($ticketResult) { $ticketId = $ticketResult.order_id }

# ── TESTE 4: Criar pedido na MESA 10
Write-Host "`n[TESTE 4] Criar pedido TABLE - Mesa 10" -ForegroundColor Magenta
$tableBody = @{
    table_number = "10"
    customer = @{ id = "CLI-004"; name = "Maria Souza"; phone = "51922222222" }
    notes = "Teste completo - Mesa 10"
    items = @(@{ integration_code = "1234"; desc_item = "PEDIDO DE TESTE - PEQUENO"; quantity = 1; unit_price = 0 })
    payment_types = @(@{ code = "DIN"; amount = 0 })
}
$tableResult = Invoke-Api "POST" "/api/orders/table?environment=homologation" $tableBody
if ($tableResult) { $tableId = $tableResult.order_id }

# ── TESTE 5: Criar pedido DELIVERY (para cancelar)
Write-Host "`n[TESTE 5] Criar pedido TAKEOUT (para cancelar depois)" -ForegroundColor Magenta
$cancelBody = @{
    mode = "TAKEOUT"
    customer = @{ id = "CLI-005"; name = "Pedro Cancel"; phone = "51933333333" }
    notes = "Pedido para cancelamento - teste"
    total_amount = 0
    items = @(@{ integration_code = "1234"; desc_item = "PEDIDO DE TESTE - PEQUENO"; quantity = 1; unit_price = 0 })
    payment_types = @(@{ code = "DIN"; amount = 0 })
}
$cancelResult = Invoke-Api "POST" "/api/orders/delivery?environment=homologation" $cancelBody
if ($cancelResult) { $cancelId = $cancelResult.order_id }

# ── TESTE 6: Consultar status de mesas e pads da mesa 10
# Primeiro busca a mesa 10 para descobrir os pads ativos
Write-Host "`n[TESTE 6] Status da Mesa 10 (descobrindo pads ativos)" -ForegroundColor Magenta
$statusMesa10 = Invoke-Api "GET" "/api/orders/status?environment=homologation&table=10"

# Extrai o pad ativo da mesa 10 e consulta por pad
$padAtivo = if ($statusMesa10 -and $statusMesa10[0]) { $statusMesa10[0].pad } elseif ($statusMesa10) { $statusMesa10.pad } else { $null }
if ($padAtivo) {
    Write-Host "`n[TESTE 6b] Consultando por pad=$padAtivo (ativo na mesa 10)" -ForegroundColor Magenta
    Invoke-Api "GET" "/api/orders/status?environment=homologation&pad=$padAtivo"
}

# ── TESTE 7: Consultar status de mesas (mesa 10)
Write-Host "`n[TESTE 7] Status da Mesa 10 (confirmação)" -ForegroundColor Magenta
$statusMesa = Invoke-Api "GET" "/api/orders/status?environment=homologation&table=10"

# ── TESTE 8: Cancelar pedido (o TAKEOUT criado no teste 5)
Start-Sleep -Seconds 2
Write-Host "`n[TESTE 8] Cancelar pedido TAKEOUT (order_id: $cancelId)" -ForegroundColor Magenta
if ($cancelId) {
    Invoke-Api "POST" "/api/orders/cancel?environment=homologation" @{ order_id = $cancelId }
} else {
    Write-Host "Pulando - cancelId não disponível" -ForegroundColor Yellow
}

# ── TESTE 9: Buscar pedido por order_id
Write-Host "`n[TESTE 9] Buscar pedido TABLE pela order_id" -ForegroundColor Magenta
if ($tableId) {
    Invoke-Api "GET" "/api/orders?environment=homologation&order_id=$tableId"
} else {
    Write-Host "Pulando - tableId não disponível" -ForegroundColor Yellow
}

# ── TESTE 10: Fechar mesa (usando o primeiro order_id ativo da mesa 10)
Write-Host "`n[TESTE 10] Fechar Mesa 10 (close-sale)" -ForegroundColor Magenta
# Pega o order_id do primeiro item ativo (id_table_order_status = 2 = aberto)
$mesaAberta = if ($statusMesa -is [System.Array]) {
    $statusMesa | Where-Object { $_.id_table_order_status -eq 2 } | Select-Object -First 1
} elseif ($statusMesa.id_table_order_status -eq 2) {
    $statusMesa
} else { $null }

$mesaOrderId = if ($mesaAberta) { $mesaAberta.order_id } else { $tableId }
if ($mesaOrderId) {
    Write-Host "Usando order_id: $mesaOrderId" -ForegroundColor Gray
    Invoke-Api "PUT" "/api/orders/close?environment=homologation" @{ order_id = $mesaOrderId }
} else {
    Write-Host "Pulando - nenhuma mesa aberta encontrada" -ForegroundColor Yellow
}

# ── RESUMO
Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "RESUMO DOS IDs CRIADOS:" -ForegroundColor Green
Write-Host "  Ticket (ficha): $ticketId"
Write-Host "  Table (mesa 10): $tableId"
Write-Host "  Cancelado: $cancelId"
Write-Host "  Mesa 10 order_id (para close): $mesaOrderId"
Write-Host "Testes concluídos!" -ForegroundColor Green
