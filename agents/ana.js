'use strict';

const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { loadCompanyData } = require('../lib/company-data-mcp');
const { saveInboundMessage, saveOutboundMessage } = require('../lib/supabase-messages');
const { validateFinalOrder, recalculateTotal } = require('../lib/validators');
const { addItemToCart, removeItem, updateQuantity, setAddress, setPayment, findCatalogItem } = require('../lib/business-logic');
const { extractIntent: extractIntentSchema } = require('../lib/intent-extractor');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const BUFFER_WINDOW_MS = Number(process.env.MESSAGE_BUFFER_MS || 1000);
const SESSION_TTL = Number(process.env.CONVERSATION_TTL_MS || 60 * 60 * 1000);
const ACTIVE_FLOW_TTL = Number(process.env.CONVERSATION_ACTIVE_FLOW_TTL_MS || 30 * 60 * 1000);
const WAITING_PAYMENT_TTL = Number(process.env.CONVERSATION_WAITING_PAYMENT_TTL_MS || 15 * 60 * 1000);
const SUMMARY_EVERY_N_MESSAGES = Number(process.env.SUMMARY_EVERY_N_MESSAGES || 8);

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
  // Aliases de compatibilidade (código legado usa estes nomes)
  get COLLECTING_DATA() { return 'ADICIONANDO_ITEM'; },
  get WAITING_CONFIRMATION() { return 'FINALIZANDO'; },
};

// Mapa de transições válidas — cada estado lista os destinos permitidos
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

function isValidTransition(from, to) {
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : true; // permissivo para estados desconhecidos
}

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
const MAX_CUSTOMER_RECENT_MEMORY = 24;
const MAX_PROMPT_MEMORY_ITEMS = 8;
const MAX_HISTORY_TO_MODEL = 12;  // Máximo de mensagens recentes enviadas ao modelo

const nowISO = () => new Date().toISOString();
const cleanText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const toNumberOrOne = (v) => { const n = parseInt(String(v || '').trim(), 10); return Number.isFinite(n) && n > 0 ? n : 1; };
const detectYes = (t) => {
  const x = cleanText(t).toLowerCase();
  if (/^sim\b/.test(x) || /\btudo\s*certo\b/.test(x) || /\best[aá]\s*certo\b/.test(x)) return true;
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
const normalizeForMatch = (v) => String(v || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\b(\d+)\s*lt\b/g, '$1l')
  .replace(/\b(\d+)\s*lts\b/g, '$1l')
  .replace(/\brefri\b/g, 'refrigerante')
  .replace(/\brefri\s+2l\b/g, 'refrigerante 2l')
  .replace(/\bcoca\s+lata\b/g, 'coca cola lata')
  .replace(/\bvalca\b/g, 'valsa')
  .replace(/\bvalsaa\b/g, 'valsa')
  .replace(/\bvalsa\b/g, 'valsa')
  .replace(/\s+/g, ' ')
  .trim();
const tokenizeNormalized = (v) => normalizeForMatch(v).split(' ').filter(Boolean);
const singularizeToken = (token) => {
  let t = String(token || '').trim().toLowerCase();
  if (!t) return t;
  if (/oes$/.test(t)) return t.slice(0, -3) + 'ao';
  if (/aes$/.test(t)) return t.slice(0, -3) + 'ao';
  if (/is$/.test(t)) return t.slice(0, -2) + 'il';
  if (/res$/.test(t)) return t.slice(0, -1);
  if (/es$/.test(t) && t.length > 4) return t.slice(0, -2);
  if (/s$/.test(t) && t.length > 3) return t.slice(0, -1);
  return t;
};
const canonicalTokens = (v) => tokenizeNormalized(v).map(singularizeToken).filter(Boolean);

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

  const streetMatch = sanitized.match(/\b(rua|av(?:enida)?|alameda|travessa|quadra|qd)\s+([^,]+)/i);
  if (streetMatch) out.street_name = cleanText(`${streetMatch[1]} ${streetMatch[2]}`);

  if (/\b(sem\s*n[uú]mero|s\/n)\b/i.test(sanitized)) out.street_number = 'S/N';
  const qdLtMatch = sanitized.match(/\b(qd\.?\s*\d+\s*lt\.?\s*\d+)\b/i);
  if (!out.street_number && qdLtMatch) out.street_number = cleanText(qdLtMatch[1]).replace(/\s+/g, ' ');
  const numberMatch = sanitized.match(/\b(?:n(?:[úu]mero)?|num|casa)\s*[:#-]?\s*([0-9]{1,6}|s\/n)\b/i);
  if (!out.street_number && numberMatch) out.street_number = String(numberMatch[1]).toUpperCase() === 'S/N' ? 'S/N' : cleanText(numberMatch[1]);
  if (!out.street_number && /\b0\b/.test(lower) && /(n[uú]mero|num|casa|sem numero)/i.test(sanitized)) out.street_number = 'S/N';

  const neighborhoodMatch = sanitized.match(/\b(bairro|setor|jd|jardim|parque)\s+([^,]+)/i);
  if (neighborhoodMatch) {
    const prefix = cleanText(neighborhoodMatch[1]).toLowerCase();
    const base = cleanText(neighborhoodMatch[2]).replace(/\b(no|na)\s+(dinheiro|pix|cart[aã]o|cartao|cr[eé]dito|debito|d[eé]bito)\b.*/i, '').trim();
    if (prefix === 'bairro') out.neighborhood = base;
    else if (base.toLowerCase().startsWith(prefix)) out.neighborhood = base;
    else out.neighborhood = cleanText(`${prefix} ${base}`);
  }

  const cityUfSlash = sanitized.match(/\b([A-Za-zÀ-ÿ\s]+)\s*\/\s*([A-Za-z]{2})\b/);
  if (cityUfSlash) {
    out.city = cleanText(cityUfSlash[1]);
    out.state = normalizeStateUF(cityUfSlash[2]);
  } else {
    const cityUfInline = sanitized.match(/\b([A-Za-zÀ-ÿ\s]+)\s+([A-Za-z]{2})\b$/);
    if (cityUfInline) {
      out.city = cleanText(cityUfInline[1]);
      out.state = normalizeStateUF(cityUfInline[2]);
    }
  }

  const cep = sanitized.match(/\b\d{5}-?\d{3}\b|\b\d{8}\b/);
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
    } catch (_) { }
  }, 500);
}
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of (parsed.customers || [])) customers.set(k, v);
    for (const [k, v] of (parsed.conversations || [])) conversations.set(k, v);
  } catch (_) { }
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
    llmFirstResponse: tenant?.agent?.llmFirstResponse !== false
      && String(process.env.ANA_LLM_FIRST_RESPONSE || 'true').toLowerCase() !== 'false',
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
      recentContext: [],
      recentContextSummary: '',
    };
    customers.set(key, c);
  }
  if (typeof c.totalOrders !== 'number') c.totalOrders = 0;
  if (typeof c.name !== 'string') c.name = '';
  if (typeof c.lastOrderSummary !== 'string') c.lastOrderSummary = '';
  if (typeof c.lastOrderSnapshot === 'undefined') c.lastOrderSnapshot = null;
  if (!Array.isArray(c.recentContext)) c.recentContext = [];
  if (typeof c.recentContextSummary !== 'string') c.recentContextSummary = '';
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
    itemsPhaseComplete: false,
    awaitingRepeatChoice: false,
    lastRepeatOfferDate: '',
    repeatPreview: '',
    orderStoredForCustomer: false,
    greeted: false,
    greetedDate: '',
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
  if (typeof conv.itemsPhaseComplete !== 'boolean') conv.itemsPhaseComplete = false;
  if (typeof conv.awaitingRepeatChoice !== 'boolean') conv.awaitingRepeatChoice = false;
  if (typeof conv.lastRepeatOfferDate !== 'string') conv.lastRepeatOfferDate = '';
  if (typeof conv.repeatPreview !== 'string') conv.repeatPreview = '';
  if (typeof conv.orderStoredForCustomer !== 'boolean') conv.orderStoredForCustomer = false;
  if (typeof conv.greetedDate !== 'string') conv.greetedDate = '';
  if (
    !conv.itemsPhaseComplete
    && Array.isArray(conv.transaction?.items) && conv.transaction.items.length > 0
    && (
      Boolean(cleanText(conv.transaction?.mode))
      || Boolean(cleanText(conv.transaction?.payment))
      || [STATES.WAITING_CONFIRMATION, STATES.WAITING_PAYMENT, STATES.CONFIRMED].includes(conv.state)
    )
  ) {
    conv.itemsPhaseComplete = true;
  }
  conv.lastActivityAt = nowISO();
  return conv;
}

function appendMessage(conv, role, content, metadata = {}) {
  conv.messages.push({ role, content, metadata, at: nowISO() });
  if (conv.messages.length > 30) conv.messages = conv.messages.slice(-30);
  conv.messageCount = (conv.messageCount || 0) + 1;
  conv.lastActivityAt = nowISO();
}

function appendCustomerMemory(customer, role, content, metadata = {}, state = '') {
  if (!customer) return;
  const text = cleanText(content);
  if (!text) return;
  if (!Array.isArray(customer.recentContext)) customer.recentContext = [];
  customer.recentContext.push({
    role: role === 'assistant' ? 'assistant' : 'user',
    content: text.slice(0, 400),
    action: cleanText(metadata?.action || ''),
    state: cleanText(state || ''),
    at: nowISO(),
  });
  if (customer.recentContext.length > MAX_CUSTOMER_RECENT_MEMORY) {
    customer.recentContext = customer.recentContext.slice(-MAX_CUSTOMER_RECENT_MEMORY);
  }
}

function isNonInformativeFieldValue(value) {
  const x = normalizeForMatch(value);
  if (!x) return true;
  return /\b(ja falei|jah falei|ja informei|ja passei|como ja falei|eu ja falei|mesmo de antes|o mesmo|isso ai|isso ae|isso mesmo)\b/.test(x);
}

function sanitizeAssistantReply({ reply, conversation, action }) {
  let text = String(reply || '').trim();
  if (!text) return '';

  const today = nowISO().slice(0, 10);
  const alreadyPresentedToday = cleanText(conversation?.greetedDate || '') === today;
  const alreadyPresented = Boolean(conversation?.presented);
  const allowIntroduction = !alreadyPresentedToday && !alreadyPresented && action === 'WELCOME';
  if (!allowIntroduction) {
    // Remove todas as variações de introdução/reapresentação
    text = text
      // "Olá, X! Sou a Ana, assistente virtual da Y."
      .replace(/(?:^|\n)\s*ol[aá][^\n]{0,80}sou a\s+\w+[^\n]{0,120}assistente[^\n]{0,120}[.!?]?\s*/gi, '')
      // "Sou a Ana, assistente virtual da Y."
      .replace(/(?:^|\n)\s*sou a\s+\w+[^\n]{0,120}assistente[^\n]{0,120}[.!?]?\s*/gi, '')
      // "Aqui é a Ana, assistente virtual da Y."
      .replace(/(?:^|\n)\s*aqui [eé] a\s+\w+[^\n]{0,120}assistente[^\n]{0,120}[.!?]?\s*/gi, '')
      // "Olá! Sou a Ana." (sem empresa)
      .replace(/(?:^|\n)\s*ol[aá][!,.]?\s*sou a\s+\w+[.!]?\s*/gi, '')
      // "Olá, X! 😊 Sou a Ana" (com emoji)
      .replace(/(?:^|\n)\s*ol[aá],?\s+\w+[!.]?\s*[😊🤗👋]+\s*sou a\s+\w+[^\n]{0,120}[.!?]?\s*/gi, '')
      // Menção a "Mais Sistem Automação Comercial" em qualquer posição
      .replace(/mais\s*sistem[^.!?\n]{0,80}[.!?]?/gi, '')
      .trim();
  }

  const normalizedSeen = new Set();
  const uniqueLines = [];
  for (const line of text.split('\n')) {
    const trimmedLine = line.trim();
    // Preservar linhas vazias como espaçamento entre seções
    if (!trimmedLine) {
      // Evitar mais de 2 linhas vazias consecutivas
      if (uniqueLines.length === 0 || uniqueLines[uniqueLines.length - 1] !== '') {
        uniqueLines.push('');
      }
      continue;
    }
    const key = normalizeForMatch(trimmedLine);
    if (!key) { uniqueLines.push(trimmedLine); continue; }
    if (normalizedSeen.has(key)) continue;
    normalizedSeen.add(key);
    uniqueLines.push(trimmedLine);
  }
  text = uniqueLines.join('\n').trim();

  return text || String(reply || '').trim();
}

