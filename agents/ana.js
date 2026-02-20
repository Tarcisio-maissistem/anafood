'use strict';

const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { loadCompanyData } = require('../lib/company-data-mcp');
const { saveInboundMessage } = require('../lib/supabase-messages');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const BUFFER_WINDOW_MS = Number(process.env.MESSAGE_BUFFER_MS || 1000);
const SESSION_TTL = Number(process.env.CONVERSATION_TTL_MS || 60 * 60 * 1000);
const ACTIVE_FLOW_TTL = Number(process.env.CONVERSATION_ACTIVE_FLOW_TTL_MS || 30 * 60 * 1000);
const WAITING_PAYMENT_TTL = Number(process.env.CONVERSATION_WAITING_PAYMENT_TTL_MS || 15 * 60 * 1000);
const SUMMARY_EVERY_N_MESSAGES = Number(process.env.SUMMARY_EVERY_N_MESSAGES || 8);

const STATES = {
  INIT: 'INIT',
  COLLECTING_DATA: 'COLLECTING_DATA',
  WAITING_CONFIRMATION: 'WAITING_CONFIRMATION',
  WAITING_PAYMENT: 'WAITING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  HUMAN_HANDOFF: 'HUMAN_HANDOFF',
  CLOSED: 'CLOSED',
};

const INTENTS = {
  SAUDACAO: 'SAUDACAO',
  NOVO_PEDIDO: 'NOVO_PEDIDO',
  REPETIR: 'REPETIR',
  CONSULTA: 'CONSULTA',
  GERENCIAMENTO: 'GERENCIAMENTO',
  CANCELAMENTO: 'CANCELAMENTO',
  PAGAMENTO: 'PAGAMENTO',
  SUPORTE: 'SUPORTE',
  HUMANO: 'HUMANO',
  SPAM: 'SPAM',
};

const AGENT_DEFAULTS = {
  bufferWindowMs: BUFFER_WINDOW_MS,
  greetingMessage: process.env.DEFAULT_GREETING_MESSAGE || 'Olá. Posso te ajudar com um pedido ou informação?',
  greetingOncePerDay: true,
};

const customers = new Map();
const conversations = new Map();
const buffers = new Map();
const processing = new Set();
const agentSettings = new Map();
const inboundMessageSeen = new Map();
const followUpTimers = new Map();

const STATE_FILE = process.env.ANA_STATE_FILE
  ? path.resolve(process.env.ANA_STATE_FILE)
  : path.join(__dirname, '..', 'data', 'ana_state.json');

let persistTimer = null;

const nowISO = () => new Date().toISOString();
const cleanText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const toNumberOrOne = (v) => { const n = parseInt(String(v || '').trim(), 10); return Number.isFinite(n) && n > 0 ? n : 1; };
const detectYes = (t) => {
  const x = cleanText(t).toLowerCase();
  if (/^(sim|ok|isso|certo|confirmo|confirmar|fechado|claro|pode|bora|vai|positivo|afirmativo|quero|desejo|pode ser|com certeza|perfeito|exato|exatamente|correto|isso mesmo|tá bom|ta bom|tudo certo|manda|manda sim|quero sim|pode mandar|fechou|topo|combinado|beleza)$/.test(x)) return true;
  if (x.includes('confirm') || x.includes('quero sim') || x.includes('pode sim') || x.includes('claro que sim')) return true;
  return false;
};
const detectNo = (t) => {
  const x = cleanText(t).toLowerCase();
  if (/^(nao|não|negativo|cancelar|cancela|nope|jamais|nunca|dispenso|desisto|para)$/.test(x)) return true;
  if (x.includes('nao quero') || x.includes('não quero') || x.includes('deixa pra la') || x.includes('deixa pra lá') || x.includes('esquece') || x.includes('pode cancelar') || x.includes('cancela') || x.includes('nao obrigado') || x.includes('não obrigado') || x.includes('nao precisa') || x.includes('não precisa') || x.includes('pode parar') || x.includes('nao quero mais') || x.includes('não quero mais')) return true;
  return false;
};
const formatBRL = (n) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return 'R$ 0,00';
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
};
const normalizeForMatch = (v) => String(v || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const tokenizeNormalized = (v) => normalizeForMatch(v).split(' ').filter(Boolean);

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
  const lower = raw.toLowerCase();
  const out = {};

  const streetMatch = raw.match(/\b(rua|av(?:enida)?|alameda|travessa|quadra|qd)\s+([^,]+)/i);
  if (streetMatch) out.street_name = cleanText(`${streetMatch[1]} ${streetMatch[2]}`);

  if (/\b(sem\s*n[uú]mero|s\/n)\b/i.test(raw)) out.street_number = 'S/N';
  const numberMatch = raw.match(/\b(?:n(?:[úu]mero)?|num|casa)\s*[:#-]?\s*([0-9]{1,6}|s\/n)\b/i);
  if (!out.street_number && numberMatch) out.street_number = String(numberMatch[1]).toUpperCase() === 'S/N' ? 'S/N' : cleanText(numberMatch[1]);
  if (!out.street_number && /\b0\b/.test(lower) && /(n[uú]mero|num|casa|sem numero)/i.test(raw)) out.street_number = 'S/N';

  const neighborhoodMatch = raw.match(/\b(?:bairro|setor|jd|jardim|parque)\s+([^,]+)/i);
  if (neighborhoodMatch) {
    out.neighborhood = cleanText(neighborhoodMatch[1]);
  }

  const cityUfSlash = raw.match(/\b([A-Za-zÀ-ÿ\s]+)\s*\/\s*([A-Za-z]{2})\b/);
  if (cityUfSlash) {
    out.city = cleanText(cityUfSlash[1]);
    out.state = normalizeStateUF(cityUfSlash[2]);
  } else {
    const cityUfInline = raw.match(/\b([A-Za-zÀ-ÿ\s]+)\s+([A-Za-z]{2})\b$/);
    if (cityUfInline) {
      out.city = cleanText(cityUfInline[1]);
      out.state = normalizeStateUF(cityUfInline[2]);
    }
  }

  const cep = raw.match(/\b\d{5}-?\d{3}\b|\b\d{8}\b/);
  if (cep) out.postal_code = String(cep[0]).replace(/\D/g, '');

  return out;
}

function enrichAddressWithCompanyDefaults(conversation) {
  const addr = conversation?.transaction?.address || {};
  const companyAddress = cleanText(conversation?.companyData?.company?.address || '');
  if (!companyAddress) return;

  if (!cleanText(addr.city) || !cleanText(addr.state)) {
    const m = companyAddress.match(/\b([A-Za-zÀ-ÿ\s]+)\s*\/\s*([A-Za-z]{2})\b/);
    if (m) {
      if (!cleanText(addr.city)) addr.city = cleanText(m[1]);
      if (!cleanText(addr.state)) addr.state = normalizeStateUF(m[2]);
    }
  }
}

function ensureStateDir() { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); }
function persistStateDebounced() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      ensureStateDir();
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        customers: Array.from(customers.entries()),
        conversations: Array.from(conversations.entries()),
        updatedAt: nowISO(),
      }, null, 2), 'utf8');
    } catch (_) {}
  }, 500);
}
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of (parsed.customers || [])) customers.set(k, v);
    for (const [k, v] of (parsed.conversations || [])) conversations.set(k, v);
  } catch (_) {}
}
loadState();

function tenantRuntime(tenant, runtimeOverrides = {}) {
  const tenantId = tenant?.id || 'default';
  const tenantCustom = tenant?.agent || {};
  const currentSettings = agentSettings.get(tenantId) || {};
  const bufferWindowMs = Number(currentSettings.bufferWindowMs || tenantCustom.bufferWindowMs || AGENT_DEFAULTS.bufferWindowMs);
  const greetingMessage = cleanText(currentSettings.greetingMessage || tenantCustom.greetingMessage || AGENT_DEFAULTS.greetingMessage);
  const restaurantCfg = tenant?.business?.restaurant || {};
  const companyContext = {
    companyName: tenant?.name || 'Empresa',
    address: cleanText(
      restaurantCfg.address
      || restaurantCfg.fullAddress
      || [restaurantCfg.street, restaurantCfg.number, restaurantCfg.neighborhood, restaurantCfg.city]
        .filter(Boolean)
        .join(', ')
    ),
    openingHours: cleanText(
      restaurantCfg.openingHours
      || restaurantCfg.workingHours
      || restaurantCfg.schedule
      || ''
    ),
    menuHint: cleanText(restaurantCfg.menuHint || restaurantCfg.menuDescription || ''),
    supportInfo: cleanText(restaurantCfg.supportInfo || ''),
    paymentInfo: cleanText(restaurantCfg.paymentInfo || ''),
    paymentMethods: Array.isArray(restaurantCfg.paymentMethods) ? restaurantCfg.paymentMethods : [],
    deliveryAreas: Array.isArray(restaurantCfg.deliveryAreas) ? restaurantCfg.deliveryAreas : [],
  };
  return {
    id: tenantId,
    name: tenant?.name || 'Tenant',
    environment: (tenant?.environment || 'homologation').toLowerCase(),
    segment: (tenant?.business?.segment || 'restaurant').toLowerCase(),
    tone: tenant?.agent?.personality || 'simpatica e objetiva',
    agentName: tenant?.agent?.name || 'Ana',
    customPrompt: tenant?.agent?.customPrompt || '',
    model: tenant?.agent?.model || 'gpt-4o-mini',
    temperature: typeof tenant?.agent?.temperature === 'number' ? tenant.agent.temperature : 0.5,
    bufferWindowMs: Number.isFinite(bufferWindowMs) ? Math.max(1000, Math.min(120000, bufferWindowMs)) : AGENT_DEFAULTS.bufferWindowMs,
    greetingMessage: greetingMessage || AGENT_DEFAULTS.greetingMessage,
    greetingOncePerDay: true,
    delivery: { requireAddress: tenant?.business?.restaurant?.requireAddress !== false },
    orderProvider: (tenant?.business?.restaurant?.orderProvider || 'saipos').toLowerCase(),
    companyContext,
    supabase: {
      url: tenant?.integrations?.supabase?.url || process.env.SUPABASE_URL || '',
      serviceRoleKey: tenant?.integrations?.supabase?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      companyId: tenant?.integrations?.supabase?.companyId || process.env.COMPANY_MCP_COMPANY_ID || '',
      companyTable: tenant?.integrations?.supabase?.companyTable || process.env.COMPANY_MCP_COMPANY_TABLE || 'companies',
      companyLookupKey: tenant?.integrations?.supabase?.companyLookupKey || process.env.COMPANY_MCP_COMPANY_LOOKUP_KEY || 'id',
      menuTable: tenant?.integrations?.supabase?.menuTable || process.env.COMPANY_MCP_MENU_TABLE || '',
      paymentTable: tenant?.integrations?.supabase?.paymentTable || process.env.COMPANY_MCP_PAYMENT_TABLE || '',
      deliveryTable: tenant?.integrations?.supabase?.deliveryTable || process.env.COMPANY_MCP_DELIVERY_TABLE || '',
      tenantFilterKey: tenant?.integrations?.supabase?.tenantFilterKey || process.env.COMPANY_MCP_TENANT_FILTER_KEY || 'company_id',
      filterValue: tenant?.integrations?.supabase?.filterValue || process.env.COMPANY_MCP_FILTER_VALUE || '',
    },
    anafood: {
      endpoint: tenant?.integrations?.anafood?.endpoint || process.env.ANAFOOD_API_URL || '',
      authMode: (tenant?.integrations?.anafood?.authMode || process.env.ANAFOOD_AUTH_MODE || 'company_key').toLowerCase(),
      companyKey: tenant?.integrations?.anafood?.companyKey || process.env.ANAFOOD_COMPANY_KEY || '',
      apiToken: tenant?.integrations?.anafood?.apiToken || process.env.ANAFOOD_API_TOKEN || '',
      companyId: tenant?.integrations?.anafood?.companyId || process.env.ANAFOOD_COMPANY_ID || '',
      companyHeader: tenant?.integrations?.anafood?.companyHeader || process.env.ANAFOOD_COMPANY_HEADER || '',
    },
    evolution: {
      apiUrl: tenant?.evolution?.apiUrl || process.env.EVOLUTION_API_URL,
      apiKey: tenant?.evolution?.apiKey || process.env.EVOLUTION_API_KEY,
      instance: runtimeOverrides.instance
        || tenant?.evolution?.instance
        || process.env.EVOLUTION_INSTANCE,
    },
  };
}

