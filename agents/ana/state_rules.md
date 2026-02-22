# Regras de Estado e Transicao - Agente Ana

Este documento define regras operacionais para eliminar ambiguidade entre mensagem, estado e scheduler.

## 1) Principios

- Toda resposta depende do estado atual.
- Nenhuma mensagem deve furar a maquina de estados.
- Estado e dados do pedido devem ser persistidos em cada transicao.
- Confirmacao final depende exclusivamente do backend.

## 2) Gate de Processamento

Antes de responder:
1. Carregar estado persistido da conversa.
2. Verificar se a transicao proposta e permitida.
3. Verificar se ha timeout de sessao.
4. Executar regra de idempotencia.
5. Somente entao gerar mensagem ao cliente.

## 3) Regras Minimas por Estado de Referencia

### INIT
- Pode enviar saudacao inicial.
- Se estado atual nao for INIT, saudacao inicial e proibida.

### AWAITING_ITEM
- Coleta ou ajuste de itens.
- Nao deve confirmar pedido.

### AWAITING_ADDRESS
- Coleta dados de endereco obrigatorios.
- Nao deve pular para conclusao sem dados minimos.

### AWAITING_PAYMENT
- Coleta metodo de pagamento.
- Para dinheiro, coletar troco para.

### CONFIRMING
- Exibir resumo estruturado.
- Confirmar apenas com `validateFinalOrder().valid == true`.

### COMPLETED
- Nao pedir confirmacao novamente.
- Nao enviar lembrete.
- So iniciar novo fluxo se usuario pedir claramente "novo pedido".

### CANCELLED
- Encerrar fluxo ativo.
- Nao reativar automaticamente sem nova intencao explicita.

## 4) Regras de Transparencia Financeira

Se `mode == DELIVERY`, o resumo deve conter obrigatoriamente:
- Subtotal
- Taxa de entrega
- Total final

Se faltar taxa em delivery:
- Bloquear confirmacao.
- Solicitar revisao automatica ao backend.

## 5) Regras de Idempotencia

- Mensagens repetidas de confirmacao nao podem duplicar pedido.
- Confirmacao fora de `CONFIRMING` deve ser ignorada de forma segura.
- Se pedido ja concluido, resposta deve informar status atual, sem recriar ordem.

## 6) Regras do Scheduler

Lembrete so pode existir quando:
- Estado pendente.
- Janela de inatividade excedida.
- Pedido nao concluido e nao cancelado.

Ao concluir ou cancelar:
- Cancelar lembretes pendentes imediatamente.

Falha critica:
- Se scheduler enviar lembrete apos conclusao, registrar incidente operacional.

## 7) Timeout de Sessao

Quando exceder limite de inatividade:
- Resetar estado para `INIT`.
- Marcar pedido parcial como abandonado.
- Nao retomar fluxo antigo automaticamente.

## 8) Falha Controlada (Fail-safe)

Em erro interno, validacao inconsistente ou estado invalido:
- Responder: "Estamos com uma instabilidade momentanea. Vou transferir para atendimento humano."
- Registrar log estruturado de erro.
- Encaminhar para handoff humano.

## 9) Logging Estruturado Recomendado

Evento minimo por transicao:

```txt
[STATE_CHANGE]
from: COLETANDO_PAGAMENTO
to: FINALIZANDO
order_id: 4821
phone: 55XXXXXXXXXXX
timestamp: 2026-02-22T13:00:00Z
```

Eventos adicionais recomendados:
- `ORDER_VALIDATION_FAILED`
- `FOLLOWUP_SCHEDULED`
- `FOLLOWUP_CANCELLED`
- `IDEMPOTENT_CONFIRMATION_IGNORED`
- `SESSION_TIMEOUT_RESET`

## 10) Mapeamento Operacional para o Codigo Atual

Tabela de equivalencia para uso pratico:

- `INIT` -> `INIT`
- `AWAITING_ITEM` -> `ADICIONANDO_ITEM` / `CONFIRMANDO_CARRINHO`
- `AWAITING_ADDRESS` -> `COLETANDO_ENDERECO`
- `AWAITING_PAYMENT` -> `COLETANDO_PAGAMENTO` / `WAITING_PAYMENT`
- `CONFIRMING` -> `FINALIZANDO`
- `COMPLETED` -> `CONFIRMED`
- `CANCELLED` -> `CLOSED` (ou `INIT` com evento de cancelamento)
