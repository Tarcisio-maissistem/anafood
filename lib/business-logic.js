'use strict';

const cleanText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function normalizeForMatch(t) { return cleanText(t).toLowerCase(); }

const toNumberOrOne = (v) => { const n = parseInt(String(v || '').trim(), 10); return Number.isFinite(n) && n > 0 ? n : 1; };

function addItemToCart(item, catalog, transaction) {
  const { item_name, quantity, incremental } = item;
  if (!item_name || !quantity) return { success: false, error: 'Missing item name or quantity' };

  const catalogItem = findCatalogItem(item_name, catalog);
  if (!catalogItem) return { success: false, error: 'Item not found in catalog' };

  const existingItem = transaction.items.find(i => i.integration_code === catalogItem.integration_code);
  if (existingItem) {
    if (incremental) {
      existingItem.quantity += quantity;
    } else {
      existingItem.quantity = quantity;
    }
  } else {
    transaction.items.push({
      name: catalogItem.name,
      quantity,
      integration_code: catalogItem.integration_code,
      unit_price: catalogItem.unit_price,
    });
  }
  return { success: true, transaction };
}

function removeItem(item_name, transaction) {
  const index = transaction.items.findIndex(i => i.name.toLowerCase() === item_name.toLowerCase());
  if (index > -1) {
    transaction.items.splice(index, 1);
    return { success: true, transaction };
  }
  return { success: false, error: 'Item not found in cart' };
}

function updateQuantity(item_name, quantity, transaction) {
  const item = transaction.items.find(i => i.name.toLowerCase() === item_name.toLowerCase());
  if (item) {
    item.quantity = quantity;
    return { success: true, transaction };
  }
  return { success: false, error: 'Item not found in cart' };
}

function setAddress(address, transaction) {
  if (!transaction.address) transaction.address = {};
  Object.assign(transaction.address, address);
  return { success: true, transaction };
}

function setPayment(payment, transaction) {
  transaction.payment = payment;
  return { success: true, transaction };
}

function findCatalogItem(item_name, catalog) {
  const normalizedName = normalizeForMatch(item_name);
  for (const item of catalog) {
    const normalizedCatalogItemName = normalizeForMatch(item.name);
    if (normalizedCatalogItemName === normalizedName) {
      return item;
    }
  }
  return null;
}

function toReaisAmount(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const raw = String(v || '');
  if (!raw.includes('.') && !raw.includes(',') && n >= 100) return n / 100;
  return n;
}

function resolveDeliveryFee(conversation, tx) {
  const deliveryAreas = Array.isArray(conversation?.companyData?.deliveryAreas) ? conversation.companyData.deliveryAreas : [];
  if (!deliveryAreas.length) return null;
  const neighborhood = normalizeForMatch(tx?.address?.neighborhood || '');
  const street = normalizeForMatch(tx?.address?.street_name || '');
  const targets = [neighborhood, street].filter(Boolean);
  if (!targets.length) return null;

  let best = null;
  let bestScore = 0;
  for (const area of deliveryAreas) {
    const areaName = cleanText(area?.neighborhood || area?.bairro || area?.zone_name || area?.name || '');
    const areaNorm = normalizeForMatch(areaName);
    if (!areaNorm) continue;
    let score = 0;
    for (const t of targets) {
      if (t === areaNorm) score = Math.max(score, 100);
      else if (t.includes(areaNorm) || areaNorm.includes(t)) score = Math.max(score, 70);
    }
    if (score > bestScore) {
      bestScore = score;
      best = area;
    }
  }
  if (!best) {
    if (deliveryAreas.length === 1) best = deliveryAreas[0];
  }
  if (!best) {
    const generic = deliveryAreas.find((a) => {
      const n = normalizeForMatch(a?.neighborhood || a?.bairro || a?.zone_name || a?.name || '');
      return /\b(geral|padrao|padrão|todos|todas|qualquer|toda cidade|cidade inteira|entrega)\b/.test(n);
    });
    if (generic) best = generic;
  }
  if (!best) return null;
  const fee = toReaisAmount(best?.fee ?? best?.taxa ?? best?.delivery_fee ?? 0);
  if (fee <= 0) return null;
  return {
    neighborhood: cleanText(best?.neighborhood || best?.bairro || best?.zone_name || best?.name || ''),
    fee,
  };
}