function getAgentSettings(tenantId = 'default') {
  const current = agentSettings.get(tenantId) || {};
  return {
    tenantId,
    bufferWindowMs: Number(current.bufferWindowMs || AGENT_DEFAULTS.bufferWindowMs),
    greetingMessage: String(current.greetingMessage || AGENT_DEFAULTS.greetingMessage),
    greetingOncePerDay: true,
  };
}

function setAgentSettings(tenantId = 'default', patch = {}) {
  const current = getAgentSettings(tenantId);
  const next = {
    ...current,
    bufferWindowMs: Math.max(1000, Math.min(120000, Number(patch.bufferWindowMs || current.bufferWindowMs || AGENT_DEFAULTS.bufferWindowMs))),
    greetingMessage: cleanText(String(patch.greetingMessage || current.greetingMessage || AGENT_DEFAULTS.greetingMessage)),
    greetingOncePerDay: true,
  };
  agentSettings.set(tenantId, next);
  return next;
}

function getCustomer(tenantId, phone) {
  const key = `${tenantId}:${phone}`;
  let c = customers.get(key);
  if (!c) {
    c = {
      id: key,
      tenantId,
      phone,
      name: '',
      createdAt: nowISO(),
      updatedAt: nowISO(),
      totalOrders: 0,
      lastOrderSnapshot: null,
      lastOrderSummary: '',
    };
    customers.set(key, c);
  }
  if (typeof c.totalOrders !== 'number') c.totalOrders = 0;
  if (typeof c.name !== 'string') c.name = '';
  if (typeof c.lastOrderSummary !== 'string') c.lastOrderSummary = '';
  if (typeof c.lastOrderSnapshot === 'undefined') c.lastOrderSnapshot = null;
  c.updatedAt = nowISO();
  return c;
}

function getConversation(phone, tenantId = 'default') {
  const key = `${tenantId}:${phone}`;
  const buildConversation = () => ({
    id: key,
    tenantId,
    phone,
    state: STATES.INIT,
    stateUpdatedAt: nowISO(),
    createdAt: nowISO(),
    lastActivityAt: nowISO(),
    contextSummary: '',
    messageCount: 0,
    consecutiveFailures: 0,
    handoffNotified: false,
    transaction: {
      mode: '',
      customer_name: '',
      items: [],
      notes: '',
      address: { street_name: '', street_number: '', neighborhood: '', city: '', state: '', postal_code: '' },
      payment: '',
      total_amount: 0,
      order_id: null,
    },
    confirmed: {},
    pendingFieldConfirmation: null,
    awaitingRepeatChoice: false,
    lastRepeatOfferDate: '',
    repeatPreview: '',
    orderStoredForCustomer: false,
    greeted: false,
    messages: [],
    catalog: null,
  });

  let conv = conversations.get(key);
  const now = Date.now();
  const inactivityMs = conv ? (now - new Date(conv.lastActivityAt || conv.createdAt || nowISO()).getTime()) : 0;
  const shouldResetByState = conv
    && (
      (conv.state === STATES.WAITING_PAYMENT && inactivityMs > WAITING_PAYMENT_TTL)
      || (conv.state !== STATES.INIT && inactivityMs > ACTIVE_FLOW_TTL)
    );
  if (!conv || inactivityMs > SESSION_TTL || shouldResetByState) {
    conv = buildConversation();
    conversations.set(key, conv);
  }
  if (!conv.confirmed || typeof conv.confirmed !== 'object') conv.confirmed = {};
  if (!conv.stateUpdatedAt) conv.stateUpdatedAt = nowISO();
  if (typeof conv.pendingFieldConfirmation === 'undefined') conv.pendingFieldConfirmation = null;
  if (typeof conv.awaitingRepeatChoice !== 'boolean') conv.awaitingRepeatChoice = false;
  if (typeof conv.lastRepeatOfferDate !== 'string') conv.lastRepeatOfferDate = '';
  if (typeof conv.repeatPreview !== 'string') conv.repeatPreview = '';
  if (typeof conv.orderStoredForCustomer !== 'boolean') conv.orderStoredForCustomer = false;
  conv.lastActivityAt = nowISO();
  return conv;
}

function appendMessage(conv, role, content, metadata = {}) {
  conv.messages.push({ role, content, metadata, at: nowISO() });
  if (conv.messages.length > 30) conv.messages = conv.messages.slice(-30);
  conv.messageCount = (conv.messageCount || 0) + 1;
  conv.lastActivityAt = nowISO();
}

function normalizeCatalog(rawCatalog) {
  const list = Array.isArray(rawCatalog) ? rawCatalog : (rawCatalog.items || rawCatalog.products || []);
  const seen = new Set();
  const items = [];
  for (const item of list) {
    const code = item.integration_code || item.codigo_interno || item.codigo_saipos || String(item.id_store_item);
    if (seen.has(code)) continue;
    seen.add(code);
    const price = parseFloat(item.price || item.unit_price || 0);
    items.push({ integration_code: String(code), name: item.item || item.desc_item || item.name || 'Item', unit_price: Math.round(price * 100), price_display: `R$ ${price.toFixed(2)}` });
  }
  return items;
}

function normalizeCatalogFromCompanyMenu(menuRows) {
  const list = Array.isArray(menuRows) ? menuRows : [];
  const seen = new Set();
  const items = [];
  for (const row of list) {
    const name = cleanText(row?.name || row?.item || row?.desc_item || '');
    if (!name) continue;
    const code = cleanText(
      row?.integration_code
      || row?.codigo_saipos
      || row?.cod_item
      || row?.code
      || row?.external_code
      || row?.id_store_item
      || row?.id
      || name
    );
    if (seen.has(code)) continue;
    seen.add(code);
    const unitPriceFromRow = Number(row?.unit_price || 0);
    const unitPrice = Number.isFinite(unitPriceFromRow) && unitPriceFromRow > 0
      ? Math.round(unitPriceFromRow)
      : Math.round((Number(row?.price || row?.valor || 0) || 0) * 100);
    items.push({
      integration_code: String(code),
      name,
      unit_price: unitPrice,
      price_display: `R$ ${(unitPrice / 100).toFixed(2)}`,
    });
  }
  return items;
}

function inferItemsFromMenu(message, menuRows) {
  const text = normalizeForMatch(message);
  if (!text || !Array.isArray(menuRows) || !menuRows.length) return [];
  const qtyWords = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5 };
  const chunks = text.split(/\s+e\s+|,/g).map((s) => s.trim()).filter(Boolean);
  const results = [];
  const used = new Set();

  for (let chunk of chunks) {
    const qtyMatch = chunk.match(/\b(\d+|um|uma|dois|duas|tres|quatro|cinco)\b/);
    const qtyRaw = qtyMatch ? qtyMatch[1] : '';
    const quantity = qtyRaw ? (Number(qtyRaw) || qtyWords[qtyRaw] || 1) : 1;
    chunk = chunk
      .replace(/\b(quero|gostaria|pedido|me ve|me vê|pra|para|de|do|da|uma|um|duas|dois|tres|quatro|cinco|\d+)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!chunk) continue;

    let best = null;
    let bestScore = 0;
    for (const item of menuRows) {
      const name = normalizeForMatch(item?.name);
      if (!name) continue;
      const chunkInName = name.includes(chunk);
      const nameInChunk = chunk.includes(name);
      if (!chunkInName && !nameInChunk) continue;
      const score = Math.min(name.length, chunk.length);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    if (!best) continue;
    const key = normalizeForMatch(best.name);
    if (used.has(key)) continue;
    used.add(key);
    results.push({ name: cleanText(best.name), quantity: Math.max(1, quantity) });
  }
  return results;
}

function extractItemsFromFreeText(text) {
  const raw = cleanText(text);
  if (!raw) return [];
  const qtyWords = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5 };
  const chunks = raw
    .split(/\s*(?:,|;|\s+e\s+)\s*/i)
    .map((s) => cleanText(s))
    .filter(Boolean);
  const items = [];

  for (let chunk of chunks) {
    if (/^(oi|ola|olá|bom dia|boa tarde|boa noite)$/i.test(chunk)) continue;
    if (/\b(rua|av(?:enida)?|bairro|cep|numero|n[úu]mero|pix|cart[aã]o|retirada|delivery)\b/i.test(chunk)) continue;
    if (/\b(horario|horário|funcionamento|endereco|endereço|taxa|taxas|cardapio|cardápio|preço|preco|quanto custa|quanto fica|como funciona|qual é|qual e|quais s[aã]o|informacao|informação)\b/i.test(chunk)) continue;

    let quantity = 1;
    const qtyPrefix = chunk.match(/^\s*(\d+|um|uma|dois|duas|tres|quatro|cinco)\b/i);
    if (qtyPrefix) {
      const q = qtyPrefix[1].toLowerCase();
      quantity = Number(q) || qtyWords[q] || 1;
      chunk = cleanText(chunk.slice(qtyPrefix[0].length));
    } else {
      const qtyInline = chunk.match(/\b(\d+)\s*x\b/i);
      if (qtyInline) {
        quantity = Math.max(1, Number(qtyInline[1]) || 1);
        chunk = cleanText(chunk.replace(/\b\d+\s*x\b/i, ' '));
      }
    }

    const cleanedName = cleanText(
      chunk
        .replace(/^(quero|gostaria(?:\s+de)?|pedido|me\s+ve|me\s+v[eê]|me\s+manda)\s+/i, '')
        .replace(/\b(para|pra)\s+(entrega|delivery|retirada|retirar)\b/gi, '')
        .replace(/\b(no|na)\s+(pix|dinheiro|cart[aã]o|cartao|credito|d[eé]bito|debito)\b/gi, '')
        .replace(/\s+/g, ' ')
    );

    if (!cleanedName || cleanedName.length < 2) continue;
    items.push({ name: cleanedName, quantity: Math.max(1, quantity) });
  }

  const merged = new Map();
  for (const item of items) {
    const key = normalizeForMatch(item.name);
    const prev = merged.get(key);
    if (prev) prev.quantity += toNumberOrOne(item.quantity);
    else merged.set(key, { name: cleanText(item.name), quantity: toNumberOrOne(item.quantity) });
  }
  return Array.from(merged.values());
}

async function normalizeMessageBlock({ rawText, rawMessage }) {
  const baseText = cleanText(rawText);
  const hasAudio = Boolean(rawMessage?.audioMessage || rawMessage?.pttMessage || rawMessage?.voiceMessage);
  if (!hasAudio) return { normalizedText: baseText, sourceType: 'text', originalText: rawText, transcription: null };

  const audioBase64 = rawMessage?.audioMessage?.base64 || rawMessage?.audioBase64 || null;
  if (!audioBase64 || !openai) {
    return { normalizedText: baseText, sourceType: 'audio', originalText: rawText, transcription: null };
  }
  try {
    const mime = rawMessage?.audioMessage?.mimetype || 'audio/ogg';
    const file = new File([Buffer.from(audioBase64, 'base64')], 'audio.ogg', { type: mime });
    const tr = await openai.audio.transcriptions.create({ file, model: 'gpt-4o-mini-transcribe' });
    const transcription = cleanText(tr?.text || '');
    return { normalizedText: transcription || baseText, sourceType: 'audio', originalText: rawText, transcription: transcription || null };
  } catch (_) {
    return { normalizedText: baseText, sourceType: 'audio', originalText: rawText, transcription: null };
  }
}

