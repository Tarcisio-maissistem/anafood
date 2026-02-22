'use strict';

/**
 * Validações determinísticas para pedidos de restaurante.
 * Nenhuma lógica depende de LLM — tudo é code-driven.
 */

// ── Endereço ────────────────────────────────────────────────────────────

/**
 * Verifica se o endereço tem os campos mínimos obrigatórios.
 * @param {Object} address
 * @returns {{ complete: boolean, missing: string[] }}
 */
function isAddressComplete(address) {
    const a = address || {};
    const clean = (v) => String(v || '').trim();
    const required = ['street_name', 'street_number', 'neighborhood'];
    const missing = required.filter((f) => !clean(a[f]));
    return { complete: missing.length === 0, missing };
}

// ── Pagamento ───────────────────────────────────────────────────────────

const VALID_PAYMENT_METHODS = new Set([
    'PIX', 'Dinheiro', 'Cartão', 'Vale refeição', 'Vale alimentação',
    'Boleto', 'Transferência', 'CASH', 'CARD',
]);

/**
 * Verifica se a forma de pagamento informada é válida.
 * @param {string} payment
 * @returns {{ valid: boolean, reason: string|null }}
 */
function isPaymentValid(payment) {
    const p = String(payment || '').trim();
    if (!p) return { valid: false, reason: 'Pagamento não informado' };
    if (!VALID_PAYMENT_METHODS.has(p)) return { valid: false, reason: `Forma de pagamento desconhecida: ${p}` };
    return { valid: true, reason: null };
}

// ── Pedido Final ────────────────────────────────────────────────────────

/**
 * Recalcula o total do zero a partir dos itens.
 * @param {Array} items
 * @returns {number}
 */
function recalculateTotal(items) {
    if (!Array.isArray(items)) return 0;
    return items.reduce((sum, it) => {
        const price = Number(it.unit_price || 0);
        const qty = Number(it.quantity || 1);
        return sum + (price * qty);
    }, 0);
}

/**
 * Validação central: verifica se o pedido tem tudo para ser confirmado.
 * @param {Object} transaction
 * @param {Object} options  { requireAddress: boolean }
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateFinalOrder(transaction, options = {}) {
    const tx = transaction || {};
    const errors = [];

    // Itens
    if (!Array.isArray(tx.items) || tx.items.length === 0) {
        errors.push('Nenhum item no pedido');
    } else {
        for (const item of tx.items) {
            if (!Number(item.quantity) || Number(item.quantity) <= 0) {
                errors.push(`Quantidade inválida para "${item.name || 'item'}"`);
            }
        }
    }

    // Modo
    if (!String(tx.mode || '').trim()) {
        errors.push('Modalidade (retirada/entrega) não definida');
    }

    // Endereço obrigatório para delivery
    if (String(tx.mode || '').toUpperCase() === 'DELIVERY' && options.requireAddress !== false) {
        const addr = isAddressComplete(tx.address);
        if (!addr.complete) {
            errors.push(`Endereço incompleto — faltam: ${addr.missing.join(', ')}`);
        }
    }

    // Pagamento
    const pay = isPaymentValid(tx.payment);
    if (!pay.valid) {
        errors.push(pay.reason);
    }

    // Verificação de total (divergência = possível bug)
    if (Array.isArray(tx.items) && tx.items.length > 0) {
        const expected = recalculateTotal(tx.items);
        const declared = Number(tx.total_amount || 0);
        if (Math.abs(expected - declared) > 0.01) {
            errors.push(`Total divergente: calculado=${expected.toFixed(2)}, declarado=${declared.toFixed(2)}`);
        }
    }

    return { valid: errors.length === 0, errors };
}

module.exports = {
    isAddressComplete,
    isPaymentValid,
    recalculateTotal,
    validateFinalOrder,
    VALID_PAYMENT_METHODS,
};
