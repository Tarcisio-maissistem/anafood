'use strict';

/**
 * Máquina de estados determinística para fluxo de pedido.
 * Define estados, transições válidas e a função de transição pura.
 */

// ── Estados ─────────────────────────────────────────────────────────────

const STATES = {
    INIT: 'INIT',
    MENU: 'MENU',
    ADICIONANDO_ITEM: 'ADICIONANDO_ITEM',
    CONFIRMANDO_CARRINHO: 'CONFIRMANDO_CARRINHO',
    COLETANDO_ENDERECO: 'COLETANDO_ENDERECO',
    COLETANDO_PAGAMENTO: 'COLETANDO_PAGAMENTO',
    FINALIZANDO: 'FINALIZANDO',
    WAITING_PAYMENT: 'WAITING_PAYMENT',
    CONFIRMED: 'CONFIRMED',
    HUMAN_HANDOFF: 'HUMAN_HANDOFF',
    CLOSED: 'CLOSED',
};

// ── Transições válidas ──────────────────────────────────────────────────

const VALID_TRANSITIONS = {
    [STATES.INIT]: [STATES.MENU, STATES.ADICIONANDO_ITEM, STATES.CONFIRMANDO_CARRINHO, STATES.FINALIZANDO, STATES.HUMAN_HANDOFF, STATES.CLOSED],
    [STATES.MENU]: [STATES.ADICIONANDO_ITEM, STATES.INIT, STATES.HUMAN_HANDOFF, STATES.CLOSED],
    [STATES.ADICIONANDO_ITEM]: [STATES.CONFIRMANDO_CARRINHO, STATES.MENU, STATES.ADICIONANDO_ITEM, STATES.INIT, STATES.HUMAN_HANDOFF, STATES.CLOSED],
    [STATES.CONFIRMANDO_CARRINHO]: [STATES.COLETANDO_ENDERECO, STATES.COLETANDO_PAGAMENTO, STATES.ADICIONANDO_ITEM, STATES.INIT, STATES.HUMAN_HANDOFF, STATES.CLOSED],
    [STATES.COLETANDO_ENDERECO]: [STATES.COLETANDO_PAGAMENTO, STATES.CONFIRMANDO_CARRINHO, STATES.ADICIONANDO_ITEM, STATES.INIT, STATES.HUMAN_HANDOFF, STATES.CLOSED],
    [STATES.COLETANDO_PAGAMENTO]: [STATES.FINALIZANDO, STATES.COLETANDO_ENDERECO, STATES.ADICIONANDO_ITEM, STATES.INIT, STATES.HUMAN_HANDOFF, STATES.CLOSED],
    [STATES.FINALIZANDO]: [STATES.WAITING_PAYMENT, STATES.CONFIRMED, STATES.ADICIONANDO_ITEM, STATES.INIT, STATES.HUMAN_HANDOFF, STATES.CLOSED],
    [STATES.WAITING_PAYMENT]: [STATES.CONFIRMED, STATES.FINALIZANDO, STATES.ADICIONANDO_ITEM, STATES.INIT, STATES.HUMAN_HANDOFF, STATES.CLOSED],
    [STATES.CONFIRMED]: [STATES.CONFIRMED, STATES.INIT, STATES.HUMAN_HANDOFF],
    [STATES.HUMAN_HANDOFF]: [STATES.INIT, STATES.HUMAN_HANDOFF],
    [STATES.CLOSED]: [STATES.INIT],
};

/**
 * Verifica se uma transição de estado é permitida.
 */
function isValidTransition(from, to) {
    if (from === to) return true;
    const allowed = VALID_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : true; // permissivo para estados desconhecidos
}

// ── Função de Transição ─────────────────────────────────────────────────

/**
 * Determina o próximo estado com base na ação extraída e no estado do pedido.
 * Função pura — sem side effects.
 *
 * @param {string} currentState
 * @param {string} intentAction - ação extraída (add_item, set_address, etc.)
 * @param {Object} transaction
 * @param {Object} options - { requireAddress, itemsPhaseComplete }
 * @returns {{ nextState: string, action: string }}
 */
