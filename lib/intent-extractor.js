'use strict';

/**
 * Extração de intenção com JSON Schema enforcement.
 * O LLM só retorna JSON estruturado — nunca texto livre.
 */

// ── JSON Schemas ────────────────────────────────────────────────────────

const INTENT_SCHEMA = {
    name: 'intent_extraction',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: [
                    'add_item', 'remove_item', 'update_quantity',
                    'set_address', 'set_payment', 'set_mode',
                    'confirm_order', 'cancel_order',
                    'ask_menu', 'ask_question', 'greeting',
                    'unknown',
                ],
            },
            item_name: { type: ['string', 'null'] },
            quantity: { type: ['number', 'null'] },
            items: {
                type: ['array', 'null'],
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        quantity: { type: 'number' },
                        incremental: { type: 'boolean' },
                    },
                    required: ['name', 'quantity'],
                    additionalProperties: false,
                },
            },
            mode: { type: ['string', 'null'], enum: ['DELIVERY', 'PICKUP', null] },
            payment: { type: ['string', 'null'] },
            address: {
                type: ['object', 'null'],
                properties: {
                    street_name: { type: ['string', 'null'] },
                    street_number: { type: ['string', 'null'] },
                    neighborhood: { type: ['string', 'null'] },
                    city: { type: ['string', 'null'] },
                    state: { type: ['string', 'null'] },
                    postal_code: { type: ['string', 'null'] },
                },
                additionalProperties: false,
            },
            customer_name: { type: ['string', 'null'] },
            notes: { type: ['string', 'null'] },
            confirmation: { type: ['boolean', 'null'] },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

// ── Extração de Intenção ────────────────────────────────────────────────

/**
 * Extrai intenção estruturada da mensagem do usuário via LLM com JSON Schema.
 * NUNCA retorna texto livre — sempre JSON válido.
 *
 * @param {Object} openai - instância OpenAI
 * @param {string} userMessage - mensagem do usuário
 * @param {Object} options - { model, menuSample }
 * @returns {Promise<Object>} - intent extraída
 */
async function extractIntent(openai, userMessage, options = {}) {
    const model = options.model || 'gpt-4.1-mini';
    const menuHint = options.menuSample
        ? `\nItens do cardápio disponíveis:\n${options.menuSample}`
        : '';

    try {
        const response = await openai.chat.completions.create({
            model,
            temperature: 0,
            max_tokens: 300,
            response_format: {
                type: 'json_schema',
                json_schema: INTENT_SCHEMA,
            },
            messages: [
                {
                    role: 'system',
                    content: `Você é um extrator de intenção para pedidos de restaurante.
Analise a mensagem do cliente e retorne APENAS JSON estruturado.

Ações possíveis:
- add_item: cliente quer adicionar item ao pedido
- remove_item: cliente quer remover item
- update_quantity: cliente quer mudar quantidade
- set_address: cliente informou endereço
- set_payment: cliente informou forma de pagamento
- set_mode: cliente escolheu entrega ou retirada
- confirm_order: cliente confirmou o pedido
- cancel_order: cliente quer cancelar
- ask_menu: cliente quer ver o cardápio
- ask_question: cliente fez pergunta sobre horário, taxas, etc.
- greeting: cliente apenas cumprimentou
- unknown: não foi possível classificar

Se o cliente pediu múltiplos itens, use o campo "items" (array).
Se pediu apenas um, use "item_name" + "quantity" ou "items" com 1 elemento.
Se mencionou "mais 1" ou "adiciona", marque incremental=true no item.
${menuHint}`,
                },
                {
                    role: 'user',
                    content: userMessage,
                },
            ],
        });

        const content = response.choices?.[0]?.message?.content;
        if (!content) return { action: 'unknown' };

        const parsed = JSON.parse(content);
        return parsed;
    } catch (err) {
        // Fallback: se schema enforcement falhar, retorna unknown
        return { action: 'unknown', _error: String(err?.message || err) };
    }
}

module.exports = {
    extractIntent,
    INTENT_SCHEMA,
};
