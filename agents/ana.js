'use strict';

const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const BUFFER_WINDOW_MS = Number(process.env.MESSAGE_BUFFER_MS || 20000);
const SESSION_TTL = Number(process.env.CONVERSATION_TTL_MS || 60 * 60 * 1000);
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
  greetingMessage: process.env.DEFAULT_GREETING_MESSAGE || 'Olá! Como posso ajudar você hoje?',
  greetingOncePerDay: true,
};

const customers = new Map();
const conversations = new Map();
const buffers = new Map();
const processing = new Set();
const agentSettings = new Map();
const inboundMessageSeen = new Map();

const STATE_FILE = process.env.ANA_STATE_FILE
  ? path.resolve(process.env.ANA_STATE_FILE)
  : path.join(__dirname, '..', 'data', 'ana_state.json');

let persistTimer = null;

const nowISO = () => new Date().toISOString();
const cleanText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const toNumberOrOne = (v) => { const n = parseInt(String(v || '').trim(), 10); return Number.isFinite(n) && n > 0 ? n : 1; };
const detectYes = (t) => { const x = cleanText(t).toLowerCase(); return /^(sim|ok|isso|certo|confirmo|confirmar|fechado)$/.test(x) || x.includes('confirm'); };
const detectNo = (t) => { const x = cleanText(t).toLowerCase(); return /^(nao|não|negativo|cancelar|cancela)$/.test(x) || x.includes('nao quero') || x.includes('não quero'); };

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
  return {
    id: tenantId,
    name: tenant?.name || 'Tenant',
    environment: (tenant?.environment || 'homologation').toLowerCase(),
    segment: (tenant?.business?.segment || 'restaurant').toLowerCase(),
    tone: tenant?.agent?.personality || 'simpatica e objetiva',
    agentName: tenant?.agent?.name || 'Ana',
    customPrompt: tenant?.agent?.customPrompt || '',
    model: tenant?.agent?.model || 'gpt-4o-mini',
    temperature: typeof tenant?.agent?.temperature === 'number' ? tenant.agent.temperature : 0.2,
    bufferWindowMs: Number.isFinite(bufferWindowMs) ? Math.max(3000, Math.min(120000, bufferWindowMs)) : AGENT_DEFAULTS.bufferWindowMs,
    greetingMessage: greetingMessage || AGENT_DEFAULTS.greetingMessage,
    greetingOncePerDay: true,
    delivery: { requireAddress: tenant?.business?.restaurant?.requireAddress !== false },
    orderProvider: (tenant?.business?.restaurant?.orderProvider || 'saipos').toLowerCase(),
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
    bufferWindowMs: Math.max(3000, Math.min(120000, Number(patch.bufferWindowMs || current.bufferWindowMs || AGENT_DEFAULTS.bufferWindowMs))),
    greetingMessage: cleanText(String(patch.greetingMessage || current.greetingMessage || AGENT_DEFAULTS.greetingMessage)),
    greetingOncePerDay: true,
  };
  agentSettings.set(tenantId, next);
  return next;
}

function getCustomer(tenantId, phone) {
  const key = `${tenantId}:${phone}`;
  let c = customers.get(key);
  if (!c) { c = { id: key, tenantId, phone, createdAt: nowISO(), updatedAt: nowISO(), totalOrders: 0 }; customers.set(key, c); }
  c.updatedAt = nowISO();
  return c;
}

