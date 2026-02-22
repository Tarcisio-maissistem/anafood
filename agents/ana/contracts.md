# Contratos Operacionais - Agente Ana

Este documento separa responsabilidades entre LLM, backend transacional e scheduler para evitar comportamento nao deterministico.

## 1) LLM

Responsavel por:
- NLU (intencoes e entidades).
- Coleta de dados faltantes.
- Comunicacao clara e objetiva.

Nao responsavel por:
- Calculo financeiro.
- Validacao final de pedido.
- Decisao de confirmacao.
- Mutacao de estado fora do fluxo autorizado.

Entrada esperada:
- `state` atual.
- Snapshot de pedido (`transaction`).
- Resultado das validacoes de backend.
- Contexto do tenant/restaurante.

Saida esperada:
- Intencao extraida.
- Campos candidatos detectados.
- Resposta textual para o cliente.
- Acao sugerida (sem commit transacional).

## 2) Backend Transacional

Responsavel por:
- Maquina de estados fechada.
- Persistencia (fonte unica da verdade).
- Calculo de subtotal/taxa/total.
- `validateFinalOrder()`.
- Idempotencia de confirmacao.
- Geracao de numero de pedido.

Regras obrigatorias:
- Bloquear transicoes invalidas.
- Recalcular tudo antes de confirmar.
- Se modo delivery, taxa obrigatoria e visivel.
- Estado concluido nao aceita mutacoes de pedido.
- Confirmacao so com `valid: true`.

## 3) Scheduler de Follow-up

Responsavel por:
- Criar lembretes com identificador persistivel.
- Cancelar lembretes ao confirmar/cancelar pedido.
- Disparar apenas em estados pendentes e com inatividade.

Proibicoes:
- Nunca enviar lembrete para pedido concluido/cancelado.
- Nunca manter lembrete ativo apos confirmacao.

## 4) Politica de Falha Controlada

Quando ocorrer:
- Falha de validacao.
- Divergencia de total.
- Estado inconsistente.
- Timeout de sessao.
- Erro interno.

Resposta ao cliente:
- "Estamos com uma instabilidade momentanea. Vou transferir para atendimento humano."

Acoes internas:
- Registrar log estruturado.
- Acionar handoff humano.
- Encerrar fluxo transacional de forma segura.

## 5) Seguranca e Integridade

Regras:
- Nao aceitar total enviado pelo cliente.
- Nao aplicar desconto manual via texto livre.
- Nao alterar pedido apos status concluido.
- Tratar repeticao de confirmacao como evento idempotente.

## 6) Mapeamento de Estados (Referencia -> Implementacao Atual)

Estados de referencia (operacional):
- `INIT`
- `AWAITING_ITEM`
- `AWAITING_ADDRESS`
- `AWAITING_PAYMENT`
- `CONFIRMING`
- `COMPLETED`
- `CANCELLED`

Estados atuais em `agents/ana.js`:
- `INIT`
- `MENU`
- `ADICIONANDO_ITEM`
- `CONFIRMANDO_CARRINHO`
- `COLETANDO_ENDERECO`
- `COLETANDO_PAGAMENTO`
- `FINALIZANDO`
- `WAITING_PAYMENT`
- `CONFIRMED`
- `HUMAN_HANDOFF`
- `CLOSED`

Correspondencia recomendada:
- `AWAITING_ITEM` -> `ADICIONANDO_ITEM` ou `CONFIRMANDO_CARRINHO`
- `AWAITING_ADDRESS` -> `COLETANDO_ENDERECO`
- `AWAITING_PAYMENT` -> `COLETANDO_PAGAMENTO` ou `WAITING_PAYMENT`
- `CONFIRMING` -> `FINALIZANDO`
- `COMPLETED` -> `CONFIRMED`
- `CANCELLED` -> `CLOSED` (ou reset para `INIT` com evento de cancelamento registrado)