async function classifierAgent({ runtime, conversation, groupedText }) {
  const lower = groupedText.toLowerCase();
  if (/atendente|humano|pessoa/.test(lower)) return { intent: INTENTS.HUMANO, requires_extraction: false, handoff: true, confidence: 1 };
  if (/\b(horario|funcionamento|endereco|endereço|pagamento|formas de pagamento|valor|pre[cç]o|card[aá]pio|cardapio|menu)\b/.test(lower)) {
    return { intent: INTENTS.CONSULTA, requires_extraction: false, handoff: false, confidence: 0.95 };
  }
  const hasOrderSignal = /quero|pedido|comprar|marmita|pizza|lanche|agendar|marcar/.test(lower);
  const hasGreetingSignal = /oi|ola|olá|bom dia|boa tarde|boa noite/.test(lower);
  if (hasOrderSignal) return { intent: INTENTS.NOVO_PEDIDO, requires_extraction: true, handoff: false, confidence: hasGreetingSignal ? 0.9 : 0.8 };
  if (hasGreetingSignal) return { intent: INTENTS.SAUDACAO, requires_extraction: false, handoff: false, confidence: 0.8 };
  if (/pix|cartao|cartão|paguei|pagamento/.test(lower)) return { intent: INTENTS.PAGAMENTO, requires_extraction: true, handoff: false, confidence: 0.7 };
  if (/cancel/.test(lower)) return { intent: INTENTS.CANCELAMENTO, requires_extraction: false, handoff: false, confidence: 0.7 };

  if (!openai) {
    return { intent: INTENTS.CONSULTA, requires_extraction: false, handoff: false, confidence: 0.5 };
  }
  try {
    const c = await openai.chat.completions.create({
      model: runtime.model,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: 'Classifique a intencao e retorne somente JSON com intent,requires_extraction,handoff,confidence.' },
        { role: 'user', content: JSON.stringify({ state: conversation.state, segment: runtime.segment, summary: conversation.contextSummary, message: groupedText }) },
      ],
    });
    const p = JSON.parse(c.choices?.[0]?.message?.content || '{}');
    const intent = INTENTS[p.intent] ? p.intent : INTENTS.CONSULTA;
    return { intent, requires_extraction: Boolean(p.requires_extraction), handoff: Boolean(p.handoff), confidence: Number(p.confidence || 0.5) };
  } catch (_) {
    return { intent: INTENTS.CONSULTA, requires_extraction: false, handoff: false, confidence: 0.5 };
  }
}

async function extractorAgent({ runtime, groupedText }) {
  if (runtime.segment === 'clinic') {
    const date = groupedText.match(/\b\d{4}-\d{2}-\d{2}\b|\b\d{2}\/\d{2}\/\d{4}\b/);
    const hour = groupedText.match(/\b\d{1,2}:\d{2}\b/);
    return { service: cleanText(groupedText), date: date ? date[0] : null, time: hour ? hour[0] : null };
  }

  const lower = groupedText.toLowerCase();
  const out = {
    mode: /retirada|retirar|balcao/.test(lower) ? 'TAKEOUT' : (/entrega|delivery/.test(lower) ? 'DELIVERY' : null),
    payment: /pix/.test(lower) ? 'PIX'
      : (/(cartao|cartão|cr[eé]dito|d[eé]bito)/.test(lower) ? 'CARD'
      : (/dinheiro|especie|espécie|cash|nota/.test(lower) ? 'CASH' : null)),
    customer_name: null,
    notes: null,
    items: [],
    address: {},
  };

  const nameMatch = groupedText.match(/(?:meu nome (?:é|e)|sou|chamo-me|me chamo)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,60})/i);
  if (nameMatch) out.customer_name = cleanText(nameMatch[1]);
  if (/sem observa|sem complemento|sem adicional/i.test(lower)) out.notes = 'Sem observacoes';
  const obsMatch = groupedText.match(/(?:obs|observa(?:ç|c)[aã]o|complemento)\s*[:\-]\s*(.{3,200})/i);
  if (obsMatch) out.notes = cleanText(obsMatch[1]);

  Object.assign(out.address, extractAddressFromText(groupedText));
  out.items = extractItemsFromFreeText(groupedText);

  return out;
}

function markFieldChanged(conv, field) {
  conv.confirmed[field] = false;
}

function mergeRestaurantTransaction(conv, extracted) {
  if (extracted.customer_name) {
    const next = cleanText(extracted.customer_name);
    if (next && next !== cleanText(conv.transaction.customer_name)) {
      conv.transaction.customer_name = next;
      markFieldChanged(conv, 'customer_name');
    }
  }
  if (typeof extracted.notes === 'string' && extracted.notes) {
    const next = cleanText(extracted.notes);
    if (next && next !== cleanText(conv.transaction.notes)) {
      conv.transaction.notes = next;
      markFieldChanged(conv, 'notes');
    }
  }
  if (extracted.mode && extracted.mode !== conv.transaction.mode) {
    conv.transaction.mode = extracted.mode;
    markFieldChanged(conv, 'mode');
  }
  if (extracted.payment && extracted.payment !== conv.transaction.payment) {
    conv.transaction.payment = extracted.payment;
    markFieldChanged(conv, 'payment');
  }

  if (Array.isArray(extracted.items)) {
    let changed = false;
    for (const item of extracted.items) {
      const name = cleanText(item.name || item.nome || '');
      if (!name) continue;
      const existing = conv.transaction.items.find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        const before = Number(existing.quantity || 0);
        existing.quantity += toNumberOrOne(item.quantity);
        if (Number(existing.quantity || 0) !== before) changed = true;
      } else {
        conv.transaction.items.push({ name, quantity: toNumberOrOne(item.quantity), integration_code: null, unit_price: null });
        changed = true;
      }
    }
    if (changed) markFieldChanged(conv, 'items');
  }

  if (extracted.address && typeof extracted.address === 'object') {
    for (const [k, v] of Object.entries(extracted.address)) {
      const next = cleanText(v);
      if (!next) continue;
      if (cleanText(conv.transaction.address?.[k]) !== next) {
        conv.transaction.address[k] = next;
        markFieldChanged(conv, `address.${k}`);
      }
    }
  }
}

function restaurantMissingFields(runtime, tx, confirmed = {}) {
  const missing = [];
  if (!Array.isArray(tx.items) || tx.items.length === 0) missing.push('items');
  if (Array.isArray(tx.items) && tx.items.some((i) => !Number(i.quantity) || Number(i.quantity) <= 0)) missing.push('items');
  if (!tx.mode) missing.push('mode');
  if (tx.mode === 'DELIVERY' && runtime.delivery.requireAddress) {
    for (const f of ['street_name', 'street_number', 'neighborhood']) {
      if (!cleanText(tx.address?.[f])) missing.push(`address.${f}`);
    }
  }
  if (!tx.payment) missing.push('payment');
  return missing;
}

function clearTransactionField(tx, field) {
  if (field === 'customer_name') tx.customer_name = '';
  else if (field === 'notes') tx.notes = '';
  else if (field === 'mode') tx.mode = '';
  else if (field === 'payment') tx.payment = '';
  else if (field === 'items') tx.items = [];
  else if (field.startsWith('address.')) {
    const addrKey = field.slice('address.'.length);
    if (addrKey) tx.address[addrKey] = '';
  }
}

function fieldConfirmationLabel(field) {
  const labels = {
    customer_name: 'nome',
    items: 'itens do pedido',
    notes: 'observacoes do pedido',
    mode: 'tipo de entrega',
    payment: 'forma de pagamento',
    'address.street_name': 'rua',
    'address.street_number': 'numero',
    'address.neighborhood': 'bairro',
    'address.city': 'cidade',
    'address.state': 'estado',
    'address.postal_code': 'CEP',
  };
  return labels[field] || field;
}

function fieldConfirmationValue(tx, field) {
  if (field === 'customer_name') return tx.customer_name || '-';
  if (field === 'notes') return tx.notes || '-';
  if (field === 'mode') return tx.mode === 'TAKEOUT' ? 'retirada' : 'delivery';
  if (field === 'payment') return tx.payment === 'PIX' ? 'PIX' : (tx.payment === 'CARD' ? 'cartao' : (tx.payment || '-'));
  if (field === 'items') return (tx.items || []).map((i) => `${i.quantity}x ${i.name}`).join(', ') || '-';
  if (field.startsWith('address.')) {
    const addrKey = field.slice('address.'.length);
    return tx.address?.[addrKey] || '-';
  }
  return '-';
}

function buildOrderSnapshot(tx) {
  return {
    customer_name: cleanText(tx.customer_name || ''),
    mode: tx.mode || '',
    notes: cleanText(tx.notes || ''),
    payment: tx.payment || '',
    items: Array.isArray(tx.items) ? tx.items.map((i) => ({
      name: cleanText(i.name || ''),
      quantity: toNumberOrOne(i.quantity),
      integration_code: i.integration_code || null,
      unit_price: Number(i.unit_price || 0) || null,
    })).filter((i) => i.name) : [],
    address: {
      street_name: cleanText(tx.address?.street_name || ''),
      street_number: cleanText(tx.address?.street_number || ''),
      neighborhood: cleanText(tx.address?.neighborhood || ''),
      city: cleanText(tx.address?.city || ''),
      state: cleanText(tx.address?.state || ''),
      postal_code: cleanText(tx.address?.postal_code || ''),
    },
  };
}

function formatOrderPreview(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.items.length === 0) return '';
  const items = snapshot.items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
  const mode = snapshot.mode === 'TAKEOUT' ? 'Retirada' : 'Delivery';
  return `${items} | ${mode} | Pagamento: ${snapshot.payment || '-'}`;
}

function applySnapshotToConversation(conversation, snapshot) {
  if (!snapshot) return;
  conversation.transaction.customer_name = cleanText(snapshot.customer_name || '');
  conversation.transaction.mode = snapshot.mode || '';
  conversation.transaction.notes = cleanText(snapshot.notes || '');
  conversation.transaction.payment = snapshot.payment || '';
  conversation.transaction.items = Array.isArray(snapshot.items)
    ? snapshot.items.map((i) => ({
      name: cleanText(i.name || ''),
      quantity: toNumberOrOne(i.quantity),
      integration_code: i.integration_code || null,
      unit_price: Number(i.unit_price || 0) || null,
    })).filter((i) => i.name)
    : [];
  conversation.transaction.address = {
    street_name: cleanText(snapshot.address?.street_name || ''),
    street_number: cleanText(snapshot.address?.street_number || ''),
    neighborhood: cleanText(snapshot.address?.neighborhood || ''),
    city: cleanText(snapshot.address?.city || ''),
    state: cleanText(snapshot.address?.state || ''),
    postal_code: cleanText(snapshot.address?.postal_code || ''),
  };
  const allConfirmed = {
    customer_name: true,
    items: true,
    notes: true,
    mode: true,
    payment: true,
    'address.street_name': true,
    'address.street_number': true,
    'address.neighborhood': true,
    'address.city': true,
    'address.state': true,
    'address.postal_code': true,
  };
  conversation.confirmed = allConfirmed;
  conversation.pendingFieldConfirmation = null;
}