const tokenizeNormalized = (v) => normalizeForMatch(v).split(' ').filter(Boolean);
const singularizeToken = (token) => {
  let t = String(token || '').trim().toLowerCase();
  if (!t) return t;
  if (t === 'pudins') return 'pudim';
  if (t === 'capins') return 'capim';
  if (t === 'paes' || t === 'pães') return 'pao';
  if (t === 'marmitas') return 'marmita';
  if (t === 'pizzas') return 'pizza';
  if (t === 'lanches') return 'lanche';
  if (t === 'sucos') return 'suco';
  if (t === 'bolos') return 'bolo';
  if (t === 'pasteis' || t === 'pastéis') return 'pastel';
  if (t === 'combos') return 'combo';
  if (/ins$/.test(t) && t.length > 4) return t.slice(0, -2) + 'm';
  if (/oes$/.test(t)) return t.slice(0, -3) + 'ao';
  if (/aes$/.test(t)) return t.slice(0, -3) + 'ao';
  if (/is$/.test(t)) return t.slice(0, -2) + 'il';
  if (/res$/.test(t)) return t.slice(0, -1);
  if (/es$/.test(t) && t.length > 4) return t.slice(0, -2);
  if (/s$/.test(t) && t.length > 3) return t.slice(0, -1);
  return t;
};
const canonicalTokens = (v) => tokenizeNormalized(v).map(singularizeToken).filter(Boolean);

const detectYes = (t) => {
  const x = cleanText(t).toLowerCase();
  if (/^sim\b/.test(x) || /\btudo\s*certo\b/.test(x) || /\best[aá]\s*certo\b/.test(x)) return true;
  if (/^(sim|ok|isso|certo|confirmo|confirmar|fechado|claro|pode|bora|vai|positivo|afirmativo|quero|desejo|pode ser|com certeza|perfeito|exato|exatamente|correto|isso mesmo|tá bom|ta bom|tudo certo|manda|manda sim|quero sim|pode mandar|fechou|topo|combinado|beleza)$/.test(x)) return true;
  if (/\b(ma?is|mas)\s+sim\b/.test(x)) return true;
  if (/\bsim\b/.test(x) && !/\bnao\b/.test(x) && !/\bnão\b/.test(x)) return true;
  if (x.includes('confirm') || x.includes('quero sim') || x.includes('pode sim') || x.includes('claro que sim')) return true;
  if (/\bpode\s+confirm[ae]r?\b/.test(x)) return true;
  if (/\be\s+isso\s+(a[ií]|mesmo)\b/.test(x) || /\bé\s+isso\s+(a[ií]|mesmo)\b/.test(x)) return true;
  if (/\b(finaliz[ae]r?|conclu[ií]r?|fecha[rr]?|envi[ae]r?)\b/.test(x)) return true;
  if (/\b(ta|tá|tah)\s+(bom|certo|ok)\b/.test(x)) return true;
  if (/\b(manda|envia|vai)\s+(l[aá]|embora|pedido)\b/.test(x)) return true;
  if (/^(ok|okay)\b/.test(x)) return true;
  if (/\bsim\s+ok\b/.test(x) || /\bok\s+sim\b/.test(x)) return true;
  return false;
};
const detectNo = (t) => {
  const x = cleanText(t).toLowerCase();
  if (/^(nao|não|negativo|cancelar|cancela|nope|jamais|nunca|dispenso|desisto|para)$/.test(x)) return true;
  if (x.includes('nao quero') || x.includes('não quero') || x.includes('deixa pra la') || x.includes('deixa pra lá') || x.includes('esquece') || x.includes('pode cancelar') || x.includes('cancela') || x.includes('nao obrigado') || x.includes('não obrigado') || x.includes('nao precisa') || x.includes('não precisa') || x.includes('pode parar') || x.includes('nao quero mais') || x.includes('não quero mais')) return true;
  return false;
};
const detectItemsPhaseDone = (t) => {
  const x = normalizeForMatch(t);
  if (!x) return false;
  return /\b(so isso|somente isso|apenas isso|e isso|isso mesmo|pode fechar|fechar pedido|fechar|nada mais|pedido completo)\b/.test(x);
};
const formatBRL = (n) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return 'R$ 0,00';
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
};