function getConversation(phone, tenantId = 'default') {
  const key = `${tenantId}:${phone}`;
  let conv = conversations.get(key);
  const now = Date.now();
  if (!conv || (now - new Date(conv.lastActivityAt || conv.createdAt || nowISO()).getTime()) > SESSION_TTL) {
    conv = {
      id: key,
      tenantId,
      phone,
      state: STATES.INIT,
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
      greeted: false,
      messages: [],
      catalog: null,
    };
    conversations.set(key, conv);
  }
  if (!conv.confirmed || typeof conv.confirmed !== 'object') conv.confirmed = {};
  if (typeof conv.pendingFieldConfirmation === 'undefined') conv.pendingFieldConfirmation = null;
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
  if (/oi|ola|olá|bom dia|boa tarde|boa noite/.test(lower)) return { intent: INTENTS.SAUDACAO, requires_extraction: false, handoff: false, confidence: 0.8 };
  if (/quero|pedido|comprar|marmita|pizza|lanche|agendar|marcar/.test(lower)) return { intent: INTENTS.NOVO_PEDIDO, requires_extraction: true, handoff: false, confidence: 0.75 };
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
    payment: /pix/.test(lower) ? 'PIX' : (/(cartao|cartão|credito|debito)/.test(lower) ? 'CARD' : null),
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

  const cep = groupedText.match(/\b\d{8}\b/);
  if (cep) out.address.postal_code = cep[0];

  for (const m of groupedText.matchAll(/(\d+)\s+([\p{L}0-9\s-]{3,40})/gu)) {
    const name = cleanText(m[2]).replace(/(para entrega|delivery|retirada|no pix|no cartao)$/i, '').trim();
    if (name) out.items.push({ name, quantity: toNumberOrOne(m[1]) });
  }

  return out;
}