function applyRecentUserContextToExtraction({ conversation, runtime, extracted }) {
  if (runtime.segment !== 'restaurant') return;
  const recentUserTexts = (conversation?.messages || [])
    .filter((m) => m?.role === 'user')
    .slice(-8)
    .map((m) => cleanText(m?.content || ''))
    .filter(Boolean);
  if (!recentUserTexts.length) return;

  const tx = conversation.transaction || {};
  if (!extracted.address || typeof extracted.address !== 'object') extracted.address = {};

  if (!cleanText(extracted.mode) && !cleanText(tx.mode)) {
    for (let idx = recentUserTexts.length - 1; idx >= 0; idx--) {
      const msg = recentUserTexts[idx];
      const low = msg.toLowerCase();
      if (/retirada|retirar|balcao/.test(low)) { extracted.mode = 'TAKEOUT'; break; }
      if (/entreg|delivery/.test(low)) { extracted.mode = 'DELIVERY'; break; }
      const addr = extractAddressFromText(msg);
      if (cleanText(addr.street_name) || cleanText(addr.neighborhood)) { extracted.mode = 'DELIVERY'; break; }
    }
  }

  if (!cleanText(extracted.payment) && !cleanText(tx.payment)) {
    for (let idx = recentUserTexts.length - 1; idx >= 0; idx--) {
      const low = recentUserTexts[idx].toLowerCase();
      if (/(pix|piz|piks|piquis)\b/.test(low)) { extracted.payment = 'PIX'; break; }
      if (/(cartao|cartão|cr[eé]dito|d[eé]bito)/.test(low)) { extracted.payment = 'CARD'; break; }
      if (/dinheiro|especie|espécie|cash|nota/.test(low)) { extracted.payment = 'CASH'; break; }
    }
  }

  const needsAddress = [
    'street_name', 'street_number', 'neighborhood',
  ].some((k) => !cleanText(extracted.address?.[k]) && !cleanText(tx.address?.[k]));
  const modeCandidate = cleanText(extracted.mode || tx.mode);
  if (needsAddress && (!modeCandidate || modeCandidate === 'DELIVERY')) {
    for (let idx = recentUserTexts.length - 1; idx >= 0; idx--) {
      const addr = extractAddressFromText(recentUserTexts[idx]);
      for (const key of ['street_name', 'street_number', 'neighborhood', 'city', 'state', 'postal_code']) {
        if (!cleanText(extracted.address?.[key]) && !cleanText(tx.address?.[key]) && cleanText(addr?.[key])) {
          extracted.address[key] = cleanText(addr[key]);
        }
      }
    }
  }
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
  // Não extrair itens de respostas curtas, negativas ou confirmatórias
  if (detectNo(message) || detectItemsPhaseDone(message) || detectYes(message)) return [];
  if (text.split(/\s+/).length <= 2 && !/\d/.test(text)) return []; // texto muito curto sem números
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
      const chunkTokens = tokenizeNormalized(chunk);
      const nameTokens = tokenizeNormalized(name);
      const fuzzyOverlap = nameTokens.filter((t) => chunkTokens.some((ct) => isNearToken(t, ct))).length;
      const fuzzyRatio = fuzzyOverlap / Math.max(nameTokens.length, chunkTokens.length, 1);
      if (!chunkInName && !nameInChunk && fuzzyRatio < 0.6) continue;
      const score = chunkInName || nameInChunk
        ? Math.min(name.length, chunk.length)
        : Math.round(fuzzyRatio * 100);
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
    if (/^(so isso|só isso|somente isso|apenas isso|isso|isso mesmo|e isso|nada mais|pedido completo|fechar pedido|pode fechar)$/i.test(chunk)) continue;
    if (/\b(rua|av(?:enida)?|bairro|cep|numero|n[úu]mero|pix|cart[aã]o|retirada|delivery|dinheiro|especie|espécie|cash)\b/i.test(chunk)) continue;
    if (/\b(horario|horário|funcionamento|endereco|endereço|taxa|taxas|cardapio|cardápio|preço|preco|quanto custa|quanto fica|como funciona|qual é|qual e|quais s[aã]o|informacao|informação)\b/i.test(chunk)) continue;
    if (chunk.trim().endsWith('?')) continue; // perguntas não são itens

    let quantity = 1;
    const qtyPrefix = chunk.match(/^\s*(\d+|um|uma|dois|duas|tres|quatro|cinco)\b/i);
    if (qtyPrefix) {
      const q = qtyPrefix[1].toLowerCase();
      quantity = Number(q) || qtyWords[q] || 1;
      chunk = cleanText(chunk.slice(qtyPrefix[0].length));
    } else {
      const qtyAnywhere = chunk.match(/\b(\d+|um|uma|dois|duas|tres|quatro|cinco)\b/i);
      if (qtyAnywhere) {
        const q = qtyAnywhere[1].toLowerCase();
        quantity = Number(q) || qtyWords[q] || 1;
        chunk = cleanText(chunk.replace(qtyAnywhere[0], ' '));
      }
      const qtyInline = chunk.match(/\b(\d+)\s*x\b/i);
      if (qtyInline) {
        quantity = Math.max(1, Number(qtyInline[1]) || 1);
        chunk = cleanText(chunk.replace(/\b\d+\s*x\b/i, ' '));
      }
    }

    const cleanedName = cleanText(
      chunk
        .replace(/^(quero|gostaria(?:\s+de)?|pedido|me\s+ve|me\s+v[eê]|me\s+manda|faltou|inclui|inclua|adiciona|adicione|acrescenta|acrescente)\s+/i, '')
        .replace(/\b(faltou|inclui|inclua|adiciona|adicione|acrescenta|acrescente|mais|tambem|também|so|só)\b/gi, ' ')
        .replace(/\b(os|as|o|a|uns|umas|de|do|da|dos|das)\b/gi, ' ')
        .replace(/\b(para|pra)\s+(entrega|delivery|retirada|retirar)\b/gi, '')
        .replace(/\b(no|na)\s+(pix|dinheiro|cart[aã]o|cartao|credito|d[eé]bito|debito)\b/gi, '')
        .replace(/\s+/g, ' ')
    );

    if (!cleanedName || cleanedName.length < 2) continue;
    items.push({ name: cleanedName, quantity: Math.max(1, quantity) });
  }

  // Deduplica itens com mesmo nome — mantém a ÚLTIMA quantidade mencionada (set, não soma)
  const merged = new Map();
  for (const item of items) {
    const key = normalizeForMatch(item.name);
    // Sempre sobrescreve: a última menção é a fonte de verdade
    merged.set(key, { name: cleanText(item.name), quantity: toNumberOrOne(item.quantity) });
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

// ── Detecção determinística de correção (REGEX > LLM) ──────────────────────
function detectCorrection(text) {
  const lower = cleanText(text).toLowerCase();
  // Padrões de correção de quantidade
  const qtyCorrection = lower.match(
    /(?:somente|apenas|só|so)\s+(?:um|uma|1)\s*(.*)/i
  ) || lower.match(
    /(?:não|nao)\s+(?:é|e)\s+\d+.+(?:é|e)\s+(?:somente|apenas|só|so)?\s*(?:um|uma|1)/i
  ) || lower.match(
    /(?:corrige|corrigir|mudar?|alterar?)\s+(?:para|pra)\s+(\d+)/i
  ) || lower.match(
    /(?:é|e)\s+(?:somente|apenas|só|so)\s+(?:um|uma|1)\s*(.*)/i
  );
  // Padrões genéricos de erro
  const isError = /\b(faltou|corrige|corrigir|ajusta|ajustar|mudar|alterar|ta errado|tá errado|está errado|errado|errei|incorreto|troquei|trocar|troca|errei|n[aã]o [eé] isso)\b/i.test(lower);
  if (qtyCorrection) {
    // Extrair nova quantidade da correção
    const numMatch = lower.match(/(?:somente|apenas|só|so)\s+(\d+|um|uma|dois|duas|tres|quatro|cinco)/i)
      || lower.match(/(?:corrige|mudar?|alterar?)\s+(?:para|pra)\s+(\d+)/i);
    const qtyWords = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5 };
    const newQty = numMatch ? (Number(numMatch[1]) || qtyWords[numMatch[1]?.toLowerCase()] || 1) : 1;
    return { isCorrection: true, type: 'QTY_UPDATE', newQty };
  }
  if (isError) return { isCorrection: true, type: 'GENERIC_ERROR', newQty: null };
  return { isCorrection: false, type: null, newQty: null };
}

// ── Normalização determinística de quantidade (barreira pós-extração) ────────
function normalizeQuantityFromText(items, originalText) {
  if (!Array.isArray(items) || !items.length) return items;
  const text = cleanText(originalText).toLowerCase();
  // Se texto contém número explícito > 1 OU palavra de multiplicidade → confiar na extração
  const hasExplicitMultiple = /\b([2-9]|\d{2,})\b/.test(text);
  const hasWordMultiple = /\b(dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove|dez)\b/.test(text);
  if (hasExplicitMultiple || hasWordMultiple) return items;
  // Sem número explícito > 1 → TODOS os itens são qty=1 (nunca inferir multiplicidade)
  return items.map(it => ({ ...it, quantity: 1 }));
}