function normalizePaymentLabel(value) {
  const x = normalizeForMatch(value);
  if (!x) return '';
  if (/\bpix\b/.test(x)) return 'PIX';
  if (/\b(dinheiro|especie|cash)\b/.test(x)) return 'Dinheiro';
  if (/\b(cartao|credito|debito)\b/.test(x)) return 'Cartão';
  if (/\b(vale refeicao|vr)\b/.test(x)) return 'Vale refeição';
  if (/\b(vale alimentacao|va)\b/.test(x)) return 'Vale alimentação';
  if (/\b(boleto)\b/.test(x)) return 'Boleto';
  if (/\b(transferencia|transferencia bancaria|ted|doc)\b/.test(x)) return 'Transferência';
  return cleanText(value);
}

function extractPaymentMethodsFromText(info) {
  const x = normalizeForMatch(info);
  if (!x) return [];
  const found = [];
  if (/\bpix\b/.test(x)) found.push('PIX');
  if (/\b(cartao|credito|debito)\b/.test(x)) found.push('Cartão');
  if (/\b(dinheiro|especie|cash)\b/.test(x)) found.push('Dinheiro');
  if (/\b(vale refeicao|vr)\b/.test(x)) found.push('Vale refeição');
  if (/\b(vale alimentacao|va)\b/.test(x)) found.push('Vale alimentação');
  if (/\b(boleto)\b/.test(x)) found.push('Boleto');
  if (/\b(transferencia|ted|doc)\b/.test(x)) found.push('Transferência');
  return found;
}

function getAvailablePaymentMethods(runtime, conversation) {
  const mcp = conversation?.companyData || {};
  const company = mcp?.company || {};
  const ctx = runtime?.companyContext || {};
  const raw = [
    ...(Array.isArray(mcp.paymentMethods) ? mcp.paymentMethods : []),
    ...(Array.isArray(ctx.paymentMethods) ? ctx.paymentMethods : []),
    ...extractPaymentMethodsFromText(mcp.paymentInfo || ''),
    ...extractPaymentMethodsFromText(company.paymentInfo || company.payment_info || ''),
    ...extractPaymentMethodsFromText(ctx.paymentInfo || ''),
  ];
  const labels = raw.map(normalizePaymentLabel).filter(Boolean);
  const unique = Array.from(new Set(labels));
  return unique.length ? unique : ['PIX', 'Cartão', 'Dinheiro'];
}

// Nomes que NUNCA devem ser usados como nome do restaurante (fornecedor, sistema, genéricos)
const BLOCKED_COMPANY_NAMES = /mais\s*sistem|automa[cç][aã]o\s*comercial|anafood|ana\s*food|sistema|saipos|ifood|rappi|uber\s*eats/i;

function getCompanyDisplayName(runtime, conversation = null) {
  const company = conversation?.companyData?.company || {};
  const fromMcp = cleanText(
    company.trade_name
    || company.fantasy_name
    || company.display_name
    || company.company_name
    || company.name
    || company.razao_social
    || company.legal_name
    || ''
  );
  if (fromMcp && !BLOCKED_COMPANY_NAMES.test(fromMcp)) return fromMcp;

  const fromContext = cleanText(runtime?.companyContext?.companyName || '');
  if (fromContext && !BLOCKED_COMPANY_NAMES.test(fromContext)) return fromContext;

  const fromRuntime = cleanText(runtime?.name || '');
  if (fromRuntime && !BLOCKED_COMPANY_NAMES.test(fromRuntime)) return fromRuntime;

  return '';
}