function transition(currentState, intentAction, transaction, options = {}) {
    const tx = transaction || {};
    const hasItems = Array.isArray(tx.items) && tx.items.length > 0;
    const hasMode = Boolean(String(tx.mode || '').trim());
    const hasPayment = Boolean(String(tx.payment || '').trim());
    const hasAddress = Boolean(
        String(tx.address?.street_name || '').trim() &&
        String(tx.address?.street_number || '').trim() &&
        String(tx.address?.neighborhood || '').trim()
    );
    const isDelivery = String(tx.mode || '').toUpperCase() === 'DELIVERY';
    const requireAddress = options.requireAddress !== false;

    // Cancelamento em qualquer estado
    if (intentAction === 'cancel_order') {
        return { nextState: STATES.INIT, action: 'FLOW_CANCELLED' };
    }

    // Mapeamento de ação → estado
    switch (intentAction) {
        case 'add_item':
            return { nextState: STATES.ADICIONANDO_ITEM, action: 'ASK_MISSING_FIELDS' };

        case 'remove_item':
        case 'update_quantity':
            return { nextState: hasItems ? currentState : STATES.ADICIONANDO_ITEM, action: 'ORDER_REVIEW' };

        case 'set_mode':
            if (isDelivery && requireAddress && !hasAddress) {
                return { nextState: STATES.COLETANDO_ENDERECO, action: 'ASK_MISSING_FIELDS' };
            }
            if (!hasPayment) {
                return { nextState: STATES.COLETANDO_PAGAMENTO, action: 'ASK_MISSING_FIELDS' };
            }
            return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW' };

        case 'set_address':
            if (!hasPayment) {
                return { nextState: STATES.COLETANDO_PAGAMENTO, action: 'ASK_MISSING_FIELDS' };
            }
            return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW' };

        case 'set_payment':
            if (hasItems && hasMode && (!isDelivery || hasAddress || !requireAddress)) {
                return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW' };
            }
            return { nextState: currentState, action: 'ASK_MISSING_FIELDS' };

        case 'confirm_order':
            if (currentState === STATES.FINALIZANDO) {
                return tx.payment === 'PIX'
                    ? { nextState: STATES.WAITING_PAYMENT, action: 'CREATE_ORDER_AND_WAIT_PAYMENT' }
                    : { nextState: STATES.CONFIRMED, action: 'CREATE_ORDER_AND_CONFIRM' };
            }
            return { nextState: currentState, action: 'ASK_CONFIRMATION' };

        case 'ask_menu':
            return { nextState: STATES.MENU, action: 'SHOW_MENU' };

        case 'ask_question':
            return { nextState: currentState, action: 'ANSWER_AND_RESUME' };

        case 'greeting':
            if (currentState === STATES.INIT) {
                return { nextState: STATES.ADICIONANDO_ITEM, action: 'WELCOME' };
            }
            return { nextState: currentState, action: 'ASK_MISSING_FIELDS' };

        default:
            return { nextState: currentState, action: 'CLARIFY' };
    }
}

/**
 * Calcula campos faltantes para o pedido ficar completo.
 * Versão independente para uso pelo state-machine.
 */
function missingFields(transaction, options = {}) {
    const tx = transaction || {};
    const missing = [];
    const hasItems = Array.isArray(tx.items) && tx.items.length > 0;
    const requireAddress = options.requireAddress !== false;
    const itemsPhaseComplete = options.itemsPhaseComplete !== false;

    if (!hasItems) missing.push('items');
    if (hasItems && !itemsPhaseComplete) return ['items'];
    if (!String(tx.mode || '').trim()) missing.push('mode');
    if (String(tx.mode || '').toUpperCase() === 'DELIVERY' && requireAddress) {
        for (const f of ['street_name', 'street_number', 'neighborhood']) {
            if (!String(tx.address?.[f] || '').trim()) missing.push(`address.${f}`);
        }
    }
    if (!String(tx.payment || '').trim()) missing.push('payment');
    return missing;
}

module.exports = {
    STATES,
    VALID_TRANSITIONS,
    isValidTransition,
    transition,
    missingFields,
};