async function classifierAgent({ runtime, conversation, groupedText }) {
  const lower = groupedText.toLowerCase();
  if (/atendente|humano|pessoa/.test(lower)) return { intent: INTENTS.HUMANO, requires_extraction: false, handoff: true, confidence: 1 };

  // CORREÇÃO: regex ANTES do classificador LLM — nunca deixar modelo decidir isso
  const correction = detectCorrection(groupedText);
  if (correction.isCorrection) {
    return { intent: 'CORRECAO', requires_extraction: false, handoff: false, confidence: 0.95, correction };
  }

  if (/\b(horario|funcionamento|endereco|endereço|pagamento|formas de pagamento|valor|pre[cç]o|card[aá]pio|cardapio|menu)\b/.test(lower)) {
    return { intent: INTENTS.CONSULTA, requires_extraction: false, handoff: false, confidence: 0.95 };
  }
  // "Tem X?" = pergunta de disponibilidade no cardápio, não pedido
  const isAvailabilityQuestion = /^(tem\s|existe\s|vocês?\s+tem\b|vocês?\s+têm\b)/.test(lower.trim())
    || (/\b(tem|existe|há|vocês?\s+têm)\b/.test(lower) && /\?/.test(groupedText));
  if (isAvailabilityQuestion) return { intent: INTENTS.CONSULTA, requires_extraction: false, handoff: false, confidence: 0.9 };
  // Sinais claros de pedido (inclui nomes de alimentos comuns)
  const hasOrderSignal = /quero|quer(ia|o)\b|pedi(do|r)|comprar|marmita|pizza|lanche|hamburguer|hambúrguer|burger|frango|carne|prato|suco|refri|coca|cerveja|agua|acai|açaí|esfiha|pastel|batata|sobremesa|salada|wrap|porção|porcao|combo|tapioca|coxinha|empada|torta|bolo|sorvete|salgado|sanduiche|sanduíche|x-/.test(lower);
  const hasGreetingSignal = /^(oi|olá|ola|bom dia|boa tarde|boa noite)[\s!,.]*$/.test(lower.trim());
  if (hasOrderSignal) return { intent: INTENTS.NOVO_PEDIDO, requires_extraction: true, handoff: false, confidence: hasGreetingSignal ? 0.9 : 0.85 };
  if (hasGreetingSignal) return { intent: INTENTS.SAUDACAO, requires_extraction: false, handoff: false, confidence: 0.85 };
  if (/pix|cartao|cartão|paguei|pagamento/.test(lower)) return { intent: INTENTS.PAGAMENTO, requires_extraction: true, handoff: false, confidence: 0.7 };
  if (/cancel/.test(lower)) return { intent: INTENTS.CANCELAMENTO, requires_extraction: false, handoff: false, confidence: 0.7 };

  // Respostas curtas negativas/confirmatórias NÃO devem disparar extração de itens
  if (detectNo(groupedText) || detectItemsPhaseDone(groupedText)) {
    return { intent: INTENTS.GERENCIAMENTO, requires_extraction: false, handoff: false, confidence: 0.85 };
  }

  // Quando já estamos coletando dados e a mensagem não é consulta/cancelamento,
  // tratar como gerenciamento de pedido com extração ativa
  const isCollecting = [
    STATES.ADICIONANDO_ITEM, STATES.CONFIRMANDO_CARRINHO,
    STATES.COLETANDO_ENDERECO, STATES.COLETANDO_PAGAMENTO,
    STATES.FINALIZANDO, STATES.WAITING_PAYMENT,
  ].includes(conversation.state);
  if (isCollecting) {
    return { intent: INTENTS.GERENCIAMENTO, requires_extraction: true, handoff: false, confidence: 0.6 };
  }

  if (!openai) {
    return { intent: INTENTS.CONSULTA, requires_extraction: false, handoff: false, confidence: 0.5 };
  }
  try {
    const c = await openai.chat.completions.create({
      model: runtime.model,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: 'Classifique a intencao e retorne somente JSON com intent,requires_extraction,handoff,confidence. Intents: SAUDACAO,NOVO_PEDIDO,REPETIR,CONSULTA,GERENCIAMENTO,CANCELAMENTO,PAGAMENTO,SUPORTE,HUMANO,SPAM.' },
        { role: 'user', content: JSON.stringify({ state: conversation.state, segment: runtime.segment, summary: conversation.contextSummary, message: groupedText }) },
      ],
    });
    const p = JSON.parse(c.choices?.[0]?.message?.content || '{}');
    const intent = INTENTS[p.intent] ? p.intent : INTENTS.GERENCIAMENTO;
    return { intent, requires_extraction: Boolean(p.requires_extraction), handoff: Boolean(p.handoff), confidence: Number(p.confidence || 0.5) };
  } catch (_) {
    return { intent: INTENTS.GERENCIAMENTO, requires_extraction: true, handoff: false, confidence: 0.4 };
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
    mode: /retirada|retirar|balcao/.test(lower) ? 'TAKEOUT' : (/entreg|delivery/.test(lower) ? 'DELIVERY' : null),
    payment: /(pix|piz|piks|piquis)\b/.test(lower) ? 'PIX'
      : (/(cartao|cartão|cr[eé]dito|d[eé]bito)/.test(lower) ? 'CARD'
        : (/dinheiro|especie|espécie|cash|nota/.test(lower) ? 'CASH' : null)),
    customer_name: null,
    notes: null,
    items: [],
    address: {},
  };
  if (/\b(nao|não)\s+tem\s+num(?:ero)?\b/i.test(groupedText)) out.address.street_number = 'S/N';

  const nameMatch = groupedText.match(/(?:meu nome (?:é|e)|sou|chamo-me|me chamo)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,60})/i);
  if (nameMatch) out.customer_name = cleanText(nameMatch[1]);
  if (/sem observa|sem complemento|sem adicional/i.test(lower)) out.notes = 'Sem observações';
  const obsMatch = groupedText.match(/(?:obs|observa(?:ç|c)[aã]o|complemento)\s*[:\-]\s*(.{3,200})/i);
  if (obsMatch) out.notes = cleanText(obsMatch[1]);

  Object.assign(out.address, extractAddressFromText(groupedText));
  if (!out.mode && (cleanText(out.address?.street_name) || cleanText(out.address?.neighborhood))) out.mode = 'DELIVERY';
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
      const existing = conv.transaction.items.find((i) => {
        if (cleanText(item.integration_code) && cleanText(i.integration_code)) {
          return cleanText(i.integration_code) === cleanText(item.integration_code);
        }
        return i.name.toLowerCase() === name.toLowerCase();
      });
      if (existing) {
        const before = Number(existing.quantity || 0);
        // Por padrão: SET (fonte de verdade é a mensagem atual)
        // Somente SOMA se o item tiver flag incremental ("mais 1", "adiciona", "faltou")
        if (item.incremental) existing.quantity += toNumberOrOne(item.quantity);
        else existing.quantity = toNumberOrOne(item.quantity);
        if (Number(existing.quantity || 0) !== before) changed = true;
        // Preenche código e preço se ainda estavam vazios (item normalizado com catálogo)
        if (!existing.integration_code && item.integration_code) existing.integration_code = String(item.integration_code);
        if (!existing.unit_price && Number(item.unit_price || 0)) existing.unit_price = Number(item.unit_price);
      } else {
        conv.transaction.items.push({
          name,
          quantity: toNumberOrOne(item.quantity),
          integration_code: item.integration_code || null,
          unit_price: Number(item.unit_price || 0) || null,
        });
        changed = true;
      }
    }
    if (changed) {
      markFieldChanged(conv, 'items');
      conv.upsellDone = false;
      conv.itemsPhaseComplete = false;
    }
  }

  if (extracted.address && typeof extracted.address === 'object') {
    for (const [k, v] of Object.entries(extracted.address)) {
      const next = cleanText(v);
      if (!next) continue;
      if (isNonInformativeFieldValue(next)) continue;
      if (cleanText(conv.transaction.address?.[k]) !== next) {
        conv.transaction.address[k] = next;
        markFieldChanged(conv, `address.${k}`);
      }
    }
  }
  if (
    !cleanText(conv.transaction.mode)
    && (cleanText(conv.transaction.address?.street_name) || cleanText(conv.transaction.address?.neighborhood))
  ) {
    conv.transaction.mode = 'DELIVERY';
    markFieldChanged(conv, 'mode');
  }
}

function restaurantMissingFields(runtime, tx, confirmed = {}, options = {}) {
  const missing = [];
  const hasItems = Array.isArray(tx.items) && tx.items.length > 0;
  const itemsPhaseComplete = options.itemsPhaseComplete !== false;
  const hasAddressHint = Boolean(cleanText(tx.address?.street_name) || cleanText(tx.address?.neighborhood));
  if (!hasItems) missing.push('items');
  if (hasItems && tx.items.some((i) => !Number(i.quantity) || Number(i.quantity) <= 0)) missing.push('items');
  if (hasItems && !itemsPhaseComplete) return Array.from(new Set(missing.concat('items')));
  if (!tx.mode && !hasAddressHint) missing.push('mode');
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
    notes: 'observações do pedido',
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
  if (field === 'mode') return tx.mode === 'TAKEOUT' ? 'retirada' : 'entrega';
  if (field === 'payment') return tx.payment === 'PIX' ? 'PIX' : (tx.payment === 'CARD' ? 'cartão' : (tx.payment === 'CASH' ? 'dinheiro' : (tx.payment || '-')));
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
  conversation.itemsPhaseComplete = true;
}