function orchestrate({ runtime, conversation, customer, classification, extracted, groupedText }) {
  if (runtime.segment === 'restaurant') {
    // Don't add items from consultation messages – avoids sentences like "Qual o horário?" becoming order items
    const mergeExtracted = (classification.intent === INTENTS.CONSULTA)
      ? { ...extracted, items: [] }
      : (extracted || {});
    mergeRestaurantTransaction(conversation, mergeExtracted);
  }
  if (runtime.segment === 'restaurant') enrichAddressWithCompanyDefaults(conversation);
  if (runtime.segment === 'restaurant') conversation.pendingFieldConfirmation = null;

  const handoff = classification.handoff
    || classification.intent === INTENTS.HUMANO
    || Number(classification.confidence || 0) < 0.45
    || /(raiva|horrivel|horrible|péssimo|pessimo|absurdo|ridículo|ridiculo|lamentável|lamentavel|inacreditável|inacreditavel|vergonha|uma merda|tô bravo|to bravo|tô com raiva|to com raiva|que saco|tô puto|to puto|não acredito|nao acredito|péssimo atendimento|pessimo atendimento)/i.test(groupedText)
    || (conversation.consecutiveFailures || 0) >= 3;

  if (handoff) return { nextState: STATES.HUMAN_HANDOFF, action: 'HUMAN_HANDOFF', missing: [] };

  const s = conversation.state;
  const i = classification.intent;
  const yes = detectYes(groupedText);
  const no = detectNo(groupedText);
  const hasQuestion = /\?/.test(groupedText) || /\b(qual|quando|como|onde|que horas|card[aá]pio|pre[cç]o)\b/i.test(groupedText);

  if (runtime.segment === 'clinic') {
    if (s === STATES.INIT && i === INTENTS.NOVO_PEDIDO) return { nextState: STATES.COLLECTING_DATA, action: 'CLINIC_COLLECT', missing: ['service', 'date', 'time'] };
    if (s === STATES.WAITING_CONFIRMATION && yes) return { nextState: STATES.CONFIRMED, action: 'CLINIC_CONFIRMED', missing: [] };
    if (s === STATES.WAITING_CONFIRMATION && no) return { nextState: STATES.COLLECTING_DATA, action: 'REQUEST_ADJUSTMENTS', missing: [] };
    return { nextState: s, action: s === STATES.INIT ? 'WELCOME' : 'ASK_MISSING_FIELDS', missing: ['service', 'date', 'time'] };
  }

  if (s === STATES.INIT) {
    const today = nowISO().slice(0, 10);
    const hasPreviousOrder = Boolean(customer?.lastOrderSnapshot && Array.isArray(customer.lastOrderSnapshot.items) && customer.lastOrderSnapshot.items.length);

    if (conversation.awaitingRepeatChoice && hasPreviousOrder) {
      if (yes) {
        applySnapshotToConversation(conversation, customer.lastOrderSnapshot);
        conversation.awaitingRepeatChoice = false;
        return { nextState: STATES.WAITING_CONFIRMATION, action: 'ORDER_REVIEW', missing: [] };
      }
      if (no) {
        conversation.awaitingRepeatChoice = false;
        conversation.repeatPreview = '';
      } else {
        return {
          nextState: STATES.INIT,
          action: hasQuestion ? 'ANSWER_AND_RESUME_REPEAT' : 'ASK_REPEAT_LAST_ORDER',
          missing: [],
        };
      }
    }

    if (hasPreviousOrder && conversation.lastRepeatOfferDate !== today) {
      conversation.lastRepeatOfferDate = today;
      conversation.awaitingRepeatChoice = true;
      conversation.repeatPreview = customer.lastOrderSummary || formatOrderPreview(customer.lastOrderSnapshot);
      return { nextState: STATES.INIT, action: 'ASK_REPEAT_LAST_ORDER', missing: [] };
    }

    if (i === INTENTS.SAUDACAO) {
      if (runtime.greetingOncePerDay && conversation.lastGreetingDate === today) {
        if (conversation.pendingFieldConfirmation) {
          return {
            nextState: STATES.COLLECTING_DATA,
            action: hasQuestion ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION',
            missing: [conversation.pendingFieldConfirmation],
          };
        }
        const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed);
        return { nextState: STATES.COLLECTING_DATA, action: 'ASK_MISSING_FIELDS', missing };
      }
      conversation.lastGreetingDate = today;
      const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed);
      return { nextState: STATES.COLLECTING_DATA, action: 'WELCOME', missing };
    }
    if (i === INTENTS.NOVO_PEDIDO) {
      const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed);
      return missing.length ? { nextState: STATES.COLLECTING_DATA, action: 'ASK_MISSING_FIELDS', missing } : { nextState: STATES.WAITING_CONFIRMATION, action: 'ORDER_REVIEW', missing: [] };
    }
    if (i === INTENTS.SPAM) return { nextState: STATES.CLOSED, action: 'END_CONVERSATION', missing: [] };
    if (conversation.pendingFieldConfirmation) {
      return {
        nextState: STATES.COLLECTING_DATA,
        action: hasQuestion ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION',
        missing: [conversation.pendingFieldConfirmation],
      };
    }
    const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed);
    return { nextState: STATES.COLLECTING_DATA, action: hasQuestion ? 'ANSWER_AND_RESUME' : 'ASK_MISSING_FIELDS', missing };
  }

  if (s === STATES.COLLECTING_DATA) {
    if (i === INTENTS.CANCELAMENTO) {
      conversation.transaction = { mode: '', customer_name: '', items: [], notes: '', address: { street_name: '', street_number: '', neighborhood: '', city: '', state: '', postal_code: '' }, payment: '', total_amount: 0, order_id: null };
      conversation.confirmed = {};
      conversation.pendingFieldConfirmation = null;
      conversation.upsellDone = false;
      return { nextState: STATES.INIT, action: 'FLOW_CANCELLED', missing: [] };
    }
    if (conversation.pendingFieldConfirmation) {
      const field = conversation.pendingFieldConfirmation;
      if (yes) {
        conversation.confirmed[field] = true;
        conversation.pendingFieldConfirmation = null;
      } else if (no) {
        clearTransactionField(conversation.transaction, field);
        conversation.confirmed[field] = false;
        conversation.pendingFieldConfirmation = null;
        return { nextState: STATES.COLLECTING_DATA, action: 'ASK_MISSING_FIELDS', missing: [field] };
      } else {
        return { nextState: STATES.COLLECTING_DATA, action: hasQuestion ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION', missing: [field] };
      }
    }

    const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed);

    // UPSELL: After items are set, suggest extras before collecting logistics (once per order)
    const hasItems = Array.isArray(conversation.transaction.items) && conversation.transaction.items.length > 0;
    if (
      hasItems &&
      missing.length &&
      !missing.includes('items') &&       // items already filled
      !conversation.upsellDone &&          // haven't upsold yet
      i !== INTENTS.CANCELAMENTO &&
      !yes && !no                          // not a confirmation response
    ) {
      conversation.upsellDone = true;
      return { nextState: STATES.COLLECTING_DATA, action: 'UPSELL_SUGGEST', missing };
    }

    if (missing.length && !conversation.pendingFieldConfirmation) {
      const firstMissing = missing[0];
      const hasValueForField = firstMissing === 'items'
        ? Array.isArray(conversation.transaction.items) && conversation.transaction.items.length > 0
        : firstMissing.startsWith('address.')
          ? Boolean(cleanText(conversation.transaction.address?.[firstMissing.slice('address.'.length)]))
          : Boolean(cleanText(conversation.transaction[firstMissing]));
      if (hasValueForField) conversation.pendingFieldConfirmation = firstMissing;
    }
    if (conversation.pendingFieldConfirmation) {
      return {
        nextState: STATES.COLLECTING_DATA,
        action: (i === INTENTS.CONSULTA || hasQuestion) ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION',
        missing: [conversation.pendingFieldConfirmation],
      };
    }
    return missing.length
      ? { nextState: STATES.COLLECTING_DATA, action: (i === INTENTS.CONSULTA || hasQuestion) ? 'ANSWER_AND_RESUME' : 'ASK_MISSING_FIELDS', missing }
      : { nextState: STATES.WAITING_CONFIRMATION, action: 'ORDER_REVIEW', missing: [] };
  }

  if (s === STATES.WAITING_CONFIRMATION) {
    if (no || i === INTENTS.CANCELAMENTO) return { nextState: STATES.COLLECTING_DATA, action: 'REQUEST_ADJUSTMENTS', missing: [] };
    if (yes) return conversation.transaction.payment === 'PIX'
      ? { nextState: STATES.WAITING_PAYMENT, action: 'CREATE_ORDER_AND_WAIT_PAYMENT', missing: [] }
      : { nextState: STATES.CONFIRMED, action: 'CREATE_ORDER_AND_CONFIRM', missing: [] };
    // Consultation question while waiting confirmation: answer then re-ask
    if (i === INTENTS.CONSULTA || hasQuestion) return { nextState: STATES.WAITING_CONFIRMATION, action: 'ANSWER_AND_CONFIRM', missing: [] };
    return { nextState: STATES.WAITING_CONFIRMATION, action: 'ASK_CONFIRMATION', missing: [] };
  }

  if (s === STATES.WAITING_PAYMENT) {
    if (i === INTENTS.PAGAMENTO || yes || /paguei|comprovante|pago/.test(groupedText.toLowerCase())) return { nextState: STATES.CONFIRMED, action: 'PAYMENT_CONFIRMED', missing: [] };
    if (i === INTENTS.CANCELAMENTO) return { nextState: STATES.COLLECTING_DATA, action: 'REQUEST_ADJUSTMENTS', missing: [] };
    return { nextState: STATES.WAITING_PAYMENT, action: 'PAYMENT_REMINDER', missing: [] };
  }

  if (s === STATES.CONFIRMED) {
    if (i === INTENTS.NOVO_PEDIDO) return { nextState: STATES.CONFIRMED, action: 'BLOCK_NEW_ORDER_UNTIL_FINISH', missing: [] };
    return { nextState: STATES.CONFIRMED, action: 'POST_CONFIRMATION_SUPPORT', missing: [] };
  }

  return { nextState: s, action: 'CLARIFY', missing: [] };
}

function clearFollowUpTimers(key) {
  const existing = followUpTimers.get(key);
  if (existing) {
    if (existing.warningTimer) clearTimeout(existing.warningTimer);
    if (existing.cancelTimer) clearTimeout(existing.cancelTimer);
    followUpTimers.delete(key);
  }
}

function scheduleFollowUp(conv, evolutionConfig) {
  const key = conv.id;
  clearFollowUpTimers(key);

  const activeStates = [STATES.COLLECTING_DATA, STATES.WAITING_CONFIRMATION, STATES.WAITING_PAYMENT];
  if (!activeStates.includes(conv.state)) return;

  const phone = conv.phone;
  const remoteJid = conv.remoteJid || null;
  const minimalRuntime = { evolution: { ...evolutionConfig } };

  const warningTimer = setTimeout(async () => {
    try {
      const current = conversations.get(key);
      if (!current || !activeStates.includes(current.state)) return;
      const name = cleanText(current.transaction?.customer_name || '').split(' ')[0] || '';
      const msg = name
        ? `${name}, ainda está por aí? Posso continuar com seu pedido 😊`
        : 'Ainda está por aí? Posso continuar com seu pedido 😊';
      await sendWhatsAppMessage(phone, msg, minimalRuntime, remoteJid);
      appendMessage(current, 'assistant', msg, { action: 'FOLLOWUP_WARNING' });
      persistStateDebounced();
    } catch (_) {}
  }, 5 * 60 * 1000);

  const cancelTimer = setTimeout(async () => {
    try {
      const current = conversations.get(key);
      if (!current || !activeStates.includes(current.state)) return;
      const name = cleanText(current.transaction?.customer_name || '').split(' ')[0] || '';
      const msg = name
        ? `${name}, como não tivemos resposta, cancelei o pedido em andamento. Quando quiser voltar é só me chamar 😊`
        : 'Como não tivemos resposta por um tempo, cancelei o pedido. Quando quiser é só me chamar 😊';
      await sendWhatsAppMessage(phone, msg, minimalRuntime, remoteJid);
      appendMessage(current, 'assistant', msg, { action: 'FOLLOWUP_CANCEL' });
      current.state = STATES.INIT;
      current.stateUpdatedAt = nowISO();
      current.transaction = {
        mode: '', customer_name: '', items: [], notes: '',
        address: { street_name: '', street_number: '', neighborhood: '', city: '', state: '', postal_code: '' },
        payment: '', total_amount: 0, order_id: null,
      };
      current.confirmed = {};
      current.pendingFieldConfirmation = null;
      followUpTimers.delete(key);
      persistStateDebounced();
    } catch (_) {}
  }, 30 * 60 * 1000);

  followUpTimers.set(key, { warningTimer, cancelTimer });
}

async function maybeLoadCatalog(conversation, runtime, apiRequest, getEnvConfig, log) {
  if (runtime.segment !== 'restaurant') return [];
  if (Array.isArray(conversation.catalog) && conversation.catalog.length) return conversation.catalog;
  const mcpMenu = Array.isArray(conversation?.companyData?.menu) ? conversation.companyData.menu : [];
  conversation.catalog = normalizeCatalogFromCompanyMenu(mcpMenu);
  log('INFO', `Ana: catalogo carregado do Supabase/products (${conversation.catalog.length} itens)`, {
    tenantId: runtime.id,
    phone: conversation.phone,
    source: conversation?.companyData?.meta?.menuSource || 'supabase',
  });
  return conversation.catalog;
}