function markFieldChanged(conv, field) {
  conv.confirmed[field] = false;
  if (!conv.pendingFieldConfirmation) conv.pendingFieldConfirmation = field;
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
  if (!cleanText(tx.customer_name) || confirmed.customer_name !== true) missing.push('customer_name');
  if (!Array.isArray(tx.items) || tx.items.length === 0) missing.push('items');
  if (Array.isArray(tx.items) && tx.items.some((i) => !Number(i.quantity) || Number(i.quantity) <= 0)) missing.push('items');
  if (Array.isArray(tx.items) && tx.items.length > 0 && confirmed.items !== true) missing.push('items');
  if (!cleanText(tx.notes) || confirmed.notes !== true) missing.push('notes');
  if (!tx.mode || confirmed.mode !== true) missing.push('mode');
  if (tx.mode === 'DELIVERY' && runtime.delivery.requireAddress) {
    for (const f of ['street_name', 'street_number', 'neighborhood', 'city', 'state', 'postal_code']) {
      if (!cleanText(tx.address?.[f]) || confirmed[`address.${f}`] !== true) missing.push(`address.${f}`);
    }
  }
  if (!tx.payment || confirmed.payment !== true) missing.push('payment');
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

function orchestrate({ runtime, conversation, classification, extracted, groupedText }) {
  if (runtime.segment === 'restaurant') mergeRestaurantTransaction(conversation, extracted || {});

  const handoff = classification.handoff
    || classification.intent === INTENTS.HUMANO
    || Number(classification.confidence || 0) < 0.45
    || /(raiva|horrivel|péssimo|pessimo)/i.test(groupedText)
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
    if (i === INTENTS.SAUDACAO) {
      const today = nowISO().slice(0, 10);
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

async function maybeLoadCatalog(conversation, runtime, apiRequest, getEnvConfig, log) {
  if (runtime.segment !== 'restaurant') return [];
  if (Array.isArray(conversation.catalog) && conversation.catalog.length) return conversation.catalog;
  try {
    const cfg = getEnvConfig(runtime.environment);
    const raw = await apiRequest(runtime.environment, 'GET', `/catalog?cod_store=${cfg.codStore}`);
    conversation.catalog = normalizeCatalog(raw);
    log('INFO', `Ana: catalogo carregado (${conversation.catalog.length} itens)`, { tenantId: runtime.id, phone: conversation.phone });
  } catch (err) {
    log('ERROR', 'Ana: falha ao carregar catalogo', { err: err.message, tenantId: runtime.id, phone: conversation.phone });
    conversation.catalog = [];
  }
  return conversation.catalog;
}

function resolveItemsWithCatalog(items, catalog) {
  const unresolved = [];
  const resolved = [];
  for (const item of (items || [])) {
    const name = String(item.name || '').toLowerCase();
    let match = (catalog || []).find((c) => String(c.name || '').toLowerCase() === name);
    if (!match) match = (catalog || []).find((c) => String(c.name || '').toLowerCase().includes(name));
    if (!match) { unresolved.push(item.name); continue; }
    resolved.push({ integration_code: String(match.integration_code), desc_item: match.name, quantity: toNumberOrOne(item.quantity), unit_price: Number(match.unit_price || 0) });
  }
  return { resolved, unresolved };
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

function fallbackText(runtime, action, tx, missing) {
  if (action === 'WELCOME') return `Ola! Eu sou ${runtime.agentName}. Posso ajudar com um novo pedido ou tirar duvidas.`;
  if (action === 'ASK_FIELD_CONFIRMATION') {
    const field = (missing || [])[0];
    if (!field) return 'Pode confirmar esse dado?';
    return `Confirma ${fieldConfirmationLabel(field)}: "${fieldConfirmationValue(tx, field)}"? Responda sim ou nao.`;
  }
  if (action === 'ASK_MISSING_FIELDS') {
    const first = (missing || [])[0];
    const map = {
      customer_name: 'Para começar, qual é o seu nome?',
      items: 'Quais itens e quantidades voce deseja?',
      notes: 'Deseja adicionar alguma observacao ou complemento? Se nao, responda "sem observacoes".',
      mode: 'Seu pedido é para retirada ou delivery?',
      payment: 'Qual forma de pagamento voce prefere: PIX ou cartao?',
      'address.street_name': 'Qual e o nome da rua para entrega?',
      'address.street_number': 'Qual e o numero do endereco?',
      'address.neighborhood': 'Qual e o bairro?',
      'address.city': 'Qual e a cidade?',
      'address.state': 'Qual e o estado (UF)?',
      'address.postal_code': 'Qual e o CEP com 8 digitos (sem traco)?',
    };
    return map[first] || 'Me passe os dados faltantes para continuar.';
  }
  if (action === 'ANSWER_AND_RESUME') {
    const next = fallbackText(runtime, 'ASK_MISSING_FIELDS', tx, missing);
    return `Respondendo sua pergunta rapidamente: posso ajudar com isso. Agora, ${next.charAt(0).toLowerCase()}${next.slice(1)}`;
  }
  if (action === 'ANSWER_AND_RESUME_CONFIRM') {
    const next = fallbackText(runtime, 'ASK_FIELD_CONFIRMATION', tx, missing);
    return `Respondendo sua pergunta rapidamente: posso ajudar com isso. Agora, ${next.charAt(0).toLowerCase()}${next.slice(1)}`;
  }
  if (action === 'ORDER_REVIEW') {
    const items = (tx.items || []).map((i) => `${i.quantity}x ${i.name}`).join(', ') || '-';
    const addr = tx.mode === 'DELIVERY'
      ? `${tx.address.street_name}, ${tx.address.street_number} - ${tx.address.neighborhood}, ${tx.address.city}/${tx.address.state}, CEP ${tx.address.postal_code}`
      : 'Retirada no local';
    return `Resumo do pedido:\nCliente: ${tx.customer_name || '-'}\nItens: ${items}\nObservacoes: ${tx.notes || '-'}\nTipo: ${tx.mode === 'TAKEOUT' ? 'Retirada' : 'Delivery'}\nEntrega: ${addr}\nPagamento: ${tx.payment || '-'}\nPode confirmar para eu enviar o pedido?`;
  }
  if (action === 'CREATE_ORDER_AND_WAIT_PAYMENT') return 'Pedido registrado. Agora aguardando confirmacao do pagamento PIX.';
  if (action === 'CREATE_ORDER_AND_CONFIRM' || action === 'PAYMENT_CONFIRMED') return 'Pedido confirmado com sucesso. Estamos preparando tudo.';
  if (action === 'PAYMENT_REMINDER') return 'Ainda nao identifiquei a confirmacao do pagamento. Assim que pagar, me avise com "paguei".';
  if (action === 'REQUEST_ADJUSTMENTS') return 'Perfeito, me diga o que deseja ajustar no pedido.';
  if (action === 'FLOW_CANCELLED') return 'Pedido cancelado. Se quiser, podemos iniciar um novo pedido.';
  if (action === 'BLOCK_NEW_ORDER_UNTIL_FINISH') return 'Existe um pedido confirmado em andamento. Posso ajudar com este pedido primeiro.';
  if (action === 'HUMAN_HANDOFF') return 'Entendi. Vou transferir voce para um atendente humano.';
  if (action === 'END_CONVERSATION') return 'Conversa encerrada.';
  return 'Nao entendi completamente. Pode me explicar de forma objetiva?';
}

async function generatorAgent({ runtime, conversation, classification, orchestratorResult, groupedText }) {
  const deterministic = {
    state: conversation.state,
    action: orchestratorResult.action,
    intent: classification.intent,
    missing: orchestratorResult.missing || [],
    transaction: conversation.transaction,
    userMessage: groupedText || '',
  };
  if (!openai) {
    return fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing);
  }
  try {
    const c = await openai.chat.completions.create({
      model: runtime.model,
      temperature: runtime.temperature,
      max_tokens: 260,
      messages: [
        {
          role: 'system',
          content: `Voce e ${runtime.agentName}. Tom: ${runtime.tone}. Regras: responda perguntas laterais brevemente e retome imediatamente a pergunta pendente do fluxo. Faça apenas 1 pergunta por resposta. Nao invente itens, valores ou regras. Nao finalize sem confirmacao explicita.`,
        },
        { role: 'user', content: JSON.stringify({ deterministic, summary: conversation.contextSummary, customPrompt: runtime.customPrompt }) },
      ],
    });
    const text = cleanText(c.choices?.[0]?.message?.content || '');
    return text || fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing);
  } catch (_) {
    return fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing);
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
  const classification = await classifierAgent({ runtime, conversation, groupedText: normalized.normalizedText || groupedText });
  const extracted = classification.requires_extraction ? await extractorAgent({ runtime, groupedText: normalized.normalizedText || groupedText }) : {};
  log('INFO', 'Ana: classification/extraction', {
    tenantId: runtime.id,
    phone: conversation.phone,
    state: conversation.state,
    intent: classification.intent,
    confidence: classification.confidence,
    requiresExtraction: classification.requires_extraction,
    extracted,
  });

  await maybeLoadCatalog(conversation, runtime, apiRequest, getEnvConfig, log);

  const previousState = conversation.state;
  const orchestratorResult = orchestrate({ runtime, conversation, classification, extracted, groupedText: normalized.normalizedText || groupedText });
  conversation.state = orchestratorResult.nextState;
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
    }
  }

  const reply = orchestratorResult.action === 'WELCOME'
    ? (() => {
      const firstMissing = (orchestratorResult.missing || [])[0];
      const hasPendingValue = firstMissing === 'items'
        ? Array.isArray(conversation.transaction.items) && conversation.transaction.items.length > 0
        : String(firstMissing || '').startsWith('address.')
          ? Boolean(cleanText(conversation.transaction.address?.[String(firstMissing).slice('address.'.length)]))
          : Boolean(cleanText(conversation.transaction[firstMissing]));
      const followUpAction = hasPendingValue ? 'ASK_FIELD_CONFIRMATION' : 'ASK_MISSING_FIELDS';
      const followUp = fallbackText(runtime, followUpAction, conversation.transaction, orchestratorResult.missing || []);
      return followUp ? `${runtime.greetingMessage} ${followUp}`.trim() : runtime.greetingMessage;
    })()
    : await generatorAgent({ runtime, conversation, classification, orchestratorResult, groupedText: normalized.normalizedText || groupedText });
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

  await maybeSummarize({ runtime, conversation });
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

async function handleWhatsAppMessage(phone, messageText, { apiRequest, getEnvConfig, log, tenant, rawMessage = null, instanceName = null, remoteJid = null, contactName = '', messageId = '', onSend = null }) {
  const runtime = tenantRuntime(tenant, { instance: instanceName || undefined });
  const customer = getCustomer(runtime.id, phone);
  const conversation = getConversation(phone, runtime.id);
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

module.exports = {
  handleWhatsAppMessage,
  getAgentSettings,
  setAgentSettings,
  getSession: getConversation,
  sessions: conversations,
  STATES,
  INTENTS,
};

