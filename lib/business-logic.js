'use strict';

/**
 * Lógica determinística de negócio para pedidos.
 * Nenhuma decisão é tomada pela LLM — tudo é regra de código.
 */

const { recalculateTotal } = require('./validators');

// ── Helpers ─────────────────────────────────────────────────────────────

const clean = (v) => String(v || '').trim();
const toNumberOrOne = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 1; };
const normalizeForMatch = (v) => String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();

// ── Busca no Catálogo ───────────────────────────────────────────────────

/**
 * Busca um item no catálogo por nome, usando fuzzy match.
 * Retorna o item do catálogo ou null.
 */
function findCatalogItem(itemName, catalog) {
    if (!itemName || !Array.isArray(catalog) || !catalog.length) return null;
    const target = normalizeForMatch(itemName);
    if (!target) return null;

    let best = null;
    let bestScore = 0;

    for (const catItem of catalog) {
        const catNorm = normalizeForMatch(catItem?.name || '');
        if (!catNorm) continue;

        let score = 0;
        if (catNorm === target) {
            score = 1000;
        } else if (catNorm.includes(target) || target.includes(catNorm)) {
            score = 800 + Math.min(catNorm.length, target.length);
        } else {
            // Token overlap
            const catTokens = catNorm.split(' ').filter(Boolean);
            const targetTokens = target.split(' ').filter(Boolean);
            const targetSet = new Set(targetTokens);
            const overlap = catTokens.filter((t) => targetSet.has(t)).length;
            const ratio = overlap / Math.max(catTokens.length, targetTokens.length, 1);
            if (ratio >= 0.6) score = 500 + Math.round(ratio * 130);
        }

        if (score > bestScore) {
            bestScore = score;
            best = catItem;
        }
    }

    return bestScore >= 560 ? best : null;
}

// ── Tools Determinísticas ───────────────────────────────────────────────

/**
 * Adiciona um item ao carrinho. Valida contra o catálogo.
 * @returns {{ success: boolean, message: string, data?: object }}
 */
function addItemToCart(intent, catalog, transaction) {
    const itemName = clean(intent.item_name || intent.name || '');
    const quantity = toNumberOrOne(intent.quantity);
    if (!itemName) return { success: false, message: 'Nome do item não informado' };

    const catItem = findCatalogItem(itemName, catalog);
    if (!catItem) {
        return { success: false, message: `Item "${itemName}" não encontrado no cardápio` };
    }

    const items = transaction.items || [];
    const existing = items.find((i) =>
        clean(i.integration_code) && clean(catItem.integration_code)
            ? clean(i.integration_code) === clean(catItem.integration_code)
            : normalizeForMatch(i.name) === normalizeForMatch(catItem.name)
    );

    if (existing) {
        if (intent.incremental) {
            existing.quantity += quantity;
        } else {
            existing.quantity = quantity;
        }
    } else {
        items.push({
            name: catItem.name,
            quantity,
            integration_code: catItem.integration_code || null,
            unit_price: Number(catItem.unit_price || 0) || null,
        });
    }

    transaction.items = items;
    transaction.total_amount = recalculateTotal(items);

    return {
        success: true,
        message: `Adicionado: ${quantity}x ${catItem.name}`,
        data: { itemName: catItem.name, quantity, total: transaction.total_amount },
    };
}

/**
 * Remove um item do carrinho por nome.
 * @returns {{ success: boolean, message: string }}
 */
function removeItem(intent, transaction) {
    const itemName = clean(intent.item_name || intent.name || '');
    if (!itemName) return { success: false, message: 'Nome do item não informado' };

    const items = transaction.items || [];
    const target = normalizeForMatch(itemName);
    const idx = items.findIndex((i) => normalizeForMatch(i.name) === target);

    if (idx === -1) {
        return { success: false, message: `Item "${itemName}" não está no carrinho` };
    }

    const removed = items.splice(idx, 1)[0];
    transaction.items = items;
    transaction.total_amount = recalculateTotal(items);

    return {
        success: true,
        message: `Removido: ${removed.name}`,
        data: { itemName: removed.name, total: transaction.total_amount },
    };
}

/**
 * Atualiza a quantidade de um item no carrinho.
 * @returns {{ success: boolean, message: string }}
 */
function updateQuantity(intent, transaction) {
    const itemName = clean(intent.item_name || intent.name || '');
    const newQty = toNumberOrOne(intent.quantity);
    if (!itemName) return { success: false, message: 'Nome do item não informado' };

    const items = transaction.items || [];
    const target = normalizeForMatch(itemName);
    const item = items.find((i) => normalizeForMatch(i.name) === target);

    if (!item) {
        return { success: false, message: `Item "${itemName}" não está no carrinho` };
    }

    item.quantity = newQty;
    transaction.total_amount = recalculateTotal(items);

    return {
        success: true,
        message: `Atualizado: ${item.name} → ${newQty}x`,
        data: { itemName: item.name, quantity: newQty, total: transaction.total_amount },
    };
}

/**
 * Merge progressivo de endereço — preenche só campos informados.
 * @returns {{ success: boolean, message: string, data?: object }}
 */
function setAddress(extracted, transaction) {
    const addr = extracted?.address || extracted || {};
    if (!addr || typeof addr !== 'object') {
        return { success: false, message: 'Endereço não informado' };
    }

    if (!transaction.address) {
        transaction.address = { street_name: '', street_number: '', neighborhood: '', city: '', state: '', postal_code: '' };
    }

    let changed = false;
    for (const [key, value] of Object.entries(addr)) {
        const v = clean(value);
        if (v && v.toLowerCase() !== 'nao informado' && v.toLowerCase() !== 'não informado') {
            if (transaction.address[key] !== v) {
                transaction.address[key] = v;
                changed = true;
            }
        }
    }

    // Auto-detect mode
    if (!clean(transaction.mode) && (clean(transaction.address.street_name) || clean(transaction.address.neighborhood))) {
        transaction.mode = 'DELIVERY';
    }

    return {
        success: changed,
        message: changed ? 'Endereço atualizado' : 'Nenhum campo novo de endereço informado',
        data: { address: transaction.address },
    };
}

/**
 * Define a forma de pagamento.
 * @returns {{ success: boolean, message: string }}
 */
function setPayment(payment, transaction) {
    const p = clean(payment);
    if (!p) return { success: false, message: 'Forma de pagamento não informada' };

    transaction.payment = p;
    return {
        success: true,
        message: `Pagamento definido: ${p}`,
        data: { payment: p },
    };
}

module.exports = {
    findCatalogItem,
    addItemToCart,
    removeItem,
    updateQuantity,
    setAddress,
    setPayment,
};