function resolveItemsWithCatalog(items, catalog) {
  const normalizedCatalog = (catalog || []).map((item) => ({
    raw: item,
    normalized: normalizeForMatch(item?.name || ''),
    tokens: tokenizeNormalized(item?.name || ''),
  })).filter((i) => i.normalized);

  const findBestCatalogMatch = (rawName) => {
    const target = normalizeForMatch(rawName);
    if (!target) return null;
    const targetTokens = tokenizeNormalized(target);
    const targetSet = new Set(targetTokens);
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
        if (ratio >= 0.6) score = 500 + Math.round(ratio * 100);
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

function normalizeExtractedItemsWithCatalog(items, catalog) {
  const { resolved } = resolveItemsWithCatalog(items || [], catalog || []);
  const merged = new Map();

  for (const resolvedItem of resolved) {
    const key = normalizeForMatch(resolvedItem.desc_item);
    const current = merged.get(key);
    if (current) current.quantity += toNumberOrOne(resolvedItem.quantity);
    else {
      merged.set(key, {
        name: cleanText(resolvedItem.desc_item),
        quantity: toNumberOrOne(resolvedItem.quantity),
        integration_code: String(resolvedItem.integration_code || ''),
        unit_price: Number(resolvedItem.unit_price || 0) || null,
      });
    }
  }

  for (const rawItem of (items || [])) {
    const name = cleanText(rawItem?.name || rawItem?.nome || '');
    if (!name) continue;
    const key = normalizeForMatch(name);
    if (merged.has(key)) continue;
    merged.set(key, { name, quantity: toNumberOrOne(rawItem.quantity), integration_code: null, unit_price: null });
  }

  return Array.from(merged.values());
}

function hasExtractedField(extracted, field) {
  if (!extracted || !field) return false;
  if (field === 'items') return Array.isArray(extracted.items) && extracted.items.length > 0;
  if (field.startsWith('address.')) {
    const key = field.slice('address.'.length);
    return Boolean(cleanText(extracted.address?.[key]));
  }
  return Boolean(cleanText(extracted[field]));
}

function forceFillPendingField({ conversation, runtime, groupedText, extracted }) {
  if (runtime.segment !== 'restaurant') return;
  const pendingField = conversation.pendingFieldConfirmation || restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed)[0];
  if (!pendingField || hasExtractedField(extracted, pendingField)) return;

  const text = cleanText(groupedText);
  if (!text || text.includes('?')) return;
  if (!extracted.address || typeof extracted.address !== 'object') extracted.address = {};

  if (pendingField === 'items') {
    const items = extractItemsFromFreeText(text);
    if (items.length) extracted.items = items;
    return;
  }
  if (pendingField === 'mode') {
    if (/retirada|retirar|balcao/i.test(text)) extracted.mode = 'TAKEOUT';
    if (/entrega|delivery/i.test(text)) extracted.mode = 'DELIVERY';
    return;
  }
  if (pendingField === 'payment') {
    if (/pix/i.test(text)) extracted.payment = 'PIX';
    else if (/cart[aã]o|cartao|cr[eé]dito|d[eé]bito/i.test(text)) extracted.payment = 'CARD';
    else if (/dinheiro|especie|espécie|cash|nota/i.test(text)) extracted.payment = 'CASH';
    return;
  }
  if (pendingField.startsWith('address.')) {
    const key = pendingField.slice('address.'.length);
    extracted.address[key] = text;
    return;
  }
  extracted[pendingField] = text;
}

async function createSaiposOrder({ conversation, runtime, apiRequest, getEnvConfig, log }) {
  if (runtime.segment !== 'restaurant') return { ok: true, skipped: true };
  const tx = conversation.transaction || {};

  const { resolved, unresolved } = resolveItemsWithCatalog(conversation.transaction.items, conversation.catalog || []);
  if (unresolved.length) return { ok: false, unresolved };

  const total_amount = resolved.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0);
  conversation.transaction.total_amount = total_amount;

  const order_id = `${runtime.id}-ANA-${Date.now()}`;
  const display_id = String(Date.now()).slice(-4);
  const paymentCode = conversation.transaction.payment === 'PIX' ? 'PARTNER_PAYMENT' : 'CRE';
  const cfg = getEnvConfig(runtime.environment);

  const body = {
    order_id,
    display_id,
    cod_store: cfg.codStore,
    created_at: nowISO(),
    notes: cleanText(tx.notes || `Pedido WhatsApp - ${runtime.id}`),
    total_amount,
    total_discount: 0,
    order_method: {
      mode: conversation.transaction.mode || 'DELIVERY',
      scheduled: false,
      delivery_date_time: nowISO(),
      ...((conversation.transaction.mode || 'DELIVERY') === 'DELIVERY' ? { delivery_by: 'RESTAURANT', delivery_fee: 0 } : {}),
    },
    customer: { id: conversation.phone, name: cleanText(tx.customer_name || 'Cliente WhatsApp'), phone: conversation.phone },
    ...(((conversation.transaction.mode || 'DELIVERY') === 'DELIVERY') ? {
      delivery_address: {
        street_name: conversation.transaction.address.street_name || '',
        street_number: conversation.transaction.address.street_number || 'S/N',
        neighborhood: conversation.transaction.address.neighborhood || '',
        district: conversation.transaction.address.neighborhood || '',
        city: conversation.transaction.address.city || '',
        state: conversation.transaction.address.state || '',
        country: 'BR',
        postal_code: (conversation.transaction.address.postal_code || '').replace(/\D/g, ''),
      },
    } : {}),
    items: resolved,
    payment_types: [{ code: paymentCode, amount: total_amount, change_for: 0 }],
  };

  try {
    await apiRequest(runtime.environment, 'POST', '/order', body);
    conversation.transaction.order_id = order_id;
    log('INFO', 'Ana: pedido criado com sucesso', { tenantId: runtime.id, phone: conversation.phone, order_id });
    return { ok: true, order_id };
  } catch (err) {
    log('ERROR', 'Ana: erro ao criar pedido SAIPOS', { err: err.message, tenantId: runtime.id, phone: conversation.phone });
    return { ok: false, error: err.message };
  }
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

async function createAnaFoodOrder({ conversation, runtime, log }) {
  if (runtime.segment !== 'restaurant') return { ok: true, skipped: true };
  if (!runtime.anafood.endpoint) return { ok: false, error: 'ANAFOOD endpoint nao configurado' };

  const { resolved, unresolved } = resolveItemsWithCatalog(conversation.transaction.items, conversation.catalog || []);
  if (unresolved.length) return { ok: false, unresolved };

  const total_amount = resolved.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0);
  conversation.transaction.total_amount = total_amount;

  const items = resolved.map((i) => ({
    name: i.desc_item,
    quantity: i.quantity,
    price: Number((i.unit_price || 0) / 100),
  }));

  const tx = conversation.transaction;
  const payload = {
    action: 'create',
    ...(runtime.anafood.companyId ? { company_id: runtime.anafood.companyId } : {}),
    order: {
      ...(runtime.anafood.companyId ? { company_id: runtime.anafood.companyId } : {}),
      customer_name: cleanText(tx.customer_name || 'Cliente WhatsApp'),
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
      delivery_fee: 0,
      total: Number((total_amount || 0) / 100),
      observations: cleanText(tx.notes || ''),
    },
  };

  const headers = { 'Content-Type': 'application/json' };
  if (runtime.anafood.authMode === 'company_key' && runtime.anafood.companyKey) {
    headers['X-Company-Key'] = runtime.anafood.companyKey;
  }
  if (runtime.anafood.authMode === 'api_token' && runtime.anafood.apiToken) {
    headers['X-API-Token'] = runtime.anafood.apiToken;
    if (runtime.anafood.companyHeader) headers['X-Company-ID'] = runtime.anafood.companyHeader;
  }

  try {
    const response = await fetch(runtime.anafood.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data?.error || `HTTP ${response.status}`);
      err.details = data;
      throw err;
    }

    conversation.transaction.order_id = data?.order?.id || `anafood-${Date.now()}`;
    log('INFO', 'Ana: pedido criado com sucesso no AnaFood', {
      tenantId: runtime.id,
      phone: conversation.phone,
      order_id: conversation.transaction.order_id,
    });
    return { ok: true, order_id: conversation.transaction.order_id };
  } catch (err) {
    log('ERROR', 'Ana: erro ao criar pedido AnaFood', {
      err: err.message,
      details: err.details || undefined,
      tenantId: runtime.id,
      phone: conversation.phone,
    });
    return { ok: false, error: err.message };
  }
}

async function createOrderByProviderIfNeeded({ conversation, runtime, apiRequest, getEnvConfig, log }) {
  if (runtime.segment !== 'restaurant') return { ok: true, skipped: true };
  if (conversation.transaction.order_id) return { ok: true, already: true };

  if (runtime.orderProvider === 'anafood') {
    return createAnaFoodOrder({ conversation, runtime, log });
  }
  return createSaiposOrder({ conversation, runtime, apiRequest, getEnvConfig, log });
}

function fallbackText(runtime, action, tx, missing, conversation = null) {
  const firstName = cleanText(tx?.customer_name || '').split(' ')[0] || '';
  const hi = firstName ? `${firstName}, ` : '';
  const agentName = runtime?.agentName || 'Ana';
  const companyName = cleanText(runtime?.companyContext?.companyName || runtime?.name || '');

  if (action === 'WELCOME') {
    const identity = companyName
      ? `Aqui é a ${agentName} do ${companyName} 😊`
      : `Aqui é a ${agentName} 😊`;
    return firstName
      ? `Olá, ${firstName}! ${identity} Como posso te ajudar hoje?`
      : `Olá! ${identity} Como posso te ajudar hoje?`;
  }

  if (action === 'ASK_REPEAT_LAST_ORDER') {
    const preview = cleanText(conversation?.repeatPreview || '');
    if (preview) return `${hi}vi que seu último pedido foi:\n${preview}\n\nDeseja repetir o mesmo? 😊`;
    return `${hi}vi que você já pediu aqui antes. Quer repetir o último pedido?`;
  }

  if (action === 'ASK_FIELD_CONFIRMATION') {
    const field = (missing || [])[0];
    if (!field) return `${hi}pode confirmar esse dado?`;
    const label = fieldConfirmationLabel(field);
    const value = fieldConfirmationValue(tx, field);
    return `Só confirmar: ${label} é *${value}*? 😊`;
  }

  if (action === 'ASK_MISSING_FIELDS') {
    const first = (missing || [])[0];
    const mcp = conversation?.companyData || {};
    const payments = Array.isArray(mcp?.paymentMethods) && mcp.paymentMethods.length
      ? mcp.paymentMethods.join(', ')
      : 'PIX ou cartão';
    const map = {
      customer_name: 'Qual é o seu nome?',
      items: `${hi}quais itens você gostaria de pedir?`,
      notes: 'Tem alguma observação para o pedido? Se não tiver, é só responder "sem observações" 😊',
      mode: `${hi}seu pedido é para retirada ou delivery?`,
      payment: `${hi}qual forma de pagamento prefere: ${payments}?`,
      'address.street_name': 'Qual é a rua para entrega?',
      'address.street_number': 'Qual é o número do endereço?',
      'address.neighborhood': 'E o bairro?',
      'address.city': 'Qual é a cidade?',
      'address.state': 'Qual é o estado (UF)?',
      'address.postal_code': 'Pode me passar o CEP? (somente números)',
    };
    return map[first] || `${hi}me passa mais um dado para continuar com o pedido.`;
  }

  if (action === 'ANSWER_AND_RESUME') {
    const lastUser = cleanText(conversation?.messages?.slice(-1)?.[0]?.content || '').toLowerCase();
    if (/^ja (falei|informei)|^já (falei|informei)/.test(lastUser)) {
      const first = (missing || [])[0];
      if (first === 'items') return 'Entendido! Para eu registrar certinho, pode informar os itens assim: "1 prato do dia e 1 coca-cola lata"?';
      if (first === 'address.street_name') return 'Entendido! Pode me passar a rua completa?';
      if (first === 'address.street_number') return 'Entendido! E o número da casa?';
      if (first === 'address.neighborhood') return 'Entendido! Qual é o bairro?';
      if (first === 'payment') return 'Entendido! Qual forma de pagamento prefere?';
      return 'Entendido! Continuando de onde paramos...';
    }
    return fallbackText(runtime, 'ASK_MISSING_FIELDS', tx, missing, conversation);
  }

  if (action === 'ANSWER_AND_RESUME_CONFIRM') {
    return fallbackText(runtime, 'ASK_FIELD_CONFIRMATION', tx, missing, conversation);
  }
  if (action === 'ANSWER_AND_RESUME_REPEAT') {
    return fallbackText(runtime, 'ASK_REPEAT_LAST_ORDER', tx, missing, conversation);
  }

  if (action === 'UPSELL_SUGGEST') {
    const itemLines = (tx.items || []).map((it) => `• ${it.quantity}x ${it.name}`).join('\n') || '—';
    const mcp = conversation?.companyData || {};
    const menu = Array.isArray(mcp.menu) ? mcp.menu : [];
    const cartNorms = (tx.items || []).map((it) => normalizeForMatch(it.name));
    const extras = menu
      .filter((m) => m.available !== false && !cartNorms.includes(normalizeForMatch(m.name)))
      .slice(0, 3)
      .map((m) => m.name);
    const suggestionLine = extras.length
      ? `Deseja acrescentar algo? Temos também ${extras.join(', ')} 😋`
      : 'Gostaria de acrescentar mais algum item ao pedido?';
    return `${hi}anotei:\n${itemLines}\n\n${suggestionLine}`;
  }

  if (action === 'ANSWER_AND_CONFIRM') {
    const itemLines = (tx.items || []).map((it) => `• ${it.quantity}x ${it.name}`).join('\n') || '—';
    return `${hi}respondendo rapidinho e voltando ao seu pedido 😊\n\nItens:\n${itemLines}\n\nPosso confirmar o pedido?`;
  }

  if (action === 'ORDER_REVIEW') {
    const items = (tx.items || []).map((it) => {
      const price = it.unit_price ? ` – ${formatBRL(it.unit_price / 100)}` : '';
      return `• ${it.quantity}x ${it.name}${price}`;
    }).join('\n') || '—';
    const paymentMap = { PIX: 'PIX', CARD: 'Cartão', CASH: 'Dinheiro' };
    const payment = paymentMap[tx.payment] || tx.payment || '—';
    const mode = tx.mode === 'TAKEOUT' ? 'Retirada no local' : 'Delivery';
    let addrLine = '';
    if (tx.mode === 'DELIVERY' && cleanText(tx.address?.street_name)) {
      const addrParts = [tx.address.street_name, tx.address.street_number, tx.address.neighborhood, tx.address.city].filter(Boolean);
      addrLine = `\nEndereço: ${addrParts.join(', ')}`;
    }
    const total = (tx.items || []).reduce((sum, it) => sum + (Number(it.unit_price || 0) * Number(it.quantity || 1)), 0);
    const totalLine = total > 0 ? `\n\nTotal: ${formatBRL(total / 100)}` : '';
    return `${hi}aqui está o resumo do pedido 👇\n\nItens:\n${items}\n\nModalidade: ${mode}${addrLine}\nPagamento: ${payment}${totalLine}\n\nEstá tudo certo? 😊`;
  }

  if (action === 'CREATE_ORDER_AND_WAIT_PAYMENT') {
    const companyInfo = companyName ? ` do ${companyName}` : '';
    return `Pedido anotado! Assim que confirmar o pagamento via PIX, já encaminho para a cozinha${companyInfo} 🙌`;
  }

  if (action === 'CREATE_ORDER_AND_CONFIRM' || action === 'PAYMENT_CONFIRMED') {
    return firstName
      ? `Pedido confirmado, ${firstName}! Já estamos preparando tudo 🍽️ Qualquer dúvida é só chamar!`
      : `Pedido confirmado! Já estamos preparando tudo 🍽️ Qualquer dúvida é só chamar!`;
  }

  if (action === 'PAYMENT_REMINDER') {
    return `${hi}ainda aguardo a confirmação do pagamento. Assim que pagar, é só me avisar 😊`;
  }

  if (action === 'REQUEST_ADJUSTMENTS') {
    return `${hi}claro! O que você gostaria de alterar no pedido?`;
  }

  if (action === 'FLOW_CANCELLED') {
    return `Tudo bem, ${firstName || 'tudo bem'}! Pedido cancelado. Se quiser fazer um novo pedido é só me chamar 😊`;
  }

  if (action === 'BLOCK_NEW_ORDER_UNTIL_FINISH') {
    return `${hi}ainda tenho um pedido em andamento para você. Me avisa quando quiser e eu te ajudo com um novo 😊`;
  }

  if (action === 'HUMAN_HANDOFF') {
    return `Claro, ${firstName || 'claro'}! Vou te transferir para um atendente humano agora mesmo. Um instante 😊`;
  }

  if (action === 'END_CONVERSATION') {
    return `Até logo! Se precisar é só chamar 😊`;
  }

  return `${hi}pode me explicar melhor? Estou aqui para ajudar 😊`;
}