function orchestrate({ runtime, conversation, customer, classification, extracted, groupedText }) {
  if (runtime.segment === 'restaurant') {
    // Só limpa items do merge quando o extractor NÃO encontrou nenhum item na mensagem.
    const extractedHasItems = Array.isArray(extracted?.items) && extracted.items.length > 0;
    const mergeExtracted = (classification.intent === INTENTS.CONSULTA && !extractedHasItems)
      ? { ...extracted, items: [] }
      : (extracted || {});
    mergeRestaurantTransaction(conversation, mergeExtracted);
  }
  if (runtime.segment === 'restaurant') enrichAddressWithCompanyDefaults(conversation);
  if (runtime.segment === 'restaurant') conversation.pendingFieldConfirmation = null;

  // Recalcular total do carrinho após cada merge
  if (runtime.segment === 'restaurant' && Array.isArray(conversation.transaction?.items)) {
    const amounts = calculateOrderAmounts(conversation.transaction, conversation);
    conversation.transaction.total_amount = amounts.total;
  }

  const handoff = classification.handoff
    || classification.intent === INTENTS.HUMANO
    || Number(classification.confidence || 0) < 0.45
    || /(raiva|horrivel|horrible|péssimo|pessimo|absurdo|ridículo|ridiculo|lamentável|lamentavel|inacreditável|inacreditavel|vergonha|uma merda|tô bravo|to bravo|tô com raiva|to com raiva|que saco|tô puto|to puto|não acredito|nao acredito|péssimo atendimento|pessimo atendimento)/i.test(groupedText)
    || (conversation.consecutiveFailures || 0) >= 3;

  if (handoff) return { nextState: STATES.HUMAN_HANDOFF, action: 'HUMAN_HANDOFF', missing: [] };

  // Normalizar estado legado para novo mapa
  let s = conversation.state;
  if (s === 'COLLECTING_DATA') s = STATES.ADICIONANDO_ITEM;
  if (s === 'WAITING_CONFIRMATION') s = STATES.FINALIZANDO;
  conversation.state = s;

  const i = classification.intent;
  const yes = detectYes(groupedText);
  const no = detectNo(groupedText);
  const hasQuestion = /\?/.test(groupedText) || /\b(qual|quando|como|onde|que horas|card[aá]pio|pre[cç]o)\b/i.test(groupedText);

  if (runtime.segment === 'clinic') {
    if (s === STATES.INIT && i === INTENTS.NOVO_PEDIDO) return { nextState: STATES.ADICIONANDO_ITEM, action: 'CLINIC_COLLECT', missing: ['service', 'date', 'time'] };
    if (s === STATES.FINALIZANDO && yes) return { nextState: STATES.CONFIRMED, action: 'CLINIC_CONFIRMED', missing: [] };
    if (s === STATES.FINALIZANDO && no) return { nextState: STATES.ADICIONANDO_ITEM, action: 'REQUEST_ADJUSTMENTS', missing: [] };
    return { nextState: s, action: s === STATES.INIT ? 'WELCOME' : 'ASK_MISSING_FIELDS', missing: ['service', 'date', 'time'] };
  }

  // ── INIT ──────────────────────────────────────────────────────────────
  if (s === STATES.INIT) {
    const today = nowISO().slice(0, 10);
    const hasPreviousOrder = Boolean(customer?.lastOrderSnapshot && Array.isArray(customer.lastOrderSnapshot.items) && customer.lastOrderSnapshot.items.length);

    if (conversation.awaitingRepeatChoice && hasPreviousOrder) {
      if (yes) {
        applySnapshotToConversation(conversation, customer.lastOrderSnapshot);
        conversation.awaitingRepeatChoice = false;
        return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
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
            nextState: STATES.ADICIONANDO_ITEM,
            action: hasQuestion ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION',
            missing: [conversation.pendingFieldConfirmation],
          };
        }
        const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
          itemsPhaseComplete: conversation.itemsPhaseComplete,
        });
        return { nextState: STATES.ADICIONANDO_ITEM, action: 'ASK_MISSING_FIELDS', missing };
      }
      conversation.lastGreetingDate = today;
      const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
        itemsPhaseComplete: conversation.itemsPhaseComplete,
      });
      return { nextState: STATES.ADICIONANDO_ITEM, action: 'WELCOME', missing };
    }
    if (i === INTENTS.NOVO_PEDIDO) {
      const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
        itemsPhaseComplete: conversation.itemsPhaseComplete,
      });
      return missing.length ? { nextState: STATES.ADICIONANDO_ITEM, action: 'ASK_MISSING_FIELDS', missing } : { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
    }
    if (i === INTENTS.SPAM) return { nextState: STATES.CLOSED, action: 'END_CONVERSATION', missing: [] };
    if (conversation.pendingFieldConfirmation) {
      return {
        nextState: STATES.ADICIONANDO_ITEM,
        action: hasQuestion ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION',
        missing: [conversation.pendingFieldConfirmation],
      };
    }
    const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
      itemsPhaseComplete: conversation.itemsPhaseComplete,
    });
    return { nextState: STATES.ADICIONANDO_ITEM, action: hasQuestion ? 'ANSWER_AND_RESUME' : 'ASK_MISSING_FIELDS', missing };
  }

  // ── ADICIONANDO_ITEM (ex-COLLECTING_DATA) ─────────────────────────────
  if (s === STATES.ADICIONANDO_ITEM || s === STATES.MENU || s === STATES.CONFIRMANDO_CARRINHO || s === STATES.COLETANDO_ENDERECO || s === STATES.COLETANDO_PAGAMENTO) {
    const explicitCancel = /\b(cancela|cancelar|deixa quieto|desisti|desisto|aborta|encerrar pedido)\b/i.test(groupedText);
    if (explicitCancel) {
      conversation.transaction = { mode: '', customer_name: '', items: [], notes: '', address: { street_name: '', street_number: '', neighborhood: '', city: '', state: '', postal_code: '' }, payment: '', total_amount: 0, order_id: null };
      conversation.confirmed = {};
      conversation.pendingFieldConfirmation = null;
      conversation.upsellDone = false;
      conversation.itemsPhaseComplete = false;
      return { nextState: STATES.INIT, action: 'FLOW_CANCELLED', missing: [] };
    }
    if (i === INTENTS.CANCELAMENTO) {
      conversation.transaction = { mode: '', customer_name: '', items: [], notes: '', address: { street_name: '', street_number: '', neighborhood: '', city: '', state: '', postal_code: '' }, payment: '', total_amount: 0, order_id: null };
      conversation.confirmed = {};
      conversation.pendingFieldConfirmation = null;
      conversation.upsellDone = false;
      conversation.itemsPhaseComplete = false;
      return { nextState: STATES.INIT, action: 'FLOW_CANCELLED', missing: [] };
    }
    if (conversation.pendingFieldConfirmation) {
      const field = conversation.pendingFieldConfirmation;
      if (field === 'items' && Array.isArray(extracted?.items) && extracted.items.length) {
        conversation.pendingFieldConfirmation = null;
      }
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
        return { nextState: STATES.ADICIONANDO_ITEM, action: 'ASK_MISSING_FIELDS', missing: [field] };
      } else {
        return { nextState: STATES.ADICIONANDO_ITEM, action: hasQuestion ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION', missing: [field] };
      }
    }

    const hasItems = Array.isArray(conversation.transaction.items) && conversation.transaction.items.length > 0;
    const hasNewItemsInMessage = Array.isArray(extracted?.items) && extracted.items.length > 0;
    const finishedSelectingItems = detectItemsPhaseDone(groupedText);
    if (hasNewItemsInMessage) conversation.itemsPhaseComplete = false;
    if (hasItems && !conversation.itemsPhaseComplete && finishedSelectingItems && !hasNewItemsInMessage) {
      conversation.itemsPhaseComplete = true;
      conversation.upsellDone = true;
    }
    const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
      itemsPhaseComplete: conversation.itemsPhaseComplete,
    });

    // UPSELL: After items are set, suggest extras before collecting logistics (once per order)
    if (
      hasItems &&
      !conversation.itemsPhaseComplete &&  // still selecting items
      !conversation.upsellDone &&          // haven't upsold yet
      i !== INTENTS.CANCELAMENTO &&
      !yes && !no && !hasQuestion &&       // not a confirmation response
      !finishedSelectingItems             // not "somente isso"
    ) {
      conversation.upsellDone = true;
      return { nextState: STATES.ADICIONANDO_ITEM, action: 'UPSELL_SUGGEST', missing };
    }

    // Upsell foi oferecido e cliente disse "não" → avançar (nunca insistir)
    if (hasItems && !conversation.itemsPhaseComplete && conversation.upsellDone && (no || finishedSelectingItems) && !hasNewItemsInMessage) {
      conversation.itemsPhaseComplete = true;
      const updatedMissing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, { itemsPhaseComplete: true });
      return { nextState: STATES.ADICIONANDO_ITEM, action: 'ASK_MISSING_FIELDS', missing: updatedMissing };
    }

    if (missing.length && !conversation.pendingFieldConfirmation) {
      const firstMissing = missing[0];
      const hasValueForField = firstMissing === 'items'
        ? Array.isArray(conversation.transaction.items) && conversation.transaction.items.length > 0
        : firstMissing.startsWith('address.')
          ? Boolean(cleanText(conversation.transaction.address?.[firstMissing.slice('address.'.length)]))
          : Boolean(cleanText(conversation.transaction[firstMissing]));
      if (firstMissing !== 'items' && hasValueForField) conversation.pendingFieldConfirmation = firstMissing;
    }
    if (conversation.pendingFieldConfirmation === 'items') {
      conversation.pendingFieldConfirmation = null;
    }
    if (conversation.pendingFieldConfirmation) {
      // Determinar sub-estado correto baseado no campo pendente
      let subState = STATES.ADICIONANDO_ITEM;
      if (conversation.pendingFieldConfirmation.startsWith('address.')) subState = STATES.COLETANDO_ENDERECO;
      else if (conversation.pendingFieldConfirmation === 'payment') subState = STATES.COLETANDO_PAGAMENTO;
      else if (conversation.pendingFieldConfirmation === 'mode') subState = STATES.CONFIRMANDO_CARRINHO;
      return {
        nextState: subState,
        action: (i === INTENTS.CONSULTA || hasQuestion) ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION',
        missing: [conversation.pendingFieldConfirmation],
      };
    }

    // Determinar sub-estado correto baseado no próximo campo faltante
    if (missing.length) {
      let subState = STATES.ADICIONANDO_ITEM;
      const firstMissing = missing[0];
      if (firstMissing === 'items') subState = STATES.ADICIONANDO_ITEM;
      else if (firstMissing === 'mode') subState = STATES.CONFIRMANDO_CARRINHO;
      else if (firstMissing.startsWith('address.')) subState = STATES.COLETANDO_ENDERECO;
      else if (firstMissing === 'payment') subState = STATES.COLETANDO_PAGAMENTO;
      return { nextState: subState, action: (i === INTENTS.CONSULTA || hasQuestion) ? 'ANSWER_AND_RESUME' : 'ASK_MISSING_FIELDS', missing };
    }
    return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
  }

  // ── FINALIZANDO (ex-WAITING_CONFIRMATION) ──────────────────────────────
  if (s === STATES.FINALIZANDO) {
    if (i === INTENTS.CANCELAMENTO) return { nextState: STATES.ADICIONANDO_ITEM, action: 'REQUEST_ADJUSTMENTS', missing: [] };
    if (yes) return conversation.transaction.payment === 'PIX'
      ? { nextState: STATES.WAITING_PAYMENT, action: 'CREATE_ORDER_AND_WAIT_PAYMENT', missing: [] }
      : { nextState: STATES.CONFIRMED, action: 'CREATE_ORDER_AND_CONFIRM', missing: [] };

    // ── CORREÇÃO DETERMINÍSTICA: permanece em FINALIZANDO, aplica UPDATE_ITEM ──
    if (i === 'CORRECAO' || /\b(faltou|corrige|corrigir|ajusta|ajustar|mudar|alterar|ta errado|tá errado|está errado|errado|errei|n[aã]o [eé] isso)\b/i.test(groupedText)) {
      const correction = classification.correction || detectCorrection(groupedText);
      if (correction.type === 'QTY_UPDATE' && correction.newQty != null) {
        // UPDATE_ITEM: aplicar correção de quantidade diretamente no carrinho
        const corrText = normalizeForMatch(groupedText);
        const items = conversation.transaction.items || [];
        // Tentar identificar qual item está sendo corrigido pelo contexto da mensagem
        let corrected = false;
        for (const item of items) {
          const itemNorm = normalizeForMatch(item.name);
          if (corrText.includes(itemNorm) || itemNorm.includes(corrText.split(/\s+/).slice(-2).join(' '))) {
            item.quantity = correction.newQty;
            corrected = true;
            break;
          }
        }
        // Se não conseguiu mapear item específico, corrigir todos com qty > newQty
        if (!corrected && items.length > 0) {
          for (const item of items) {
            if (item.quantity > correction.newQty) {
              item.quantity = correction.newQty;
              corrected = true;
            }
          }
        }
        // Recalcular total
        const amounts = calculateOrderAmounts(conversation.transaction, conversation);
        conversation.transaction.total_amount = amounts.total;
        anaDebug('CORRECTION_APPLIED', { type: 'QTY_UPDATE', newQty: correction.newQty, corrected, cart: cartSnapshot(conversation.transaction) });
        return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
      }
      // GENERIC_ERROR: pedir detalhes sem sair do FINALIZANDO
      if (no) {
        return { nextState: STATES.FINALIZANDO, action: 'CORRECTION_REBUILD', missing: [] };
      }
      return { nextState: STATES.FINALIZANDO, action: 'CORRECTION_REBUILD', missing: [] };
    }

    // "não" simples sem padrão de correção = pedir ajustes
    if (no) return { nextState: STATES.FINALIZANDO, action: 'CORRECTION_REBUILD', missing: [] };

    // Consultation question while waiting confirmation: answer then re-ask
    if (i === INTENTS.CONSULTA || hasQuestion) return { nextState: STATES.FINALIZANDO, action: 'ANSWER_AND_CONFIRM', missing: [] };
    const hasOrderChange = Boolean(
      (Array.isArray(extracted?.items) && extracted.items.length > 0)
      || (cleanText(extracted?.mode) && cleanText(extracted.mode) !== cleanText(conversation.transaction?.mode))
      || (cleanText(extracted?.payment) && cleanText(extracted.payment) !== cleanText(conversation.transaction?.payment))
      || (cleanText(extracted?.notes) && cleanText(extracted.notes) !== cleanText(conversation.transaction?.notes))
    );
    if (hasOrderChange) return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
    return { nextState: STATES.FINALIZANDO, action: 'ASK_CONFIRMATION', missing: [] };
  }

  // ── WAITING_PAYMENT ───────────────────────────────────────────────────
  if (s === STATES.WAITING_PAYMENT) {
    if (i === INTENTS.PAGAMENTO || yes || /paguei|comprovante|pago/.test(groupedText.toLowerCase())) return { nextState: STATES.CONFIRMED, action: 'PAYMENT_CONFIRMED', missing: [] };
    if (i === INTENTS.CANCELAMENTO) return { nextState: STATES.ADICIONANDO_ITEM, action: 'REQUEST_ADJUSTMENTS', missing: [] };
    if (/retirad|no local|na hora|dinheiro|cart[aã]o|cartao|cr[eé]dito|d[eé]bito/.test(groupedText.toLowerCase())) {
      if (/dinheiro|na hora/.test(groupedText.toLowerCase())) conversation.transaction.payment = 'CASH';
      else if (/cart[aã]o|cartao|cr[eé]dito|d[eé]bito/.test(groupedText.toLowerCase())) conversation.transaction.payment = 'CARD';
      return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
    }
    return { nextState: STATES.WAITING_PAYMENT, action: 'PAYMENT_REMINDER', missing: [] };
  }

  // ── CONFIRMED ─────────────────────────────────────────────────────────
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

  const activeStates = [STATES.ADICIONANDO_ITEM, STATES.MENU, STATES.CONFIRMANDO_CARRINHO, STATES.COLETANDO_ENDERECO, STATES.COLETANDO_PAGAMENTO, STATES.FINALIZANDO, STATES.WAITING_PAYMENT];
  if (!activeStates.includes(conv.state)) return;

  const phone = conv.phone;
  const remoteJid = conv.remoteJid || null;
  const minimalRuntime = { evolution: { ...evolutionConfig } };

  const warningTimer = setTimeout(async () => {
    try {
      const current = conversations.get(key);
      if (!current || !activeStates.includes(current.state)) return;
      // Follow-up de cancelamento: só cancela em estados de carrinho aberto (não em WAITING_PAYMENT/FINALIZANDO)
      const name = cleanText(current.transaction?.customer_name || '').split(' ')[0] || '';
      const msg = name
        ? `${name}, ainda está por aí? Posso continuar com seu pedido 😊`
        : 'Ainda está por aí? Posso continuar com seu pedido 😊';
      await sendWhatsAppMessage(phone, msg, minimalRuntime, remoteJid);
      appendMessage(current, 'assistant', msg, { action: 'FOLLOWUP_WARNING' });
      appendCustomerMemory(getCustomer(current.tenantId || 'default', current.phone), 'assistant', msg, { action: 'FOLLOWUP_WARNING' }, current.state);
      persistStateDebounced();
    } catch (_) { }
  }, 5 * 60 * 1000);

  const cancelTimer = setTimeout(async () => {
    try {
      const current = conversations.get(key);
      if (!current || !activeStates.includes(current.state)) return;
      // Só cancela automaticamente em estados de carrinho aberto, não em pagamento/finalização
      const cancelableStates = [STATES.ADICIONANDO_ITEM, STATES.MENU, STATES.CONFIRMANDO_CARRINHO, STATES.COLETANDO_ENDERECO, STATES.COLETANDO_PAGAMENTO];
      if (!cancelableStates.includes(current.state)) return;
      const name = cleanText(current.transaction?.customer_name || '').split(' ')[0] || '';
      const msg = name
        ? `${name}, como não tivemos resposta, cancelei o pedido em andamento. Quando quiser voltar é só me chamar 😊`
        : 'Como não tivemos resposta por um tempo, cancelei o pedido. Quando quiser é só me chamar 😊';
      await sendWhatsAppMessage(phone, msg, minimalRuntime, remoteJid);
      appendMessage(current, 'assistant', msg, { action: 'FOLLOWUP_CANCEL' });
      appendCustomerMemory(getCustomer(current.tenantId || 'default', current.phone), 'assistant', msg, { action: 'FOLLOWUP_CANCEL' }, current.state);
      current.state = STATES.INIT;
      current.stateUpdatedAt = nowISO();
      current.transaction = {
        mode: '', customer_name: '', items: [], notes: '',
        address: { street_name: '', street_number: '', neighborhood: '', city: '', state: '', postal_code: '' },
        payment: '', total_amount: 0, order_id: null,
      };
      current.confirmed = {};
      current.pendingFieldConfirmation = null;
      current.itemsPhaseComplete = false;
      followUpTimers.delete(key);
      persistStateDebounced();
    } catch (_) { }
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

function normalizeExtractedItemsWithCatalog(items, catalog) {
  const { resolved } = resolveItemsWithCatalog(items || [], catalog || []);
  const merged = new Map();

  for (const resolvedItem of resolved) {
    const key = normalizeForMatch(resolvedItem.desc_item);
    const current = merged.get(key);
    // MAX em vez de SOMA: duplicatas na mesma mensagem são redundância, não intenção de somar
    if (current) current.quantity = Math.max(current.quantity, toNumberOrOne(resolvedItem.quantity));
    else {
      merged.set(key, {
        name: cleanText(resolvedItem.desc_item),
        quantity: toNumberOrOne(resolvedItem.quantity),
        integration_code: String(resolvedItem.integration_code || ''),
        unit_price: Number(resolvedItem.unit_price || 0) || null,
      });
    }
  }

  // Só adiciona itens sem correspondência no catálogo quando o catálogo estiver vazio
  // (evita que perguntas como "Tem coca?" virem itens do pedido)
  if (!catalog || catalog.length === 0) {
    for (const rawItem of (items || [])) {
      const name = cleanText(rawItem?.name || rawItem?.nome || '');
      if (!name) continue;
      const key = normalizeForMatch(name);
      if (merged.has(key)) continue;
      merged.set(key, { name, quantity: toNumberOrOne(rawItem.quantity), integration_code: null, unit_price: null });
    }
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
  const pendingField = conversation.pendingFieldConfirmation || restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
    itemsPhaseComplete: conversation.itemsPhaseComplete,
  })[0];
  if (!pendingField || hasExtractedField(extracted, pendingField)) return;

  const text = cleanText(groupedText);
  if (!text || text.includes('?')) return;
  if (isNonInformativeFieldValue(text)) return;
  if (!extracted.address || typeof extracted.address !== 'object') extracted.address = {};

  if (pendingField === 'items') {
    if (detectItemsPhaseDone(text)) return;
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
    const parsed = extractAddressFromText(text);
    if (cleanText(parsed[key])) extracted.address[key] = cleanText(parsed[key]);
    else extracted.address[key] = text;
    for (const extraKey of ['street_name', 'street_number', 'neighborhood', 'city', 'state', 'postal_code']) {
      if (!cleanText(extracted.address[extraKey]) && cleanText(parsed[extraKey])) {
        extracted.address[extraKey] = cleanText(parsed[extraKey]);
      }
    }
    return;
  }
  extracted[pendingField] = text;
}

function calculateOrderAmounts(tx, conversation = null) {
  const itemTotal = (tx?.items || []).reduce((sum, it) => sum + (Number(it.unit_price || 0) * Number(it.quantity || 1)), 0);
  const feeInfo = tx?.mode === 'DELIVERY' ? resolveDeliveryFee(conversation, tx) : null;
  const feeCents = feeInfo ? Math.round(Number(feeInfo.fee || 0) * 100) : 0;
  return { itemTotal, feeCents, total: itemTotal + feeCents, feeInfo };
}

function generateOrderSummary(tx, conversation = null, { withConfirmation = true } = {}) {
  const safeTx = tx || {};
  const items = (safeTx.items || []).map((it) => {
    const unitPrice = Number(it.unit_price || 0);
    const qty = Number(it.quantity || 1);
    const lineTotal = unitPrice * qty;
    const unitDisplay = unitPrice > 0 ? ` (${formatBRL(unitPrice / 100)} un.)` : '';
    return `• ${qty}x ${it.name}${unitDisplay}${lineTotal > 0 ? ` — ${formatBRL(lineTotal / 100)}` : ''}`;
  }).join('\n') || '• Sem itens';

  const paymentMap = { PIX: 'PIX', CARD: 'Cartão', CASH: 'Dinheiro' };
  const payment = paymentMap[safeTx.payment] || safeTx.payment || 'Não informado';
  const mode = safeTx.mode === 'TAKEOUT' ? 'Retirada' : 'Entrega';
  const addrParts = [
    safeTx.address?.street_name,
    safeTx.address?.street_number ? `nº ${safeTx.address.street_number}` : '',
    safeTx.address?.neighborhood,
    safeTx.address?.city,
    safeTx.address?.state,
    safeTx.address?.postal_code ? `CEP ${safeTx.address.postal_code}` : '',
  ].filter(Boolean);
  const addressBlock = safeTx.mode === 'DELIVERY' && addrParts.length
    ? `\n📍 Endereço:\n${addrParts.join(', ')}`
    : '';

  const amounts = calculateOrderAmounts(safeTx, conversation);
  const lines = [
    '📋 *Resumo do pedido:*',
    '',
    '🛒 *Itens:*',
    items,
    '',
    `🚚 Modalidade: ${mode}${addressBlock}`,
    `💳 Pagamento: ${payment}`,
    '',
    `Subtotal: ${formatBRL(amounts.itemTotal / 100)}`,
  ];
  // Sempre mostrar taxa de entrega quando modo é DELIVERY
  if (safeTx.mode === 'DELIVERY') {
    lines.push(`Taxa de entrega: ${amounts.feeCents > 0 ? formatBRL(amounts.feeCents / 100) : 'a confirmar'}`);
  }
  lines.push(`*Total: ${formatBRL(amounts.total / 100)}*`);
  if (withConfirmation) lines.push('', 'Está tudo certo para confirmar? 😊');
  return lines.join('\n');
}

async function createSaiposOrder({ conversation, runtime, apiRequest, getEnvConfig, log }) {
  if (runtime.segment !== 'restaurant') return { ok: true, skipped: true };
  const tx = conversation.transaction || {};

  const { resolved, unresolved } = resolveItemsWithCatalog(conversation.transaction.items, conversation.catalog || []);
  if (unresolved.length) return { ok: false, unresolved };

  const feeInfo = (conversation.transaction.mode || 'DELIVERY') === 'DELIVERY'
    ? resolveDeliveryFee(conversation, conversation.transaction)
    : null;
  const deliveryFeeCents = feeInfo ? Math.round(Number(feeInfo.fee || 0) * 100) : 0;
  const total_amount = resolved.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0) + deliveryFeeCents;
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
      ...((conversation.transaction.mode || 'DELIVERY') === 'DELIVERY' ? { delivery_by: 'RESTAURANT', delivery_fee: deliveryFeeCents } : {}),
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
      delivery_fee: Number((deliveryFeeCents || 0) / 100),
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

  // ── [ANA-DEBUG] ORDER_PAYLOAD ──────────────────────────────────────────
  anaDebug('ORDER_PAYLOAD', {
    endpoint: runtime.anafood.endpoint,
    items: payload.order.items,
    total: payload.order.total,
    delivery_fee: payload.order.delivery_fee,
    customer: payload.order.customer_name,
    payment: payload.order.payment_method,
    type: payload.order.type,
  });

  try {
    const startMs = Date.now();
    const response = await fetch(runtime.anafood.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const elapsed = Date.now() - startMs;
    const data = await response.json().catch(() => ({}));

    // ── [ANA-DEBUG] ORDER_RESPONSE ──────────────────────────────────────
    anaDebug('ORDER_RESPONSE', {
      status: response.status,
      ok: response.ok,
      elapsed_ms: elapsed,
      body: data,
    });

    if (!response.ok) {
      const err = new Error(data?.error || `HTTP ${response.status}`);
      err.details = data;
      err.status = response.status;
      throw err;
    }

    conversation.transaction.order_id = data?.order?.id || `anafood-${Date.now()}`;
    log('INFO', 'Ana: pedido criado com sucesso no AnaFood', {
      tenantId: runtime.id,
      phone: conversation.phone,
      order_id: conversation.transaction.order_id,
      elapsed_ms: elapsed,
    });
    return { ok: true, order_id: conversation.transaction.order_id };
  } catch (err) {
    // ── [ANA-DEBUG] ORDER_ERROR ──────────────────────────────────────────
    anaDebug('ORDER_ERROR', {
      err: err.message,
      status: err.status || null,
      details: err.details || null,
      endpoint: runtime.anafood.endpoint,
    });
    log('ERROR', 'Ana: erro ao criar pedido AnaFood', {
      err: err.message,
      status: err.status || null,
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

  const saipos = await createSaiposOrder({ conversation, runtime, apiRequest, getEnvConfig, log });
  if (saipos.ok) return saipos;
  if (runtime.anafood?.endpoint) {
    log('INFO', 'Ana: fallback para AnaFood apos falha no SAIPOS', { tenantId: runtime.id, phone: conversation.phone, err: saipos.error || '' });
    return createAnaFoodOrder({ conversation, runtime, log });
  }
  return saipos;
}

function toReaisAmount(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const raw = String(v || '');
  if (!raw.includes('.') && !raw.includes(',') && n >= 100) return n / 100;
  return n;
}

function isBeverageItemName(name = '') {
  const n = normalizeForMatch(name);
  if (!n) return false;
  return /\b(coca|cola|refrigerante|refri|suco|agua|agua de coco|cha|cafe|cafezinho|cerveja|guarana|fanta|sprite|pepsi|mate|limonada|laranjada|energetico|monster|red bull)\b/.test(n);
}

function isDessertItemName(name = '') {
  const n = normalizeForMatch(name);
  if (!n) return false;
  return /\b(sobremesa|doce|bolo|sorvete|mousse|pudim|torta|brigadeiro|brownie|acai|petit gateau|cheesecake|pavê|pave|gelatina|sundae)\b/.test(n);
}

function isSideItemName(name = '') {
  const n = normalizeForMatch(name);
  if (!n) return false;
  return /\b(acompanhamento|batata|salada|arroz|farofa|vinagrete|porcao|porção|onion rings|mandioca|macaxeira|pure|purê|coleslaw|molho extra)\b/.test(n);
}

function categorizeItem(name = '') {
  if (isBeverageItemName(name)) return 'BEBIDA';
  if (isDessertItemName(name)) return 'SOBREMESA';
  if (isSideItemName(name)) return 'ACOMPANHAMENTO';
  return 'PRATO';
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
    const areaName = cleanText(area?.neighborhood || area?.bairro || area?.name || '');
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

function fallbackText(runtime, action, tx, missing, conversation = null) {
  const firstName = cleanText(tx?.customer_name || '').split(' ')[0] || '';
  const hi = firstName ? `${firstName}, ` : '';
  const agentName = runtime?.agentName || 'Ana';
  const companyName = getCompanyDisplayName(runtime, conversation);

  if (action === 'WELCOME') {
    if (firstName && companyName) {
      return `Olá ${firstName}, aqui é a ${agentName} do ${companyName} 👋\nComo posso te ajudar hoje?`;
    }
    if (companyName) {
      return `Olá! Aqui é a ${agentName} do ${companyName} 👋\nQual seu nome para eu registrar aqui?`;
    }
    return firstName
      ? `Olá ${firstName}, aqui é a ${agentName} 👋\nComo posso te ajudar hoje?`
      : `Olá! Aqui é a ${agentName} 👋\nQual seu nome para eu registrar aqui?`;
  }

  if (action === 'ASK_REPEAT_LAST_ORDER') {
    const preview = cleanText(conversation?.repeatPreview || '');
    if (preview) return `${hi}vi que seu último pedido foi:\n${preview}\n\nDeseja repetir o mesmo? 😊`;
    return `${hi}vi que você já pediu aqui antes. Quer repetir o último pedido?`;
  }

  if (action === 'ASK_FIELD_CONFIRMATION') {
    const field = (missing || [])[0];
    if (!field) return 'Pode confirmar esse dado?';
    const label = fieldConfirmationLabel(field);
    const value = fieldConfirmationValue(tx, field);
    return `Só confirmar: ${label} é *${value}*? 😊`;
  }

  if (action === 'ASK_MISSING_FIELDS') {
    const first = (missing || [])[0];
    const payments = getAvailablePaymentMethods(runtime, conversation).join(', ');
    const hasItems = Array.isArray(tx?.items) && tx.items.length > 0;
    const map = {
      customer_name: 'Qual é o seu nome?',
      items: hasItems
        ? 'Perfeito. Quer acrescentar, remover ou alterar algum item? Se estiver tudo certo, me diga "somente isso".'
        : 'O que você vai querer hoje? 😊',
      notes: 'Tem alguma observação para o pedido? Se não tiver, é só dizer "sem observações".',
      mode: 'É pra retirada ou entrega?',
      payment: `Como prefere pagar? ${payments}`,
      'address.street_name': 'Qual é a rua para entrega?',
      'address.street_number': 'Qual é o número?',
      'address.neighborhood': 'E o bairro?',
      'address.city': 'Qual é a cidade?',
      'address.state': 'E o estado (UF)?',
      'address.postal_code': 'Me passa o CEP também? (só os números)',
    };
    return map[first] || 'Me passa mais um dado para continuar 😊';
  }

  if (action === 'ANSWER_AND_RESUME') {
    const lastUser = cleanText(conversation?.messages?.slice(-1)?.[0]?.content || '').toLowerCase();
    if (/^ja (falei|informei)|^já (falei|informei)/.test(lastUser)) {
      const first = (missing || [])[0];
      if (first === 'items') {
        const hasItems = Array.isArray(tx?.items) && tx.items.length > 0;
        return hasItems
          ? 'Entendi. Já registrei os itens atuais. Quer acrescentar, remover ou alterar algo? Se estiver finalizado, me diga "somente isso".'
          : 'Entendido! Para eu registrar certinho, pode informar os itens assim: "1 prato do dia e 1 coca-cola lata"?';
      }
      if (first === 'address.street_name') return 'Entendi. Pode confirmar a rua completa para entrega?';
      if (first === 'address.street_number') return 'Entendido! E o número da casa?';
      if (first === 'address.neighborhood') return 'Entendido! Qual é o bairro?';
      if (first === 'payment') return 'Entendido! Qual forma de pagamento prefere?';
      return 'Entendido! Continuando de onde paramos.';
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
    // Categorias já presentes no carrinho
    const cartCategories = new Set((tx.items || []).map((it) => categorizeItem(it.name)));
    const cartNorms = (tx.items || []).map((it) => normalizeForMatch(it.name));

    // Prioridade de sugestão: BEBIDA → SOBREMESA → ACOMPANHAMENTO
    let suggestionCategory = '';
    let suggestionLabel = '';
    if (!cartCategories.has('BEBIDA')) { suggestionCategory = 'BEBIDA'; suggestionLabel = 'uma bebida'; }
    else if (!cartCategories.has('SOBREMESA')) { suggestionCategory = 'SOBREMESA'; suggestionLabel = 'uma sobremesa'; }
    else if (!cartCategories.has('ACOMPANHAMENTO')) { suggestionCategory = 'ACOMPANHAMENTO'; suggestionLabel = 'um acompanhamento'; }

    const extras = menu
      .filter((m) => m.available !== false && !cartNorms.includes(normalizeForMatch(m.name)))
      .filter((m) => {
        if (!suggestionCategory) return true;
        return categorizeItem(m.name) === suggestionCategory;
      })
      .slice(0, 3)
      .map((m) => m.name);

    let suggestionLine;
    if (extras.length && suggestionLabel) {
      suggestionLine = `Que tal ${suggestionLabel}? Temos ${extras.join(', ')} 😋`;
    } else if (extras.length) {
      suggestionLine = `Quer acrescentar mais alguma coisa? Temos também ${extras.join(', ')} 😋`;
    } else {
      suggestionLine = 'Quer acrescentar mais alguma coisa?';
    }
    return `Anotado! ✅\n${itemLines}\n\n${suggestionLine}\nSe já estiver tudo certo, me diga "somente isso".`;
  }

  if (action === 'ANSWER_AND_CONFIRM') {
    const itemLines = (tx.items || []).map((it) => `• ${it.quantity}x ${it.name}`).join('\n') || '—';
    return `Respondendo rapidinho 😊\n\nSeu pedido até agora:\n${itemLines}\n\nPosso confirmar?`;
  }

  if (action === 'ASK_CONFIRMATION') {
    return 'Está tudo certo para eu concluir o pedido? 😊';
  }

  if (action === 'ORDER_REVIEW') {
    return generateOrderSummary(tx, conversation, { withConfirmation: true });
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
    return 'Ainda aguardando a confirmação do pagamento. Assim que pagar, é só me avisar 😊';
  }

  if (action === 'REQUEST_ADJUSTMENTS') {
    return 'Claro! O que você quer ajustar no pedido?';
  }

  if (action === 'CORRECTION_REBUILD') {
    const summary = generateOrderSummary(tx, conversation, { withConfirmation: false });
    return `Entendi! Vamos corrigir. Aqui está seu pedido atual:\n\n${summary}\n\nO que você quer alterar? 😊`;
  }

  if (action === 'FLOW_CANCELLED') {
    return 'Tudo bem! Pedido cancelado. Se quiser recomeçar é só me chamar 😊';
  }

  if (action === 'BLOCK_NEW_ORDER_UNTIL_FINISH') {
    return 'Ainda tenho um pedido em andamento. Me avisa quando terminar e faço um novo pra você 😊';
  }

  if (action === 'HUMAN_HANDOFF') {
    return firstName
      ? `Claro, ${firstName}! Vou te passar para um atendente agora. Um instante 😊`
      : 'Claro! Vou te passar para um atendente agora. Um instante 😊';
  }

  if (action === 'END_CONVERSATION') {
    return `Até logo! Se precisar é só chamar 😊`;
  }

  return 'Pode me explicar melhor? Estou aqui pra ajudar 😊';
}

function buildInitialGreeting(runtime, conversation, customer) {
  const firstName = cleanText(customer?.name || conversation?.transaction?.customer_name || '').split(' ')[0] || '';
  const companyName = getCompanyDisplayName(runtime, conversation);
  const agentName = runtime?.agentName || 'Ana';
  if (firstName && companyName) {
    return `Olá ${firstName}, aqui é a ${agentName} do ${companyName} 👋`;
  }
  if (companyName) {
    return `Olá! Aqui é a ${agentName} do ${companyName} 👋\nQual seu nome para eu registrar aqui?`;
  }
  if (firstName) {
    return `Olá ${firstName}, aqui é a ${agentName} 👋`;
  }
  return `Olá! Aqui é a ${agentName} 👋\nQual seu nome para eu registrar aqui?`;
}

function buildMenuReply(conversation, followUp = '') {
  const menu = Array.isArray(conversation?.companyData?.menu) ? conversation.companyData.menu : [];
  if (!menu.length) return '';

  // Emoji por categoria
  const CATEGORY_EMOJI = {
    'proteina': '🥩', 'proteinas': '🥩', 'carnes': '🥩', 'prato': '🍽️', 'pratos': '🍽️',
    'prato principal': '🍽️', 'pratos principais': '🍽️', 'refeicao': '🍽️', 'refeicoes': '🍽️',
    'bebida': '🥤', 'bebidas': '🥤', 'refrigerante': '🥤', 'refrigerantes': '🥤',
    'sobremesa': '🍰', 'sobremesas': '🍰', 'doce': '🍰', 'doces': '🍰',
    'acompanhamento': '🥗', 'acompanhamentos': '🥗', 'salada': '🥗', 'saladas': '🥗',
    'combo': '🎯', 'combos': '🎯', 'promocao': '🎯', 'promocoes': '🎯',
    'lanche': '🍔', 'lanches': '🍔', 'hamburguer': '🍔', 'hamburgueres': '🍔',
    'pizza': '🍕', 'pizzas': '🍕', 'salgado': '🥟', 'salgados': '🥟',
  };

  const categories = new Map();
  for (const item of menu) {
    const cat = cleanText(item?.category || item?.categoria || '');
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(item);
  }

  const sections = [];
  for (const [cat, items] of categories.entries()) {
    const lines = items
      .map((i) => `• ${i.name}${Number(i.price || 0) > 0 ? ` — ${formatBRL(i.price)}` : ''}`)
      .join('\n');
    if (cat) {
      const emojiKey = normalizeForMatch(cat);
      const emoji = CATEGORY_EMOJI[emojiKey] || '📌';
      sections.push(`${emoji} *${cat}*\n${lines}`);
    } else {
      sections.push(lines);
    }
  }
  const base = `🍽️ *CARDÁPIO*\n\n${sections.join('\n\n')}`;
  return followUp ? `${base}\n\n${followUp}` : base;
}

function buildContextualAnswer(conversation, userMessage = '') {
  const text = cleanText(userMessage).toLowerCase();
  const mcp = conversation?.companyData || {};
  const company = mcp?.company || {};
  const menu = Array.isArray(mcp?.menu) ? mcp.menu : [];
  const payments = getAvailablePaymentMethods({}, conversation);
  const deliveryAreas = Array.isArray(mcp?.deliveryAreas) ? mcp.deliveryAreas : [];

  // "O que eu pedi?" / "meu pedido" → resumo parcial do pedido atual
  if (/\b(o que (eu )?pedi|meu pedido atual|resumo do pedido|que (tenho|tem) no pedido|o que (tenho|tem) no pedido|meu pedido)\b/i.test(text)) {
    const items = (conversation?.transaction?.items || []).filter((it) => cleanText(it.name));
    if (items.length > 0) {
      const summary = generateOrderSummary(conversation.transaction, conversation, { withConfirmation: false });
      const followUp = conversation?.itemsPhaseComplete
        ? ''
        : '\n\nQuer acrescentar, remover ou alterar algum item? Se estiver finalizado, me diga "somente isso".';
      return `${summary}${followUp}`;
    }
    return 'Ainda não registrei nenhum item no seu pedido.';
  }

  // "Tem X?" / "Existe X?" → verifica disponibilidade no cardápio
  if (
    /^(tem\s|existe\s|vocês?\s+tem\b|vocês?\s+têm\b)/.test(text.trim()) ||
    (/\b(tem|existe|há|vocês?\s+têm)\b/.test(text) && /\?/.test(userMessage))
  ) {
    if (menu.length > 0) {
      const query = text
        .replace(/^(tem|existe|há|vocês?\s+tem|vocês?\s+têm)\s*/i, '')
        .replace(/[?!.,]/g, '')
        .trim();
      if (query) {
        const queryNorm = normalizeForMatch(query);
        const found = menu.find((m) => {
          const n = normalizeForMatch(m?.name || '');
          return n.includes(queryNorm) || queryNorm.includes(n);
        });
        if (found) return `Sim, temos ${found.name}!`;
        return `Não temos ${query} no cardápio no momento. Temos: ${menu.slice(0, 3).map((m) => m.name).join(', ')}.`;
      }
    }
  }

  if (/\b(endereco|endereço|localiza[cç][aã]o)\b/.test(text)) {
    const address = (() => {
      if (typeof company.address === 'string') return cleanText(company.address);
      if (company.address && typeof company.address === 'object') {
        const a = company.address;
        return cleanText([
          a.logradouro || a.street || a.street_name || '',
          a.numero || a.number || a.street_number || '',
          a.complemento || a.complement || '',
          a.bairro || a.neighborhood || '',
          a.cidade || a.city || '',
          a.estado || a.state || '',
          a.cep || a.postal_code || '',
        ].filter(Boolean).join(', '));
      }
      if (company.address_raw && typeof company.address_raw === 'object') {
        const a = company.address_raw;
        return cleanText([
          a.logradouro || a.street || a.street_name || '',
          a.numero || a.number || a.street_number || '',
          a.complemento || a.complement || '',
          a.bairro || a.neighborhood || a.district || '',
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
      if (company.schedule_raw) {
        if (typeof company.schedule_raw === 'string') return cleanText(company.schedule_raw);
        if (Array.isArray(company.schedule_raw)) {
          const parts = company.schedule_raw.map((row) => {
            const day = cleanText(row?.day || row?.weekday || row?.dia || row?.name || '');
            const open = cleanText(row?.open || row?.start || row?.from || row?.abertura || '');
            const close = cleanText(row?.close || row?.end || row?.to || row?.fechamento || '');
            if (!day || !open || !close) return '';
            return `${day} ${open}-${close}`;
          }).filter(Boolean);
          return cleanText(parts.join(' | '));
        }
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
    if (/\b(card[aá]pio|cardapio|menu)\b/.test(text)) {
      const full = menu
        .filter((i) => i.available !== false)
        .map((i) => `• ${i.name}${Number(i.price || 0) > 0 ? ` (${formatBRL(i.price)})` : ''}`)
        .join('\n');
      return `Cardápio de hoje:\n\n${full}`;
    }
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
      const found = deliveryAreas.find((a) => normalizeForMatch(a.neighborhood || a?.zone_name || '').includes(asked) || asked.includes(normalizeForMatch(a.neighborhood || a?.zone_name || '')));
      if (found) return `A taxa para ${found.neighborhood || found.zone_name || 'essa região'} é ${formatBRL(toReaisAmount(found?.fee ?? found?.taxa ?? found?.delivery_fee ?? 0))}.`;
    }
    if (/\b(taxa|entrega|delivery)\b/.test(text)) {
      const feeInfo = resolveDeliveryFee(conversation, conversation?.transaction || {});
      if (feeInfo) return `A taxa de entrega para ${feeInfo.neighborhood || 'sua região'} é ${formatBRL(feeInfo.fee)}.`;
    }
    if (deliveryAreas.length) {
      const sample = deliveryAreas
        .slice(0, 5)
        .map((a) => `${a.neighborhood || a.zone_name || 'Região'} (${formatBRL(toReaisAmount(a?.fee ?? a?.taxa ?? a?.delivery_fee ?? 0))})`)
        .join(', ');
      return `Entregamos em: ${sample}.`;
    }
    return 'Ainda não encontrei as áreas de entrega cadastradas.';
  }

  return '';
}

async function generatorAgent({ runtime, conversation, customer, classification, orchestratorResult, groupedText, contextualHint = '' }) {
  const recentContext = Array.isArray(customer?.recentContext) ? customer.recentContext.slice(-MAX_PROMPT_MEMORY_ITEMS) : [];
  const recentContextForPrompt = recentContext.map((m) => {
    const who = m.role === 'assistant' ? 'Agente' : 'Cliente';
    const action = cleanText(m.action || '');
    const tag = action ? ` [${action}]` : '';
    return `${who}${tag}: ${cleanText(m.content || '')}`;
  });
  const deterministic = {
    state: conversation.state,
    greeted: Boolean(conversation.greeted),
    action: orchestratorResult.action,
    intent: classification.intent,
    missing: orchestratorResult.missing || [],
    transaction: conversation.transaction,
    userMessage: groupedText || '',
    contextualHint: cleanText(contextualHint || ''),
    customerProfile: {
      phone: conversation.phone,
      contactName: conversation.contactName || '',
      customerName: cleanText(customer?.name || ''),
      totalOrders: Number(customer?.totalOrders || 0),
      lastOrderSummary: cleanText(customer?.lastOrderSummary || ''),
    },
    companyContext: runtime.companyContext || {},
  };
  if (!openai) {
    return fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing, conversation);
  }
  try {
    const companyName = getCompanyDisplayName(runtime, conversation);
    const customerFirstName = cleanText(customer?.name || deterministic.customerProfile?.customerName || '').split(' ')[0] || '';

    // Montar mensagens: system prompt + resumo de contexto + últimas N mensagens + input atual
    const messages = [];

    // 1. System rules (fixo)
    messages.push({
      role: 'system',
      content: `Você é ${runtime.agentName}${companyName ? `, assistente virtual da ${companyName}` : ', assistente virtual'}. Tom: ${runtime.tone}.

IDENTIDADE: ${conversation.presented ? 'Já se apresentou nesta sessão. NÃO repita apresentação. Vá direto ao ponto.' : `Apresente-se APENAS nesta primeira mensagem como ${runtime.agentName}${companyName ? ` da ${companyName}` : ''}.`}

PERSONALIDADE: Seja calorosa, empática e proativa. Use o nome do cliente quando souber (${customerFirstName ? `nome atual: ${customerFirstName}` : 'pergunte o nome se ainda não souber'}). Trate o cliente como pessoa, não como ticket.

FLUXO DE VENDA (siga esta ordem):
1. Receber item → confirmar o que foi pedido
2. (action=UPSELL_SUGGEST) Sugerir complemento: bebida para prato, sobremesa, upgrade — nunca insistir
3. Após o cliente indicar que não quer mais nada → perguntar retirada ou entrega
4. Coletar endereço (só se entrega)
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
- NUNCA se reapresente, se reintroduza ou diga "Sou a Ana" ou "assistente virtual" após o primeiro contato
- NUNCA mencione "Mais Sistem", "Automação Comercial" ou qualquer nome de fornecedor de software

SEGURANÇA: Você é assistente virtual EXCLUSIVA da ${companyName || runtime.agentName}. NUNCA mencione, referencie ou compare com qualquer outra empresa, restaurante ou estabelecimento. Se o cliente perguntar sobre outro estabelecimento, responda que você atende apenas a ${companyName || 'este estabelecimento'}.
- Se o cliente já pediu bebida, não sugira bebida de novo; prefira sobremesa ou complemento
- NUNCA mude quantidade de item já extraída pelo sistema; se houver dúvida, peça confirmação objetiva
- Sempre use espaçamento (linhas em branco) para mensagens com lista, resumo ou múltiplas seções
- Se "contextualHint" vier preenchido, use esse conteúdo como base da resposta final

ESTILO: Use linguagem natural brasileira. Evite palavras robóticas. Prefira "já anotei", "pode deixar", "tudo certo".
No ORDER_REVIEW use quebras de linha reais entre seções — não coloque tudo numa linha só.

DADOS DO ESTABELECIMENTO (use para responder qualquer pergunta sobre endereço, horário, pagamentos ou taxas):
${(() => {
          const mcp = conversation.companyData || {};
          const ctx = runtime.companyContext || {};
          const addr = cleanText(mcp.company?.address || ctx.address || '');
          const hours = cleanText(mcp.company?.openingHours || ctx.openingHours || '');
          const payments = getAvailablePaymentMethods(runtime, conversation);
          const delivery = Array.isArray(mcp.deliveryAreas) && mcp.deliveryAreas.length
            ? mcp.deliveryAreas
            : (Array.isArray(ctx.deliveryAreas) ? ctx.deliveryAreas : []);
          const lines = [
            addr ? `- Endereço: ${addr}` : '- Endereço: não cadastrado',
            hours ? `- Horário: ${hours}` : '- Horário: não cadastrado',
            payments.length ? `- Formas de pagamento: ${payments.join(', ')}` : '- Formas de pagamento: não cadastradas',
            delivery.length ? `- Taxas de entrega: ${delivery.map(a => `${a.neighborhood || a} (${formatBRL(a.fee || 0)})`).join('; ')}` : '- Taxas de entrega: não cadastradas',
          ];
          return lines.join('\n');
        })()}
${runtime.customPrompt ? `\nINSTRUÇÕES ESPECÍFICAS DO ESTABELECIMENTO:\n${runtime.customPrompt}` : ''}`,
    });

    // 2. Resumo de contexto (memória compactada de mensagens anteriores)
    const summary = cleanText(conversation.contextSummary || '');
    if (summary) {
      messages.push({
        role: 'system',
        content: `RESUMO DA CONVERSA ATÉ AGORA:\n${summary}`,
      });
    }

    // 3. Últimas N mensagens da conversa (janela ativa - alternando user/assistant)
    const recentMessages = (conversation.messages || []).slice(-MAX_HISTORY_TO_MODEL);
    for (const msg of recentMessages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({
          role: msg.role,
          content: cleanText(msg.content || ''),
        });
      }
    }

    // 4. Input atual estruturado (dados determinísticos do orquestrador)
    messages.push({
      role: 'user',
      content: JSON.stringify(deterministic),
    });

    const c = await openai.chat.completions.create({
      model: runtime.model,
      temperature: runtime.temperature,
      max_tokens: 300,
      messages,
    });
    const text = cleanText(c.choices?.[0]?.message?.content || '');
    if (text) return text;
    if (String(contextualHint || '').trim()) return String(contextualHint || '').trim();
    return fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing, conversation);
  } catch (_) {
    if (String(contextualHint || '').trim()) return String(contextualHint || '').trim();
    return fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing, conversation);
  }
}

async function maybeSummarize({ runtime, conversation, customer = null }) {
  if ((conversation.messageCount || 0) % SUMMARY_EVERY_N_MESSAGES !== 0) return;
  if (!openai) {
    if (customer && conversation.contextSummary) customer.recentContextSummary = cleanText(conversation.contextSummary);
    return;
  }
  try {
    // Preparar dados transacionais para contexto do resumo
    const tx = conversation.transaction || {};
    const txSnapshot = {
      items: (tx.items || []).map(i => `${i.quantity || 1}x ${i.name}`),
      mode: tx.mode || '',
      address: tx.address || {},
      payment: tx.payment || '',
      total: tx.total_amount || 0,
    };
    const c = await openai.chat.completions.create({
      model: runtime.model,
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `Resuma esta conversa de pedido de restaurante de forma objetiva e factual.
Inclua APENAS:
- Itens já escolhidos (com quantidades)
- Modalidade (entrega/retirada) se definida
- Endereço fornecido (rua, número, bairro) se informado
- Forma de pagamento se definida
- Pendências restantes
- Observações do cliente

Seja curto e direto. Máximo 5 linhas.
Não inclua saudações, emojis ou linguagem emocional.
Não inclua informações que não foram mencionadas na conversa.`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            recentMessages: conversation.messages.slice(-12),
            currentTransaction: txSnapshot,
            currentState: conversation.state,
          }),
        },
      ],
    });
    conversation.contextSummary = cleanText(c.choices?.[0]?.message?.content || conversation.contextSummary || '');
    if (customer) customer.recentContextSummary = cleanText(conversation.contextSummary || customer.recentContextSummary || '');

    // Podar mensagens antigas do estado local após resumo (manter apenas últimas MAX_HISTORY_TO_MODEL)
    if (Array.isArray(conversation.messages) && conversation.messages.length > MAX_HISTORY_TO_MODEL) {
      conversation.messages = conversation.messages.slice(-MAX_HISTORY_TO_MODEL);
    }
  } catch (_) { }
}

async function sendWhatsAppMessage(phone, text, runtime, remoteJid = null) {
  const { apiUrl, apiKey } = runtime.evolution;
  if (!apiUrl || !apiKey) return false;

  // Não usar cleanText aqui — ele colapsa \n e destroça a formatação no WhatsApp.
  // Apenas normalizar espaços horizontais, limitar newlines consecutivos e aparar.
  const safeText = String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
      } catch (_) { }
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
  } catch (_) { }

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
  console.error(`[ANA] Nao foi possivel enviar WhatsApp para ${phone} (instance=${runtime.evolution.instance || '-'}):`, lastErr?.details || lastErr?.message || 'unknown error');
  return false;
}

// ── [ANA-DEBUG] helpers ──────────────────────────────────────────────
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function cartSnapshot(tx) {
  return (tx?.items || []).map((it) => ({
    name: it.name,
    qty: Number(it.quantity || 1),
    code: it.integration_code || null,
    price: Number(it.unit_price || 0),
  }));
}

function anaDebug(tag, data) {
  try {
    console.log(`[ANA-DEBUG] ${tag}:`, JSON.stringify(data, null, 2));
  } catch (_) {
    console.log(`[ANA-DEBUG] ${tag}: [serialization error]`);
  }
}

async function runPipeline({ conversation, customer, groupedText, normalized, runtime, apiRequest, getEnvConfig, log, onSend = null }) {
  // ── [ANA-DEBUG] INBOUND ──────────────────────────────────────────────
  anaDebug('INBOUND', {
    phone: conversation.phone,
    tenantId: runtime.id,
    message: groupedText,
    timestamp: nowISO(),
  });

  // ── Idempotência: hash da mensagem para evitar reprocessamento ─────
  const msgHash = simpleHash(`${conversation.phone}:${groupedText}`);
  if (conversation.lastProcessedHash === msgHash) {
    anaDebug('SKIP_DUPLICATE', { hash: msgHash, message: groupedText });
    return { success: true, reply: '', skipped: true };
  }
  conversation.lastProcessedHash = msgHash;

  // ── [ANA-DEBUG] STATE_BEFORE ─────────────────────────────────────────
  anaDebug('STATE_BEFORE', {
    state: conversation.state,
    presented: Boolean(conversation.presented),
    greeted: Boolean(conversation.greeted),
    itemsPhaseComplete: Boolean(conversation.itemsPhaseComplete),
    upsellDone: Boolean(conversation.upsellDone),
    cart: cartSnapshot(conversation.transaction),
    mode: conversation.transaction?.mode || '',
    payment: conversation.transaction?.payment || '',
    consecutiveFailures: conversation.consecutiveFailures || 0,
  });
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
  } catch (_) { }

  await maybeLoadCatalog(conversation, runtime, apiRequest, getEnvConfig, log);

  // Pré-preencher nome do cliente a partir do perfil persistido (nunca perguntar novamente)
  if (cleanText(customer.name) && !cleanText(conversation.transaction.customer_name)) {
    conversation.transaction.customer_name = cleanText(customer.name);
    conversation.confirmed['customer_name'] = true;
  }

  const normalizedText = normalized.normalizedText || groupedText;
  const classification = await classifierAgent({ runtime, conversation, groupedText: normalizedText });
  const missingBeforeExtraction = runtime.segment === 'restaurant'
    ? restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
      itemsPhaseComplete: conversation.itemsPhaseComplete,
    })
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
      STATES.ADICIONANDO_ITEM,
      STATES.CONFIRMANDO_CARRINHO,
      STATES.COLETANDO_ENDERECO,
      STATES.COLETANDO_PAGAMENTO,
      STATES.FINALIZANDO,
      STATES.WAITING_PAYMENT,
    ].includes(conversation.state))
    || (runtime.segment === 'restaurant' && hasOpenTransaction && missingBeforeExtraction.length > 0)
    || (runtime.segment === 'restaurant' && Boolean(conversation.pendingFieldConfirmation));
  const extracted = shouldExtract ? await extractorAgent({ runtime, groupedText: normalizedText }) : {};
  if (runtime.segment === 'restaurant') {
    applyRecentUserContextToExtraction({ conversation, runtime, extracted });
    const menuPool = [
      ...(Array.isArray(conversation?.companyData?.menu) ? conversation.companyData.menu : []),
      ...(Array.isArray(conversation.catalog) ? conversation.catalog : []),
    ];
    const inferred = inferItemsFromMenu(normalizedText, menuPool);
    const currentItems = Array.isArray(extracted.items) ? extracted.items : [];
    const hasJoinedItem = currentItems.some((i) => /\s+e\s+/.test(String(i?.name || '').toLowerCase()));
    if (inferred.length) {
      const inferredNorms = inferred.map((i) => normalizeForMatch(i.name));
      const keepCurrent = currentItems.filter((i) => {
        const n = normalizeForMatch(i?.name || '');
        if (!n) return false;
        if (/\s+e\s+/.test(String(i?.name || '').toLowerCase())) return false;
        return !inferredNorms.some((x) => x === n || x.includes(n) || n.includes(x));
      });
      extracted.items = [...keepCurrent, ...inferred];
    } else if (hasJoinedItem) {
      extracted.items = currentItems.filter((i) => !/\s+e\s+/.test(String(i?.name || '').toLowerCase()));
    }
    forceFillPendingField({ conversation, runtime, groupedText: normalizedText, extracted });
    extracted.items = normalizeExtractedItemsWithCatalog(extracted.items || [], conversation.catalog || []);
    // ── BARREIRA DETERMINÍSTICA: se texto não tem número explícito > 1, forçar qty=1 ──
    extracted.items = normalizeQuantityFromText(extracted.items, normalizedText);
    const textLower = String(normalizedText || '').toLowerCase();
    // INVERTIDO: por padrão tudo é SET (absoluto). "mais"/"adiciona"/"faltou" marca como incremental.
    const hasIncrementalHint = /\b(mais|adiciona|acrescenta|inclui|faltou|também|tambem|acrescentar)\b/i.test(textLower);
    if (hasIncrementalHint && Array.isArray(extracted.items) && extracted.items.length) {
      extracted.items = extracted.items.map((it) => ({ ...it, incremental: true }));
    }
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
  // ── [ANA-DEBUG] CLASSIFICATION ───────────────────────────────────────
  anaDebug('CLASSIFICATION', {
    intent: classification.intent,
    confidence: classification.confidence,
    requiresExtraction: classification.requires_extraction,
    shouldExtract,
  });

  // ── [ANA-DEBUG] EXTRACTION ──────────────────────────────────────────
  anaDebug('EXTRACTION', {
    items: (extracted.items || []).map((i) => ({ name: i.name, qty: i.quantity, incremental: Boolean(i.incremental) })),
    mode: extracted.mode || null,
    payment: extracted.payment || null,
    customerName: extracted.customer_name || null,
  });

  // ── [ANA-DEBUG] CART_MUTATION (BEFORE) ──────────────────────────────
  const cartBefore = cartSnapshot(conversation.transaction);

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

  // ── [ANA-DEBUG] CART_MUTATION (AFTER) ───────────────────────────────
  const cartAfter = cartSnapshot(conversation.transaction);
  anaDebug('CART_MUTATION', {
    operation: orchestratorResult.action,
    before: cartBefore,
    after: cartAfter,
    diff: cartAfter.length !== cartBefore.length
      ? 'items_changed'
      : (JSON.stringify(cartBefore) !== JSON.stringify(cartAfter) ? 'quantities_changed' : 'no_change'),
  });

  // ── [ANA-DEBUG] STATE_AFTER ─────────────────────────────────────────
  anaDebug('STATE_AFTER', {
    previousState,
    nextState: conversation.state,
    action: orchestratorResult.action,
    missing: orchestratorResult.missing,
    cartFinal: cartAfter,
    total: conversation.transaction?.total_amount || 0,
  });

  log('INFO', 'Ana: orchestration', {
    tenantId: runtime.id,
    phone: conversation.phone,
    previousState,
    nextState: conversation.state,
    action: orchestratorResult.action,
    missing: orchestratorResult.missing,
    provider: runtime.orderProvider,
  });

  // Helper: persiste mensagem do assistant no Supabase (fire-and-forget)
  const _persistOutbound = (text) => {
    saveOutboundMessage({
      supabaseUrl: String(runtime.supabase?.url || '').trim(),
      serviceRoleKey: String(runtime.supabase?.serviceRoleKey || '').trim(),
      companyId: String(conversation.companyData?.meta?.companyId || runtime.supabase?.filterValue || '').trim(),
      tenantId: runtime.id,
      phone: conversation.phone,
      content: text,
      at: new Date().toISOString(),
    });
  };

  // ── GATE: Validação determinística antes de criar pedido ──────────────
  if (orchestratorResult.action === 'CREATE_ORDER_AND_WAIT_PAYMENT' || orchestratorResult.action === 'CREATE_ORDER_AND_CONFIRM') {
    // Recalcular total para evitar divergências
    const recalc = recalculateTotal(conversation.transaction.items);
    if (Math.abs(recalc - (conversation.transaction.total_amount || 0)) > 0.01) {
      conversation.transaction.total_amount = recalc;
    }

    const validation = validateFinalOrder(conversation.transaction, {
      requireAddress: runtime.delivery?.requireAddress !== false,
    });
    if (!validation.valid) {
      conversation.consecutiveFailures = (conversation.consecutiveFailures || 0) + 1;
      conversation.state = STATES.ADICIONANDO_ITEM;
      conversation.stateUpdatedAt = nowISO();
      const errorSummary = validation.errors.join('; ');
      const failText = `Antes de confirmar, preciso de mais algumas informações: ${errorSummary}`;
      const sent = await sendWhatsAppMessage(conversation.phone, failText, runtime, conversation.remoteJid);
      if (sent && typeof onSend === 'function') {
        onSend({
          phone: conversation.phone,
          remoteJid: conversation.remoteJid || null,
          text: failText,
          instance: runtime.evolution.instance || null,
        });
      }
      appendMessage(conversation, 'assistant', failText, { action: 'ORDER_VALIDATION_FAILED' });
      appendCustomerMemory(customer, 'assistant', failText, { action: 'ORDER_VALIDATION_FAILED' }, conversation.state);
      _persistOutbound(failText);
      persistStateDebounced();
      log('WARN', 'Ana: order validation failed', {
        tenantId: runtime.id,
        phone: conversation.phone,
        errors: validation.errors,
      });
      return { success: true, reply: failText };
    }

    const preValidation = resolveItemsWithCatalog(conversation.transaction.items, conversation.catalog || []);
    if (preValidation.unresolved.length) {
      conversation.consecutiveFailures = (conversation.consecutiveFailures || 0) + 1;
      conversation.state = STATES.ADICIONANDO_ITEM;
      conversation.stateUpdatedAt = nowISO();
      const failText = `Não encontrei esses itens no cardápio: ${preValidation.unresolved.join(', ')}. Pode informar exatamente como aparece no cardápio?`;
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
      appendCustomerMemory(customer, 'assistant', failText, { action: 'ORDER_PRE_VALIDATION_ERROR' }, conversation.state);
      _persistOutbound(failText);
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
      // Evita estado fantasma em WAITING_PAYMENT quando falha ao criar pedido
      conversation.state = STATES.FINALIZANDO;
      conversation.stateUpdatedAt = nowISO();
      let failText = 'Tive um problema ao registrar o pedido no sistema.';
      if (Array.isArray(order.unresolved) && order.unresolved.length) {
        failText = `Não encontrei esses itens no cardápio: ${order.unresolved.join(', ')}. Pode informar exatamente como aparece no cardápio?`;
        conversation.state = STATES.ADICIONANDO_ITEM;
        conversation.stateUpdatedAt = nowISO();
      } else if (runtime.orderProvider === 'anafood') {
        failText = 'Estou com instabilidade para concluir o pedido agora. Pode tentar novamente em instantes?';
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
      appendCustomerMemory(customer, 'assistant', failText, { action: 'ORDER_CREATE_ERROR' }, conversation.state);
      _persistOutbound(failText);
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

  const alwaysDeterministicActions = new Set([
    'ORDER_REVIEW',
    'PAYMENT_REMINDER',
    'FLOW_CANCELLED',
    'CREATE_ORDER_AND_WAIT_PAYMENT',
    'CREATE_ORDER_AND_CONFIRM',
    'PAYMENT_CONFIRMED',
    'BLOCK_NEW_ORDER_UNTIL_FINISH',
    'POST_CONFIRMATION_SUPPORT',
    'HUMAN_HANDOFF',
  ]);
  const text = normalized.normalizedText || groupedText;
  let contextualHint = '';
  const contextualActions = new Set(['ANSWER_AND_RESUME', 'ANSWER_AND_RESUME_CONFIRM', 'ANSWER_AND_RESUME_REPEAT', 'ANSWER_AND_CONFIRM']);
  if (contextualActions.has(orchestratorResult.action)) {
    const contextual = buildContextualAnswer(conversation, text);
    if (contextual) {
      let followAction = 'ASK_MISSING_FIELDS';
      if (orchestratorResult.action === 'ANSWER_AND_RESUME_CONFIRM') followAction = 'ASK_FIELD_CONFIRMATION';
      else if (orchestratorResult.action === 'ANSWER_AND_RESUME_REPEAT') followAction = 'ASK_REPEAT_LAST_ORDER';
      else if (orchestratorResult.action === 'ANSWER_AND_CONFIRM') followAction = 'ASK_CONFIRMATION';
      const follow = fallbackText(runtime, followAction, conversation.transaction, orchestratorResult.missing || [], conversation);
      contextualHint = `${contextual}\n\n${follow}`.trim();
    }
  }
  const rawReply = alwaysDeterministicActions.has(orchestratorResult.action)
    ? fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing || [], conversation)
    : (await generatorAgent({
      runtime,
      conversation,
      customer,
      classification,
      orchestratorResult,
      groupedText: text,
      contextualHint,
    })) || fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing || [], conversation);
  const reply = sanitizeAssistantReply({
    reply: rawReply,
    conversation,
    action: orchestratorResult.action,
  });
  // ── [ANA-DEBUG] RESPONSE ──────────────────────────────────────────────
  anaDebug('RESPONSE', {
    action: orchestratorResult.action,
    deterministic: alwaysDeterministicActions.has(orchestratorResult.action),
    rawReplyPreview: String(rawReply || '').slice(0, 200),
    finalReplyPreview: String(reply || '').slice(0, 200),
    sanitized: rawReply !== reply,
  });
  if (conversation.state !== STATES.HUMAN_HANDOFF || !conversation.handoffNotified) {
    const today = nowISO().slice(0, 10);
    const shouldSendGreetingFirst = previousState === STATES.INIT && cleanText(conversation.greetedDate || '') !== today;
    if (shouldSendGreetingFirst) {
      const greeting = buildInitialGreeting(runtime, conversation, customer);
      const sentGreeting = await sendWhatsAppMessage(conversation.phone, greeting, runtime, conversation.remoteJid);
      if (sentGreeting && typeof onSend === 'function') {
        onSend({
          phone: conversation.phone,
          remoteJid: conversation.remoteJid || null,
          text: greeting,
          instance: runtime.evolution.instance || null,
        });
      }
      if (sentGreeting) {
        appendMessage(conversation, 'assistant', greeting, { action: 'WELCOME_ONLY' });
        appendCustomerMemory(customer, 'assistant', greeting, { action: 'WELCOME_ONLY' }, conversation.state);
        _persistOutbound(greeting);
        conversation.greeted = true;
        conversation.greetedDate = today;
        conversation.presented = true;
      }
    }
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
    if (sent) {
      conversation.greeted = true;
      conversation.greetedDate = nowISO().slice(0, 10);
    }
  }

  appendMessage(conversation, 'assistant', reply, {
    action: orchestratorResult.action,
    intent: classification.intent,
    prevState: previousState,
    nextState: conversation.state,
  });
  appendCustomerMemory(customer, 'assistant', reply, { action: orchestratorResult.action }, conversation.state);
  _persistOutbound(reply);

  // Sincronizar nome extraído para o perfil persistente do cliente
  if (cleanText(conversation.transaction.customer_name) && !cleanText(customer.name)) {
    customer.name = cleanText(conversation.transaction.customer_name);
  }

  // Armazenar config de envio na conversa para uso pelos timers de follow-up
  conversation.evolutionConfig = { ...runtime.evolution };

  await maybeSummarize({ runtime, conversation, customer });

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
      appendCustomerMemory(customer, 'user', normalized.normalizedText || groupedText, {
        sourceType: normalized.sourceType,
      }, conversation.state);
      await runPipeline({ conversation, customer, groupedText, normalized, runtime, apiRequest, getEnvConfig, log, onSend });
      // Fire-and-forget: persist mensagem do usuário no Supabase msg_history
      saveInboundMessage({
        supabaseUrl: String(runtime.supabase?.url || '').trim(),
        serviceRoleKey: String(runtime.supabase?.serviceRoleKey || '').trim(),
        companyId: String(conversation.companyData?.meta?.companyId || runtime.supabase?.filterValue || '').trim(),
        tenantId: runtime.id,
        phone: conversation.phone,
        content: normalized.normalizedText || groupedText,
        at: new Date().toISOString(),
        contactName: String(conversation.contactName || customer.name || '').trim(),
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
      appendCustomerMemory(customer, 'assistant', failText, { action: 'PIPELINE_ERROR' }, conversation.state);
      saveOutboundMessage({
        supabaseUrl: String(runtime.supabase?.url || '').trim(),
        serviceRoleKey: String(runtime.supabase?.serviceRoleKey || '').trim(),
        companyId: String(conversation.companyData?.meta?.companyId || runtime.supabase?.filterValue || '').trim(),
        tenantId: runtime.id,
        phone: conversation.phone,
        content: failText,
        at: new Date().toISOString(),
      });
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