const normalizeStateUF = (value) => {
  const raw = cleanText(value).toUpperCase();
  if (!raw) return '';
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  const map = {
    'GOIAS': 'GO',
    'GOIÁS': 'GO',
    'SAO PAULO': 'SP',
    'SÃO PAULO': 'SP',
    'RIO DE JANEIRO': 'RJ',
    'MINAS GERAIS': 'MG',
    'PARANA': 'PR',
    'PARANÁ': 'PR',
    'SANTA CATARINA': 'SC',
    'RIO GRANDE DO SUL': 'RS',
    'DISTRITO FEDERAL': 'DF',
  };
  return map[raw] || '';
};

function extractAddressFromText(text) {
  const raw = String(text || '');
  const sanitized = raw
    .replace(/\b(no|na)\s+(dinheiro|pix|cart[aã]o|cartao|cr[eé]dito|debito|d[eé]bito)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = sanitized.toLowerCase();
  const out = {};

  let remainingText = sanitized;

  const streetMatch = remainingText.match(/\b(rua|av(?:enida)?|alameda|travessa|quadra|qd)\s+([^,]+)/i);
  if (streetMatch) {
    out.street_name = cleanText(`${streetMatch[1]} ${streetMatch[2]}`);
    remainingText = remainingText.replace(streetMatch[0], '');
  }

  if (/\b(sem\s*n[uú]mero|s\/n)\b/i.test(remainingText)) {
    out.street_number = 'S/N';
    remainingText = remainingText.replace(/\b(sem\s*n[uú]mero|s\/n)\b/i, '');
  }
  const qdLtMatch = remainingText.match(/\b(qd\.?\s*\d+\s*lt\.?\s*\d+)\b/i);
  if (!out.street_number && qdLtMatch) {
    out.street_number = cleanText(qdLtMatch[1]).replace(/\s+/g, ' ');
    remainingText = remainingText.replace(qdLtMatch[0], '');
  }
  const numberMatch = remainingText.match(/\b(?:n(?:[úu]mero)?|num|casa)\s*[:#-]?\s*([0-9]{1,6}|s\/n)\b/i);
  if (!out.street_number && numberMatch) {
    out.street_number = String(numberMatch[1]).toUpperCase() === 'S/N' ? 'S/N' : cleanText(numberMatch[1]);
    remainingText = remainingText.replace(numberMatch[0], '');
  }
  if (!out.street_number && /\b0\b/.test(lower) && /(n[uú]mero|num|casa|sem numero)/i.test(remainingText)) {
    out.street_number = 'S/N';
  }

  // 1. Tenta extrair bairro com prefixo (lógica original)
  const neighborhoodMatch = remainingText.match(/\b(bairro|setor|jd|jardim|parque)\s+([^,]+)/i);
  if (neighborhoodMatch) {
    const prefix = cleanText(neighborhoodMatch[1]).toLowerCase();
    const base = cleanText(neighborhoodMatch[2]).replace(/\b(no|na)\s+(dinheiro|pix|cart[aã]o|cartao|cr[eé]dito|debito|d[eé]bito)\b.*/i, '').trim();
    if (prefix === 'bairro') out.neighborhood = base;
    else if (base.toLowerCase().startsWith(prefix)) out.neighborhood = base;
    else out.neighborhood = cleanText(`${prefix} ${base}`);
    remainingText = remainingText.replace(neighborhoodMatch[0], '');
  }

  const cep = remainingText.match(/\b\d{5}-?\d{3}\b|\b\d{8}\b/);
  if (cep) {
    out.postal_code = String(cep[0]).replace(/\D/g, '');
    remainingText = remainingText.replace(cep[0], '');
  }

  const cityUfSlash = remainingText.match(/\b([A-Za-z\u00C0-\u00FF\s]+)\s*\/\s*([A-Za-z]{2})\b/);
  if (cityUfSlash) {
    out.city = cleanText(cityUfSlash[1]);
    out.state = normalizeStateUF(cityUfSlash[2]);
    remainingText = remainingText.replace(cityUfSlash[0], '');
  } else {
    const cityUfInline = remainingText.match(/\b([A-Za-z\u00C0-\u00FF\s]+)\s+([A-Za-z]{2})\b$/);
    if (cityUfInline) {
      out.city = cleanText(cityUfInline[1]);
      out.state = normalizeStateUF(cityUfInline[2]);
      remainingText = remainingText.replace(cityUfInline[0], '');
    }
  }

  // 2. Fallback: se o bairro ainda não foi encontrado, assume que é o texto restante
  if (!out.neighborhood && cleanText(remainingText)) {
    out.neighborhood = cleanText(remainingText.replace(/o pagamento ja falei/i, ''));
  }

  // Limpezas finais para remover lixo de outros campos que podem ter vazado
  if (out.street_name && out.neighborhood) {
    const neighNorm = normalizeForMatch(out.neighborhood);
    const streetNorm = normalizeForMatch(out.street_name);
    if (neighNorm && streetNorm.includes(neighNorm)) {
      const escaped = out.neighborhood.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out.street_name = cleanText(out.street_name.replace(new RegExp(escaped, 'i'), '').trim());
    }
  }
  if (out.street_name && out.street_number) {
    out.street_name = cleanText(out.street_name.replace(/\bcasa\s+\d+\b/i, '').trim());
  }

  if (out.street_name) {
    out.street_name = cleanText(
      String(out.street_name || '')
        .replace(/\b(sim|ok|okay|nao|não|pix|dinheiro|cart[aã]o|cartao|entrega|retirada)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  if (out.neighborhood) {
    out.neighborhood = cleanText(
      String(out.neighborhood || '')
        .replace(/\b(sim|ok|okay|nao|não|pix|dinheiro|cart[aã]o|cartao|entrega|retirada)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  return out;
}

function enrichAddressWithCompanyDefaults(conversation) {
  const addr = conversation?.transaction?.address || {};
  const companyAddress = cleanText(conversation?.companyData?.company?.address || '');
  if (!companyAddress) return;

  if (!cleanText(addr.city) || !cleanText(addr.state)) {
    const m = companyAddress.match(/\b([A-Za-z\u00C0-\u00FF\s]+)\s*\/\s*([A-Za-z]{2})\b/);
    if (m) {
      if (!cleanText(addr.city)) addr.city = cleanText(m[1]);
      if (!cleanText(addr.state)) addr.state = normalizeStateUF(m[2]);
    }
  }
}

function isNonInformativeFieldValue(value) {
  const x = normalizeForMatch(value);
  if (!x) return true;
  return /\b(ja falei|jah falei|ja informei|ja passei|como ja falei|eu ja falei|mesmo de antes|o mesmo|isso ai|isso ae|isso mesmo)\b/.test(x);
}

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function isNearToken(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.abs(x.length - y.length) > 1) return false;
  const dist = levenshtein(x, y);
  const maxDist = Math.max(1, Math.floor(Math.min(x.length, y.length) / 5));
  return dist <= maxDist;
}

function resolveItemsWithCatalog(items, catalog) {
  const normalizedCatalog = (catalog || []).map((item) => ({
    raw: item,
    normalized: normalizeForMatch(item?.name || ''),
    tokens: tokenizeNormalized(item?.name || ''),
    canonical: canonicalTokens(item?.name || ''),
  })).filter((i) => i.normalized);

  const findBestCatalogMatch = (rawName) => {
    const target = normalizeForMatch(rawName);
    if (!target) return null;
    const targetTokens = tokenizeNormalized(target);
    const targetSet = new Set(targetTokens);
    const targetCanonical = canonicalTokens(target);
    const targetCanonicalSet = new Set(targetCanonical);
    let best = null;
    let bestScore = 0;

    for (const item of normalizedCatalog) {
      let score = 0;
      if (item.normalized === target) {
        score = 1000;
      } else if (item.normalized.includes(target) || target.includes(item.normalized)) {
        score = 800 + Math.min(item.normalized.length, target.length);
      } else {
        const overlap = item.tokens.filter((t) => targetSet.has(t)).length;
        const ratio = overlap / Math.max(item.tokens.length, targetTokens.length, 1);
        const canonicalOverlap = item.canonical.filter((t) => targetCanonicalSet.has(t)).length;
        const canonicalRatio = canonicalOverlap / Math.max(item.canonical.length, targetCanonical.length, 1);
        const fuzzyOverlap = item.tokens.filter((t) => targetTokens.some((tt) => isNearToken(t, tt))).length;
        const fuzzyRatio = fuzzyOverlap / Math.max(item.tokens.length, targetTokens.length, 1);
        const bestRatio = Math.max(ratio, canonicalRatio, fuzzyRatio);
        if (bestRatio >= 0.6) score = 500 + Math.round(bestRatio * 130);
      }
      if (score > bestScore) {
        bestScore = score;
        best = item.raw;
      }
    }

    return bestScore >= 560 ? best : null;
  };

  const unresolved = [];
  const resolved = [];
  for (const item of (items || [])) {
    const rawName = cleanText(item.name || item.nome || '');
    const match = findBestCatalogMatch(rawName);
    if (!match) { unresolved.push(item.name); continue; }
    resolved.push({ integration_code: String(match.integration_code), desc_item: match.name, quantity: toNumberOrOne(item.quantity), unit_price: Number(match.unit_price || 0) });
  }
  return { resolved, unresolved };
}





function toAnaFoodType(mode) {
  return (mode || 'DELIVERY').toUpperCase() === 'TAKEOUT' ? 'pickup' : 'delivery';
}

function toAnaFoodPayment(payment) {
  const p = String(payment || '').toLowerCase();
  if (p === 'pix') return 'pix';
  if (p === 'card') return 'cartao';
  return p || 'dinheiro';
}

function createOrderPayload({ conversation, customer, runtime }) {
  const tx = conversation.transaction || {};

  const { resolved, unresolved } = resolveItemsWithCatalog(conversation.transaction.items, conversation.catalog || []);
  if (unresolved.length) return { ok: false, unresolved };

  const feeInfo = (conversation.transaction.mode || 'DELIVERY') === 'DELIVERY'
    ? resolveDeliveryFee(conversation, conversation.transaction)
    : null;
  const deliveryFeeCents = feeInfo ? Math.round(Number(feeInfo.fee || 0) * 100) : 0;
  const total_amount = resolved.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0) + deliveryFeeCents;
  conversation.transaction.total_amount = total_amount;

  const items = resolved.map((i) => ({
    name: i.desc_item,
    quantity: i.quantity,
    price: Number((i.unit_price || 0) / 100),
  }));

  return {
    ok: true,
    payload: {
      customer_name: cleanText(tx.customer_name || customer?.name || conversation?.contactName || 'Cliente WhatsApp'),
      customer_phone: conversation.phone,
      source: 'whatsapp',
      type: toAnaFoodType(tx.mode),
      payment_method: toAnaFoodPayment(tx.payment),
      address: tx.address.street_name || '',
      address_number: tx.address.street_number || '',
      neighborhood: tx.address.neighborhood || '',
      city: tx.address.city || '',
      state: tx.address.state || '',
      zip_code: (tx.address.postal_code || '').replace(/\D/g, ''),
      items,
      delivery_fee: Number((deliveryFeeCents || 0) / 100),
      total: Number((total_amount || 0) / 100),
      observations: cleanText(tx.notes || ''),
    }
  };
}

module.exports = {
  addItemToCart,
  removeItem,
  updateQuantity,
  setAddress,
  setPayment,
  findCatalogItem,
  createOrderPayload,
  resolveItemsWithCatalog,
  resolveDeliveryFee,
  toAnaFoodType,
  toAnaFoodPayment,
  cleanText,
  normalizeForMatch,
  tokenizeNormalized,
  canonicalTokens,
  singularizeToken,
  toNumberOrOne,
  isNearToken,
  toReaisAmount,
  detectYes,
  detectNo,
  detectItemsPhaseDone,
  formatBRL,
  normalizePaymentLabel,
  extractPaymentMethodsFromText,
  getAvailablePaymentMethods,
  getCompanyDisplayName,
  normalizeStateUF,
  extractAddressFromText,
  enrichAddressWithCompanyDefaults,
  isNonInformativeFieldValue,
};