function buildMenuReply(conversation, followUp = '') {
  const menu = Array.isArray(conversation?.companyData?.menu) ? conversation.companyData.menu : [];
  if (!menu.length) return '';
  const categories = new Map();
  for (const item of menu) {
    const cat = cleanText(item?.category || 'Cardapio');
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(item);
  }
  const sections = [];
  for (const [cat, items] of categories.entries()) {
    const top = items.slice(0, 6).map((i) => `- ${i.name}${Number(i.price || 0) > 0 ? ` (${formatBRL(i.price)})` : ''}`).join('\n');
    sections.push(`*${cat}*\n${top}`);
  }
  const base = `*Cardápio de hoje*\n\n${sections.slice(0, 3).join('\n\n')}`;
  return followUp ? `${base}\n\n${followUp}` : base;
}

function buildContextualAnswer(conversation, userMessage = '') {
  const text = cleanText(userMessage).toLowerCase();
  const mcp = conversation?.companyData || {};
  const company = mcp?.company || {};
  const menu = Array.isArray(mcp?.menu) ? mcp.menu : [];
  const payments = Array.isArray(mcp?.paymentMethods) ? mcp.paymentMethods : [];
  const deliveryAreas = Array.isArray(mcp?.deliveryAreas) ? mcp.deliveryAreas : [];

  if (/\b(endereco|endereço|localiza[cç][aã]o)\b/.test(text)) {
    const address = (() => {
      if (typeof company.address === 'string') return cleanText(company.address);
      if (company.address && typeof company.address === 'object') {
        const a = company.address;
        return cleanText([
          a.logradouro || a.street || a.street_name || '',
          a.numero || a.number || a.street_number || '',
          a.bairro || a.neighborhood || '',
          a.cidade || a.city || '',
          a.estado || a.state || '',
          a.cep || a.postal_code || '',
        ].filter(Boolean).join(', '));
      }
      return '';
    })();
    if (address) return `Nosso endereço é: ${address}.`;
    return 'Posso te passar o endereço assim que estiver cadastrado no sistema.';
  }

  if (/\b(horario|funcionamento|abre|fecha)\b/.test(text)) {
    const opening = (() => {
      if (typeof company.openingHours === 'string') return cleanText(company.openingHours);
      if (company.openingHours && typeof company.openingHours === 'object') {
        const order = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const label = { monday: 'Seg', tuesday: 'Ter', wednesday: 'Qua', thursday: 'Qui', friday: 'Sex', saturday: 'Sab', sunday: 'Dom' };
        const parts = [];
        for (const d of order) {
          const row = company.openingHours[d];
          if (!row || row.closed) continue;
          if (row.open && row.close) parts.push(`${label[d]} ${row.open}-${row.close}`);
        }
        return cleanText(parts.join(' | '));
      }
      return '';
    })();
    if (opening) return `Nosso horário de funcionamento é: ${opening}.`;
    return 'Ainda não tenho o horário cadastrado no sistema.';
  }

  if (/\b(pagamento|formas de pagamento|pix|cart[aã]o|dinheiro)\b/.test(text)) {
    if (payments.length) return `Trabalhamos com: ${payments.join(', ')}.`;
    return 'No momento não encontrei as formas de pagamento no cadastro da empresa.';
  }

  if (/\b(valor|pre[cç]o|quanto|marmita grande|marmita pequena|card[aá]pio|cardapio|menu)\b/.test(text)) {
    if (!menu.length) return 'No momento não encontrei o cardápio cadastrado no banco de dados.';
    const sizeHint = text.includes('grande') ? 'grande' : (text.includes('pequena') ? 'pequena' : '');
    if (sizeHint) {
      const item = menu.find((i) => String(i?.name || '').toLowerCase().includes(sizeHint));
      if (item && Number(item.price || 0) > 0) return `A opção ${item.name} está por ${formatBRL(item.price)}.`;
    }
    const priced = menu.filter((i) => Number(i.price || 0) > 0).slice(0, 4);
    if (priced.length) {
      return `Alguns valores do cardápio: ${priced.map((i) => `${i.name} (${formatBRL(i.price)})`).join(', ')}.`;
    }
    return 'Encontrei o cardápio, mas sem preços preenchidos.';
  }

  if (/\b(entrega|delivery|bairro|taxa)\b/.test(text)) {
    const bairroMatch = text.match(/bairro\s+([a-z0-9\s]+)/i);
    if (bairroMatch && deliveryAreas.length) {
      const asked = normalizeForMatch(bairroMatch[1]);
      const found = deliveryAreas.find((a) => normalizeForMatch(a.neighborhood).includes(asked) || asked.includes(normalizeForMatch(a.neighborhood)));
      if (found) return `A taxa para ${found.neighborhood} é ${formatBRL(found.fee)}.`;
    }
    if (deliveryAreas.length) {
      const sample = deliveryAreas.slice(0, 5).map((a) => `${a.neighborhood} (${formatBRL(a.fee)})`).join(', ');
      return `Entregamos em: ${sample}.`;
    }
    return 'Ainda não encontrei as áreas de entrega cadastradas.';
  }

  return '';
}

async function generatorAgent({ runtime, conversation, customer, classification, orchestratorResult, groupedText }) {
  const deterministic = {
    state: conversation.state,
    action: orchestratorResult.action,
    intent: classification.intent,
    missing: orchestratorResult.missing || [],
    transaction: conversation.transaction,
    userMessage: groupedText || '',
    customerProfile: {
      phone: conversation.phone,
      contactName: conversation.contactName || '',
      customerName: cleanText(customer?.name || ''),
      totalOrders: Number(customer?.totalOrders || 0),
      lastOrderSummary: cleanText(customer?.lastOrderSummary || ''),
    },
    companyContext: runtime.companyContext || {},
    companyMcp: conversation.companyData || {},
  };
  if (!openai) {
    return fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing, conversation);
  }
  try {
    const companyName = cleanText(runtime.companyContext?.companyName || runtime.name || '');
    const customerFirstName = cleanText(customer?.name || deterministic.customerProfile?.customerName || '').split(' ')[0] || '';
    const c = await openai.chat.completions.create({
      model: runtime.model,
      temperature: runtime.temperature,
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `Você é ${runtime.agentName}${companyName ? `, atendente virtual do ${companyName}` : ', atendente virtual'}. Tom: ${runtime.tone}.

IDENTIDADE: Sempre se apresente como ${runtime.agentName}${companyName ? ` do ${companyName}` : ''} no primeiro contato do dia.

PERSONALIDADE: Seja calorosa, empática e proativa. Use o nome do cliente quando souber (${customerFirstName ? `nome atual: ${customerFirstName}` : 'pergunte o nome se ainda não souber'}). Trate o cliente como pessoa, não como ticket.

FLUXO DE VENDA (siga esta ordem):
1. Receber item → confirmar o que foi pedido
2. (action=UPSELL_SUGGEST) Sugerir complemento: bebida para prato, sobremesa, upgrade — nunca insistir
3. Após o cliente indicar que não quer mais nada → perguntar retirada ou delivery
4. Coletar endereço (só se delivery)
5. Perguntar pagamento
6. Apresentar resumo estruturado com itens em bullets, endereço, pagamento e total
7. Pedir confirmação — SOMENTE por último

REGRAS OBRIGATÓRIAS:
- Respostas curtas e naturais (1-3 frases no máximo)
- Uma pergunta ou ação por vez
- Nunca invente preço, prazo ou regra que não esteja nos dados
- Não repita informações já confirmadas
- Se não entender um item, pergunte o nome exato como aparece no cardápio
- Responda perguntas laterais e retome o fluxo na etapa pendente (action=ANSWER_AND_CONFIRM: responda E relembre o pedido)
- Só peça endereço quando o modo for DELIVERY
- Emojis com moderação (um por mensagem é suficiente)
- Se o cliente estiver frustrado, reconheça com empatia antes de continuar
- (action=ORDER_REVIEW) Formatar resumo com bullets, separar itens / modalidade / endereço / pagamento / total em linhas separadas

ESTILO: Use linguagem natural brasileira. Evite palavras robóticas. Prefira "já anotei", "pode deixar", "tudo certo".
No ORDER_REVIEW use quebras de linha reais entre seções — não coloque tudo numa linha só.

DADOS DO ESTABELECIMENTO (use para responder qualquer pergunta sobre endereço, horário, pagamentos ou taxas):
${(() => {
  const mcp = conversation.companyData || {};
  const ctx = runtime.companyContext || {};
  const addr = cleanText(mcp.company?.address || ctx.address || '');
  const hours = cleanText(mcp.company?.openingHours || ctx.openingHours || '');
  const payments = Array.from(new Set([
    ...(Array.isArray(mcp.paymentMethods) ? mcp.paymentMethods : []),
    ...(Array.isArray(ctx.paymentMethods) ? ctx.paymentMethods : []),
  ])).filter(Boolean);
  const delivery = Array.isArray(mcp.deliveryAreas) && mcp.deliveryAreas.length
    ? mcp.deliveryAreas
    : (Array.isArray(ctx.deliveryAreas) ? ctx.deliveryAreas : []);
  const lines = [
    addr   ? `- Endereço: ${addr}` : '- Endereço: não cadastrado',
    hours  ? `- Horário: ${hours}` : '- Horário: não cadastrado',
    payments.length ? `- Formas de pagamento: ${payments.join(', ')}` : '- Formas de pagamento: não cadastradas',
    delivery.length ? `- Taxas de entrega: ${delivery.map(a => `${a.neighborhood || a} (${formatBRL(a.fee || 0)})`).join('; ')}` : '- Taxas de entrega: não cadastradas',
  ];
  return lines.join('\n');
})()}
${runtime.customPrompt ? `\nINSTRUÇÕES ESPECÍFICAS DO ESTABELECIMENTO:\n${runtime.customPrompt}` : ''}`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            deterministic,
            summary: conversation.contextSummary,
          }),
        },
      ],
    });
    const text = cleanText(c.choices?.[0]?.message?.content || '');
    return text || fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing, conversation);
  } catch (_) {
    return fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing, conversation);
  }
}

async function maybeSummarize({ runtime, conversation }) {
  if ((conversation.messageCount || 0) % SUMMARY_EVERY_N_MESSAGES !== 0) return;
  if (!openai) return;
  try {
    const c = await openai.chat.completions.create({
      model: runtime.model,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: 'Resuma em ate 5 linhas o contexto transacional atual.' },
        { role: 'user', content: JSON.stringify(conversation.messages.slice(-10)) },
      ],
    });
    conversation.contextSummary = cleanText(c.choices?.[0]?.message?.content || conversation.contextSummary || '');
  } catch (_) {}
}

async function sendWhatsAppMessage(phone, text, runtime, remoteJid = null) {
  const { apiUrl, apiKey } = runtime.evolution;
  if (!apiUrl || !apiKey) return false;

  const safeText = cleanText(text);
  if (!safeText) return false;

  const rawPhone = String(phone || '').trim();
  const digitsPhone = rawPhone.replace(/\D/g, '');
  const numbers = Array.from(new Set([
    digitsPhone ? `${digitsPhone}@s.whatsapp.net` : '',
    digitsPhone ? `${digitsPhone}@c.us` : '',
    digitsPhone,
    rawPhone,
    String(remoteJid || '').trim(),
    digitsPhone ? `${digitsPhone}@lid` : '',
  ].filter(Boolean)));

  async function fetchInstances() {
    const endpoints = [
      `${apiUrl}/instance/fetchInstances`,
      `${apiUrl}/instance/findInstances`,
      `${apiUrl}/instance/list`,
      `${apiUrl}/instance/all`,
    ];
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            apikey: apiKey,
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        });
        if (!response.ok) continue;
        const payload = await response.json().catch(() => ({}));
        const rows = Array.isArray(payload) ? payload
          : Array.isArray(payload?.data) ? payload.data
            : Array.isArray(payload?.result) ? payload.result
              : [];
        if (!rows.length) continue;
        return rows.map((row) => ({
          name: String(row?.instance?.instanceName || row?.instanceName || row?.name || row?.instance || ''),
          state: String(row?.instance?.state || row?.state || row?.status || '').toLowerCase(),
        })).filter((r) => r.name);
      } catch (_) {}
    }
    return [];
  }

  function bestInstance(instances, preferred) {
    const byName = new Map(instances.map((i) => [i.name, i]));
    const pref = preferred ? byName.get(preferred) : null;
    const open = instances.find((i) => ['open', 'connected'].includes(i.state));
    const connecting = instances.find((i) => i.state === 'connecting');
    if (pref && ['open', 'connected'].includes(pref.state)) return pref.name;
    if (open?.name) return open.name;
    if (pref && pref.state === 'connecting') return pref.name;
    if (connecting?.name) return connecting.name;
    if (pref?.name) return pref.name;
    return instances[0]?.name || preferred || '';
  }

  const candidates = [];
  if (runtime.evolution.instance) candidates.push(runtime.evolution.instance);
  try {
    const instances = await fetchInstances();
    const chosen = bestInstance(instances, runtime.evolution.instance);
    if (chosen && !candidates.includes(chosen)) candidates.unshift(chosen);
  } catch (_) {}

  const payloads = [
    { number: null, text: safeText, delay: 600 },
    { number: null, textMessage: { text: safeText }, options: { delay: 600 } },
    { number: null, textMessage: { text: safeText } },
  ];

  const postJson = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      err.details = bodyText;
      throw err;
    }
    return true;
  };

  let lastErr = null;
  for (const activeInstance of candidates) {
    const endpoints = [
      `${apiUrl}/message/sendText/${activeInstance}`,
      `${apiUrl}/message/sendText/${activeInstance}?delay=600`,
    ];
    for (const number of numbers) {
      for (const endpoint of endpoints) {
        for (const payloadTemplate of payloads) {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await postJson(endpoint, { ...payloadTemplate, number });
              runtime.evolution.instance = activeInstance;
              return true;
            } catch (err) {
              lastErr = err;
              if (err.status === 400 || err.status === 404) break;
            }
          }
        }
      }
    }
  }
  console.error(`[ANA] Nao foi possivel enviar WhatsApp para ${phone} (instance=${runtime.evolution.instance || '-' }):`, lastErr?.details || lastErr?.message || 'unknown error');
  return false;
}

async function runPipeline({ conversation, customer, groupedText, normalized, runtime, apiRequest, getEnvConfig, log, onSend = null }) {
  try {
    conversation.companyData = await loadCompanyData({
      tenant: {
        id: runtime.id,
        name: runtime.name,
        environment: runtime.environment,
        business: {
          restaurant: {
            ...runtime.companyContext,
            requireAddress: runtime.delivery?.requireAddress,
            openingHours: runtime.companyContext?.openingHours,
            address: runtime.companyContext?.address,
          },
        },
        integrations: { supabase: { ...runtime.supabase } },
      },
      tenantId: runtime.id,
      apiRequest,
      getEnvConfig,
    });
  } catch (_) {}

  await maybeLoadCatalog(conversation, runtime, apiRequest, getEnvConfig, log);

  // Pré-preencher nome do cliente a partir do perfil persistido (nunca perguntar novamente)
  if (cleanText(customer.name) && !cleanText(conversation.transaction.customer_name)) {
    conversation.transaction.customer_name = cleanText(customer.name);
    conversation.confirmed['customer_name'] = true;
  }

  const normalizedText = normalized.normalizedText || groupedText;
  const classification = await classifierAgent({ runtime, conversation, groupedText: normalizedText });
  const missingBeforeExtraction = runtime.segment === 'restaurant'
    ? restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed)
    : [];
  const hasOpenTransaction = runtime.segment === 'restaurant'
    && (
      Boolean(cleanText(conversation.transaction.customer_name))
      || Boolean(cleanText(conversation.transaction.mode))
      || Boolean(cleanText(conversation.transaction.payment))
      || Boolean(cleanText(conversation.transaction.address?.street_name))
      || (Array.isArray(conversation.transaction.items) && conversation.transaction.items.length > 0)
      || Boolean(conversation.pendingFieldConfirmation)
    );
  const shouldExtract = classification.requires_extraction
    || (runtime.segment === 'restaurant' && [
      STATES.COLLECTING_DATA,
      STATES.WAITING_CONFIRMATION,
      STATES.WAITING_PAYMENT,
    ].includes(conversation.state))
    || (runtime.segment === 'restaurant' && hasOpenTransaction && missingBeforeExtraction.length > 0)
    || (runtime.segment === 'restaurant' && Boolean(conversation.pendingFieldConfirmation));
  const extracted = shouldExtract ? await extractorAgent({ runtime, groupedText: normalizedText }) : {};
  if (runtime.segment === 'restaurant') {
    const menuPool = [
      ...(Array.isArray(conversation?.companyData?.menu) ? conversation.companyData.menu : []),
      ...(Array.isArray(conversation.catalog) ? conversation.catalog : []),
    ];
    const inferred = inferItemsFromMenu(normalizedText, menuPool);
    const currentItems = Array.isArray(extracted.items) ? extracted.items : [];
    const hasJoinedItem = currentItems.some((i) => /\s+e\s+/.test(String(i?.name || '').toLowerCase()));
    if (inferred.length && (inferred.length >= currentItems.length || hasJoinedItem)) {
      extracted.items = inferred;
    }
    forceFillPendingField({ conversation, runtime, groupedText: normalizedText, extracted });
    extracted.items = normalizeExtractedItemsWithCatalog(extracted.items || [], conversation.catalog || []);
    // Remove unresolved duplicates: if an item with integration_code exists, drop similar items without code
    {
      const withCode = extracted.items.filter((it) => cleanText(it.integration_code));
      if (withCode.length) {
        extracted.items = extracted.items.filter((it) => {
          if (cleanText(it.integration_code)) return true;
          const normIt = normalizeForMatch(it.name);
          return !withCode.some((c) => {
            const normC = normalizeForMatch(c.name);
            return normC.includes(normIt) || normIt.includes(normC);
          });
        });
      }
    }
  }
  log('INFO', 'Ana: classification/extraction', {
    tenantId: runtime.id,
    phone: conversation.phone,
    state: conversation.state,
    intent: classification.intent,
    confidence: classification.confidence,
    requiresExtraction: classification.requires_extraction,
    extracted,
  });

  const previousState = conversation.state;
  const orchestratorResult = orchestrate({ runtime, conversation, customer, classification, extracted, groupedText: normalizedText });
  conversation.state = orchestratorResult.nextState;
  if (conversation.state !== previousState) conversation.stateUpdatedAt = nowISO();
  log('INFO', 'Ana: orchestration', {
    tenantId: runtime.id,
    phone: conversation.phone,
    previousState,
    nextState: conversation.state,
    action: orchestratorResult.action,
    missing: orchestratorResult.missing,
    provider: runtime.orderProvider,
  });

  if (orchestratorResult.action === 'CREATE_ORDER_AND_WAIT_PAYMENT' || orchestratorResult.action === 'CREATE_ORDER_AND_CONFIRM') {
    const preValidation = resolveItemsWithCatalog(conversation.transaction.items, conversation.catalog || []);
    if (preValidation.unresolved.length) {
      conversation.consecutiveFailures = (conversation.consecutiveFailures || 0) + 1;
      conversation.state = STATES.COLLECTING_DATA;
      conversation.stateUpdatedAt = nowISO();
      const failText = `Nao encontrei esses itens no cardapio: ${preValidation.unresolved.join(', ')}. Pode informar exatamente como aparece no cardapio?`;
      const sent = await sendWhatsAppMessage(conversation.phone, failText, runtime, conversation.remoteJid);
      if (sent && typeof onSend === 'function') {
        onSend({
          phone: conversation.phone,
          remoteJid: conversation.remoteJid || null,
          text: failText,
          instance: runtime.evolution.instance || null,
        });
      }
      appendMessage(conversation, 'assistant', failText, { action: 'ORDER_PRE_VALIDATION_ERROR' });
      persistStateDebounced();
      return { success: true, reply: failText };
    }

    log('INFO', 'Ana: creating order on provider', {
      tenantId: runtime.id,
      phone: conversation.phone,
      provider: runtime.orderProvider,
      mode: conversation.transaction.mode,
      payment: conversation.transaction.payment,
      itemsCount: Array.isArray(conversation.transaction.items) ? conversation.transaction.items.length : 0,
    });
    const order = await createOrderByProviderIfNeeded({ conversation, runtime, apiRequest, getEnvConfig, log });
    if (!order.ok) {
      conversation.consecutiveFailures = (conversation.consecutiveFailures || 0) + 1;
      let failText = 'Tive um problema ao registrar o pedido no sistema.';
      if (Array.isArray(order.unresolved) && order.unresolved.length) {
        failText = `Nao encontrei esses itens no cardapio: ${order.unresolved.join(', ')}. Pode informar exatamente como aparece no cardapio?`;
        conversation.state = STATES.COLLECTING_DATA;
        conversation.stateUpdatedAt = nowISO();
      }
      const sent = await sendWhatsAppMessage(conversation.phone, failText, runtime, conversation.remoteJid);
      if (sent && typeof onSend === 'function') {
        onSend({
          phone: conversation.phone,
          remoteJid: conversation.remoteJid || null,
          text: failText,
          instance: runtime.evolution.instance || null,
        });
      }
      appendMessage(conversation, 'assistant', failText, { action: 'ORDER_CREATE_ERROR' });
      persistStateDebounced();
      return { success: true, reply: failText };
    }
    log('INFO', 'Ana: order create result', {
      tenantId: runtime.id,
      phone: conversation.phone,
      provider: runtime.orderProvider,
      ok: order.ok,
      order_id: order.order_id || conversation.transaction.order_id || null,
      unresolved: order.unresolved || [],
    });
    if (orchestratorResult.action === 'CREATE_ORDER_AND_CONFIRM') {
      customer.totalOrders = (customer.totalOrders || 0) + 1;
      conversation.consecutiveFailures = 0;
      customer.lastOrderSnapshot = buildOrderSnapshot(conversation.transaction);
      customer.lastOrderSummary = formatOrderPreview(customer.lastOrderSnapshot);
      conversation.orderStoredForCustomer = true;
    }
  }
  if (orchestratorResult.action === 'PAYMENT_CONFIRMED' && !conversation.orderStoredForCustomer) {
    customer.totalOrders = (customer.totalOrders || 0) + 1;
    customer.lastOrderSnapshot = buildOrderSnapshot(conversation.transaction);
    customer.lastOrderSummary = formatOrderPreview(customer.lastOrderSnapshot);
    conversation.orderStoredForCustomer = true;
    conversation.consecutiveFailures = 0;
  }

  const deterministicActions = new Set([
    'ASK_MISSING_FIELDS',
    'ASK_FIELD_CONFIRMATION',
    'ANSWER_AND_RESUME',
    'ANSWER_AND_RESUME_CONFIRM',
    'ANSWER_AND_RESUME_REPEAT',
    'ASK_REPEAT_LAST_ORDER',
    'ORDER_REVIEW',
    'ASK_CONFIRMATION',
    'REQUEST_ADJUSTMENTS',
    'PAYMENT_REMINDER',
    'FLOW_CANCELLED',
  ]);

  const reply = orchestratorResult.action === 'WELCOME'
    ? (() => {
      const firstMissing = (orchestratorResult.missing || [])[0];
      const hasPendingValue = firstMissing === 'items'
        ? Array.isArray(conversation.transaction.items) && conversation.transaction.items.length > 0
        : String(firstMissing || '').startsWith('address.')
          ? Boolean(cleanText(conversation.transaction.address?.[String(firstMissing).slice('address.'.length)]))
          : Boolean(cleanText(conversation.transaction[firstMissing]));
      const followUpAction = hasPendingValue ? 'ASK_FIELD_CONFIRMATION' : 'ASK_MISSING_FIELDS';
      const followUp = fallbackText(runtime, followUpAction, conversation.transaction, orchestratorResult.missing || [], conversation);
      // Saudação com identidade da empresa e nome do cliente
      const agentN = runtime.agentName || 'Ana';
      const companyN = cleanText(runtime.companyContext?.companyName || runtime.name || '');
      const clientFirstName = cleanText(customer?.name || conversation.transaction?.customer_name || '').split(' ')[0];
      const personalGreeting = clientFirstName ? `Olá, ${clientFirstName}! ` : 'Olá! ';
      const identity = companyN ? `Aqui é a ${agentN} do ${companyN} 😊` : `Aqui é a ${agentN} 😊`;
      const greetingBase = `${personalGreeting}${identity}`;
      return followUp ? `${greetingBase} ${followUp}`.trim() : greetingBase;
    })()
    : (() => {
      const text = normalized.normalizedText || groupedText;
      const asksMenu = /\b(card[aá]pio|cardapio|menu|itens de hoje)\b/i.test(text || '');
      if (asksMenu) {
        const followUp = fallbackText(runtime, 'ASK_MISSING_FIELDS', conversation.transaction, orchestratorResult.missing || [], conversation);
        const deterministicMenu = buildMenuReply(conversation, followUp);
        if (deterministicMenu) return deterministicMenu;
      }
      if (deterministicActions.has(orchestratorResult.action)) {
        if (orchestratorResult.action === 'ANSWER_AND_RESUME' || orchestratorResult.action === 'ANSWER_AND_RESUME_CONFIRM' || orchestratorResult.action === 'ANSWER_AND_RESUME_REPEAT') {
          const contextual = buildContextualAnswer(conversation, text);
          if (contextual) {
            const followAction = orchestratorResult.action === 'ANSWER_AND_RESUME_CONFIRM'
              ? 'ASK_FIELD_CONFIRMATION'
              : (orchestratorResult.action === 'ANSWER_AND_RESUME_REPEAT' ? 'ASK_REPEAT_LAST_ORDER' : 'ASK_MISSING_FIELDS');
            const follow = fallbackText(runtime, followAction, conversation.transaction, orchestratorResult.missing || [], conversation);
            return `${contextual} ${follow}`.trim();
          }
        }
        return fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing || [], conversation);
      }
      return null;
    })() || await generatorAgent({ runtime, conversation, customer, classification, orchestratorResult, groupedText: normalized.normalizedText || groupedText });
  if (conversation.state !== STATES.HUMAN_HANDOFF || !conversation.handoffNotified) {
    const sent = await sendWhatsAppMessage(conversation.phone, reply, runtime, conversation.remoteJid);
    if (sent && typeof onSend === 'function') {
      onSend({
        phone: conversation.phone,
        remoteJid: conversation.remoteJid || null,
        text: reply,
        instance: runtime.evolution.instance || null,
      });
    }
    if (conversation.state === STATES.HUMAN_HANDOFF) conversation.handoffNotified = true;
  }

  appendMessage(conversation, 'assistant', reply, {
    action: orchestratorResult.action,
    intent: classification.intent,
    prevState: previousState,
    nextState: conversation.state,
  });

  // Sincronizar nome extraído para o perfil persistente do cliente
  if (cleanText(conversation.transaction.customer_name) && !cleanText(customer.name)) {
    customer.name = cleanText(conversation.transaction.customer_name);
  }

  // Armazenar config de envio na conversa para uso pelos timers de follow-up
  conversation.evolutionConfig = { ...runtime.evolution };

  await maybeSummarize({ runtime, conversation });

  // Agendar follow-up automático (5 min aviso, 30 min cancelamento)
  scheduleFollowUp(conversation, runtime.evolution);

  persistStateDebounced();
  return { success: true, reply };
}

function enqueueMessageBlock({ conversation, text, rawMessage, runtime, customer, apiRequest, getEnvConfig, log, onSend = null }) {
  const key = conversation.id;
  let buffer = buffers.get(key);
  if (!buffer) {
    buffer = { chunks: [], rawMessages: [], timer: null };
    buffers.set(key, buffer);
  }

  if (text) buffer.chunks.push(text);
  if (rawMessage) buffer.rawMessages.push(rawMessage);
  if (buffer.timer) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  buffer.timer = setTimeout(async () => {
    const current = buffers.get(key);
    if (!current) return;
    current.timer = null;

    const groupedText = cleanText(current.chunks.join(' '));
    const lastRawMessage = current.rawMessages[current.rawMessages.length - 1] || null;
    current.chunks = [];
    current.rawMessages = [];

    if (!groupedText && !lastRawMessage) return;
    if (processing.has(key)) {
      current.chunks.push(groupedText);
      return;
    }

    processing.add(key);
    try {
      const normalized = await normalizeMessageBlock({ rawText: groupedText, rawMessage: lastRawMessage });
      log('INFO', 'Ana: processing grouped message', {
        tenantId: runtime.id,
        phone: conversation.phone,
        groupedText: groupedText.slice(0, 200),
        normalizedText: (normalized.normalizedText || '').slice(0, 200),
        sourceType: normalized.sourceType,
      });
      appendMessage(conversation, 'user', normalized.normalizedText || groupedText, {
        sourceType: normalized.sourceType,
        originalText: normalized.originalText,
        transcription: normalized.transcription,
      });
      await runPipeline({ conversation, customer, groupedText, normalized, runtime, apiRequest, getEnvConfig, log, onSend });
      // Fire-and-forget: persist mensagem do usuário no Supabase msg_history
      saveInboundMessage({
        supabaseUrl:    String(runtime.supabase?.url || '').trim(),
        serviceRoleKey: String(runtime.supabase?.serviceRoleKey || '').trim(),
        companyId:      String(conversation.companyData?.meta?.companyId || runtime.supabase?.filterValue || '').trim(),
        tenantId:       runtime.id,
        phone:          conversation.phone,
        content:        normalized.normalizedText || groupedText,
        at:             new Date().toISOString(),
        contactName:    String(conversation.contactName || customer.name || '').trim(),
      });
    } catch (err) {
      conversation.consecutiveFailures = (conversation.consecutiveFailures || 0) + 1;
      log('ERROR', 'Ana: erro no pipeline', { err: err.message, tenantId: runtime.id, phone: conversation.phone });
      const failText = 'Tive uma falha tecnica ao processar sua mensagem. Pode tentar novamente?';
      const sent = await sendWhatsAppMessage(conversation.phone, failText, runtime, conversation.remoteJid);
      if (sent && typeof onSend === 'function') {
        onSend({
          phone: conversation.phone,
          remoteJid: conversation.remoteJid || null,
          text: failText,
          instance: runtime.evolution.instance || null,
        });
      }
      appendMessage(conversation, 'assistant', failText, { action: 'PIPELINE_ERROR' });
      persistStateDebounced();
    } finally {
      processing.delete(key);
    }
  }, runtime.bufferWindowMs || BUFFER_WINDOW_MS);
}

async function handleWhatsAppMessage(phone, messageText, { apiRequest, getEnvConfig, log, tenant, rawMessage = null, instanceName = null, remoteJid = null, contactName = '', avatarUrl = '', messageId = '', onSend = null }) {
  const runtime = tenantRuntime(tenant, { instance: instanceName || undefined });
  const customer = getCustomer(runtime.id, phone);
  const conversation = getConversation(phone, runtime.id);
  const cleanContactName = cleanText(contactName || '').replace(/\s+/g, ' ');
  if (cleanContactName && !/^\+?\d[\d\s()-]+$/.test(cleanContactName)) {
    customer.name = cleanContactName;
  }
  if (!cleanText(customer.name) && cleanText(conversation.contactName)) {
    customer.name = cleanText(conversation.contactName);
  }
  if (!cleanText(conversation.transaction.customer_name) && cleanText(customer.name)) {
    conversation.transaction.customer_name = cleanText(customer.name);
  }
  const inboundId = String(
    messageId ||
    rawMessage?.key?.id ||
    rawMessage?.id ||
    rawMessage?.messageId ||
    ''
  ).trim();
  if (inboundId) {
    const seenKey = `${conversation.id}:${inboundId}`;
    const now = Date.now();
    const previous = inboundMessageSeen.get(seenKey);
    if (previous && now - previous < 5 * 60 * 1000) {
      return {
        success: true,
        queued: false,
        duplicate: true,
        conversationId: conversation.id,
        state: conversation.state,
        bufferWindowMs: runtime.bufferWindowMs || BUFFER_WINDOW_MS,
      };
    }
    inboundMessageSeen.set(seenKey, now);
    if (inboundMessageSeen.size > 5000) {
      const cutoff = now - (10 * 60 * 1000);
      for (const [k, ts] of inboundMessageSeen.entries()) {
        if (ts < cutoff) inboundMessageSeen.delete(k);
      }
    }
  }
  if (remoteJid) conversation.remoteJid = remoteJid;
  if (contactName) conversation.contactName = contactName;
  if (avatarUrl) conversation.avatarUrl = avatarUrl;
  log('INFO', 'Ana: enqueue message', {
    tenantId: runtime.id,
    phone,
    state: conversation.state,
    textPreview: cleanText(messageText || '').slice(0, 120),
  });

  enqueueMessageBlock({
    conversation,
    text: messageText,
    rawMessage,
    runtime,
    customer,
    apiRequest,
    getEnvConfig,
    log,
    onSend,
  });

  persistStateDebounced();
  return {
    success: true,
    queued: true,
    conversationId: conversation.id,
    state: conversation.state,
    bufferWindowMs: runtime.bufferWindowMs || BUFFER_WINDOW_MS,
  };
}

function clearCustomerAndSession(tenantId, phone) {
  const key = `${tenantId}:${phone}`;
  clearFollowUpTimers(key);
  conversations.delete(key);
  customers.delete(key);
  persistStateDebounced();
  return { cleared: true, key };
}

module.exports = {
  handleWhatsAppMessage,
  getAgentSettings,
  setAgentSettings,
  getSession: getConversation,
  sessions: conversations,
  clearCustomerAndSession,
  STATES,
  INTENTS,
};

