'use strict';

const path = require('path');
const { OpenAI } = require('openai');
const { loadCompanyData } = require('../lib/company-data-mcp');
const { saveInboundMessage, saveOutboundMessage } = require('../lib/supabase-messages');
const { validateFinalOrder, recalculateTotal } = require('../lib/validators');
const { addItemToCart, removeItem, updateQuantity, setAddress, setPayment, findCatalogItem, createOrderPayload, resolveItemsWithCatalog, resolveDeliveryFee, toAnaFoodType, toAnaFoodPayment, cleanText, normalizeForMatch, tokenizeNormalized, canonicalTokens, singularizeToken, toNumberOrOne, isNearToken, toReaisAmount, detectYes, detectNo, detectItemsPhaseDone, isNonInformativeFieldValue, enrichAddressWithCompanyDefaults, getCompanyDisplayName, extractAddressFromText, formatBRL, normalizePaymentLabel, extractPaymentMethodsFromText, getAvailablePaymentMethods, normalizeStateUF } = require('../lib/business-logic');
const { extractIntent: extractIntentSchema } = require('../lib/intent-extractor');
const { transition: smTransition, missingFields: smMissingFields } = require('../lib/state-machine');
const { tenantRuntime } = require('../lib/tenants');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

const BUFFER_WINDOW_MS = Number(process.env.MESSAGE_BUFFER_MS || ONE_SECOND_MS);
const SESSION_TTL = Number(process.env.CONVERSATION_TTL_MS || ONE_HOUR_MS);
const ACTIVE_FLOW_TTL = Number(process.env.CONVERSATION_ACTIVE_FLOW_TTL_MS || 30 * ONE_MINUTE_MS);
const WAITING_PAYMENT_TTL = Number(process.env.CONVERSATION_WAITING_PAYMENT_TTL_MS || 15 * ONE_MINUTE_MS);
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

const persistStateDebounced = () => {
  // Dummy function for now
};

function appendMessage(conversation, role, text, metadata = {}) {
  // Dummy function
}

function appendCustomerMemory(customer, role, text, metadata = {}, state = null) {
  // Dummy function
}

function getCustomer(tenantId, phone) {
  const key = `${tenantId}:${phone}`;
  if (!customers.has(key)) {
    customers.set(key, { name: '', phone });
  }
  return customers.get(key);
}
const inboundMessageSeen = new Map();
const followUpTimers = new Map();

const STATE_FILE = process.env.ANA_STATE_FILE
  ? path.resolve(process.env.ANA_STATE_FILE)
  : path.join(__dirname, '..', 'data', 'ana_state.json');
const SYSTEM_PROMPT_FILE = path.join(__dirname, 'ana', 'system_prompt.txt');

let persistTimer = null;
let systemPromptCache = { mtimeMs: 0, content: '' };
const MAX_CUSTOMER_RECENT_MEMORY = 24;
const MAX_PROMPT_MEMORY_ITEMS = 8;
const MAX_HISTORY_TO_MODEL = 12;  // Máximo de mensagens recentes enviadas ao modelo

const nowISO = () => new Date().toISOString();

const normalizePromptText = (t) => String(t || '').replace(/\r\n/g, '\n').trim();











function replyContainsGreeting(text) {
  const raw = cleanText(text);
  if (!raw) return false;
  if (/^ol[aá]/i.test(raw)) return true;
  if (/\baqui\s+[ée]\s+a\b/i.test(raw)) return true;
  if (/\bsou\s+a\b/i.test(raw)) return true;
  return false;
}

function replyContainsFailSafePhrase(text) {
  const x = normalizeForMatch(text);
  if (!x) return false;
  return (
    x.includes('instabilidade')
    || x.includes('atendimento humano')
    || x.includes('transferir para atendimento')
    || x.includes('erro tecnico')
    || x.includes('falha tecnica')
    || x.includes('sistema esta com')
    || x.includes('houve um erro')
    || x.includes('parece que houve')
    || x.includes('parece que o sistema')
    || x.includes('sistema esta processando')
    || x.includes('parece estar confuso')
    || x.includes('parece confuso')
    || x.includes('endereco confuso')
    || x.includes('endereco incompleto')
    || x.includes('poderia confirmar o endereco')
    || x.includes('parece incorreto')
    || x.includes('nao entendi bem')
  );
}

function isMenuQueryText(text) {
  const x = normalizeForMatch(text);
  if (!x) return false;
  const askedMenu = /\b(cardapio|menu|tem pra vender|o que vende|opcoes|opcao|o que tem)\b/.test(x);
  if (!askedMenu) return false;
  if (/\bpedido\b/.test(x) && !/(\bcardapio\b|\bmenu\b)/.test(x)) return false;
  return true;
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

  // Palavras-chave de quantidade
  const qtyWords = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, três: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };

  // Regex para quebrar a string em itens. Considera "e", "mais", "com", vírgulas e "quero" repetido.
  // Ex: "quero uma pizza e também quero um refri" -> ["uma pizza", "um refri"]
  const chunks = raw
    .replace(/^(quero|gostaria de|me vê|me manda)\s+/i, '') // Remove comando inicial
    .split(/\s+(?:e|t(a|e)mb[eé]m|com|mais|depois|agora)\s+|\s*,\s*|\s+(?=quero|gostaria|adiciona)/i)
    .map(s => cleanText(s))
    .filter(Boolean);

  const items = [];

  for (let chunk of chunks) {
    // Ignora frases que claramente não são itens
    if (/^(oi|ola|olá|bom dia|boa tarde|boa noite)$/i.test(chunk)) continue;
    if (/^(s[oó] isso|nada mais|fecha(r)? (a conta|o pedido))$/i.test(chunk)) continue;
    if (/\b(rua|bairro|endere[cç]o|pagamento|pix|cart[aã]o|dinheiro)\b/i.test(chunk)) continue;
    if (/\?$/.test(chunk)) continue; // Ignora perguntas

    let quantity = 1;
    let name = chunk;

    // Regex unificado para extrair quantidade (número ou palavra) do início ou de qualquer lugar
    const qtyMatch = name.match(/^(?:(\d+|uma?|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez)\s+)/i)
      || name.match(/\b(\d+|uma?|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez)\b/i)
      || name.match(/\b(\d+)\s*x\b/i);

    if (qtyMatch) {
      const qtyToken = qtyMatch[1].toLowerCase();
      quantity = Number(qtyToken) || qtyWords[qtyToken] || 1;
      // Remove a quantidade e a palavra "x" (se houver) para limpar o nome
      name = cleanText(name.replace(qtyMatch[0], ''));
    }

    // Limpeza final do nome do item, sendo menos agressivo
    const cleanedName = cleanText(
      name
        .replace(/^(de|do|da)\s+/i, '') // Remove artigos no início que sobraram da limpeza
        .replace(/\b(unidade|unidades|un|und)\b/gi, ' ')
        .replace(/\s+/g, ' ')
    );

    if (!cleanedName || cleanedName.length < 2) continue;

    items.push({ name: cleanedName, quantity: Math.max(1, quantity) });
  }

  // Mescla itens com o mesmo nome, somando as quantidades
  const merged = new Map();
  for (const item of items) {
    const key = singularizeToken(normalizeForMatch(item.name));
    if (merged.has(key)) {
      const existing = merged.get(key);
      existing.quantity += item.quantity;
    } else {
      merged.set(key, { name: cleanText(item.name), quantity: toNumberOrOne(item.quantity) });
    }
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

function detectCorrectionStable(text) {
  const lower = cleanText(text).toLowerCase();
  const qtyWords = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, três: 3, quatro: 4, cinco: 5 };

  const qtyRegexes = [
    /(?:somente|apenas|só|so)\s+(\d+|um|uma|dois|duas|tres|três|quatro|cinco)\b/i,
    /(?:não|nao)\s+(?:é|e)\s+\d+.+(?:é|e)\s+(?:somente|apenas|só|so)?\s*(\d+|um|uma|dois|duas|tres|três|quatro|cinco)\b/i,
    /(?:corrige|corrigir|mudar?|alterar?)\s+(?:para|pra)\s+(\d+|um|uma|dois|duas|tres|três|quatro|cinco)\b/i,
    /(?:vai\s+ser|vai\s+ficar|ficar|fica|será|sera)\s+(?:somente|apenas|só|so)?\s*(\d+|um|uma|dois|duas|tres|três|quatro|cinco)\b/i,
  ];

  let numMatch = null;
  for (const rx of qtyRegexes) {
    const m = lower.match(rx);
    if (m) { numMatch = m; break; }
  }

  const isError = /\b(faltou|corrige|corrigir|ajusta|ajustar|mudar|alterar|ta errado|tá errado|está errado|errado|errei|incorreto|troquei|trocar|troca|não é isso|nao e isso)\b/i.test(lower);
  if (numMatch) {
    const token = String(numMatch[1] || '').toLowerCase();
    const newQty = Number(token) || qtyWords[token] || 1;
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

// ── Helpers para integração com JSON Schema extraction ──────────────────

/**
 * Gera uma amostra compacta do catálogo para incluir como hint na extração.
 * Máximo 30 itens para não estourar tokens.
 */
function buildMenuSample(catalog) {
  if (!Array.isArray(catalog) || !catalog.length) return '';
  const items = catalog.slice(0, 30).map((i) => {
    const name = cleanText(i?.name || '');
    const price = Number(i?.unit_price || 0);
    return name ? `- ${name}${price ? ` (R$${price.toFixed(2)})` : ''}` : null;
  }).filter(Boolean);
  return items.length ? items.join('\n') : '';
}

/**
 * Mapeia resultado do extractIntentSchema para o formato do classifierAgent.
 * Permite usar o novo extrator sem quebrar o pipeline existente.
 */
function mapSchemaIntentToClassification(schemaResult) {
  const action = schemaResult?.action || 'unknown';
  const map = {
    add_item: { intent: INTENTS.NOVO_PEDIDO, requires_extraction: true, confidence: 0.95 },
    remove_item: { intent: INTENTS.GERENCIAMENTO, requires_extraction: true, confidence: 0.9 },
    update_quantity: { intent: INTENTS.GERENCIAMENTO, requires_extraction: true, confidence: 0.9 },
    set_address: { intent: INTENTS.GERENCIAMENTO, requires_extraction: true, confidence: 0.9 },
    set_payment: { intent: INTENTS.PAGAMENTO, requires_extraction: true, confidence: 0.9 },
    set_mode: { intent: INTENTS.GERENCIAMENTO, requires_extraction: true, confidence: 0.9 },
    confirm_order: { intent: INTENTS.GERENCIAMENTO, requires_extraction: false, confidence: 0.95 },
    cancel_order: { intent: INTENTS.CANCELAMENTO, requires_extraction: false, confidence: 0.95 },
    ask_menu: { intent: INTENTS.CONSULTA, requires_extraction: false, confidence: 0.9 },
    ask_question: { intent: INTENTS.CONSULTA, requires_extraction: false, confidence: 0.9 },
    greeting: { intent: INTENTS.SAUDACAO, requires_extraction: false, confidence: 0.85 },
    unknown: { intent: INTENTS.GERENCIAMENTO, requires_extraction: true, confidence: 0.5 },
  };
  const base = map[action] || map.unknown;
  return { ...base, handoff: false };
}

/**
 * Mapeia resultado do extractIntentSchema para o formato do extractorAgent.
 * Extrai items, address, payment, mode, etc. do schema result.
 */
function mapSchemaIntentToExtracted(schemaResult) {
  const sr = schemaResult || {};
  const out = {
    mode: sr.mode || null,
    payment: sr.payment || null,
    customer_name: sr.customer_name || null,
    notes: sr.notes || null,
    items: [],
    address: sr.address || {},
  };
  // Items do schema (array ou single)
  if (Array.isArray(sr.items) && sr.items.length) {
    out.items = sr.items.map((i) => ({
      name: cleanText(i.name || ''),
      quantity: Math.max(1, Number(i.quantity || 1)),
      incremental: Boolean(i.incremental),
    })).filter((i) => i.name);
  } else if (sr.item_name) {
    out.items = [{
      name: cleanText(sr.item_name),
      quantity: Math.max(1, Number(sr.quantity || 1)),
      incremental: false,
    }];
  }
  return out;
}

async function classifierAgent({ runtime, conversation, groupedText }) {
  const lower = groupedText.toLowerCase();
  if (/atendente|humano|pessoa/.test(lower)) return { intent: INTENTS.HUMANO, requires_extraction: false, handoff: true, confidence: 1 };

  // CORREÇÃO: regex ANTES do classificador LLM — nunca deixar modelo decidir isso
  const correction = detectCorrectionStable(groupedText);
  if (correction.isCorrection) {
    return { intent: 'CORRECAO', requires_extraction: false, handoff: false, confidence: 0.95, correction };
  }

  const hasCartItems = Array.isArray(conversation.transaction?.items) && conversation.transaction.items.length > 0;
  const isRemoveIntent = /\b(retira|retire|remov[ae]r?|tira\s+[ao]|tire\s+[ao]|n[aã]o\s+quero\s+(mais\s+)?(a\s+|o\s+)?|exclui|exclu[ií]r?|deleta|delet[ae]r?)\b/i.test(lower);
  if (isRemoveIntent && hasCartItems) {
    return { intent: 'REMOVER_ITEM', requires_extraction: false, handoff: false, confidence: 0.95, _isRemove: true };
  }

  const isSpecification = /\b([eé]|era|troca|substitui|mud[ae]|altera)\s+(lata|latinha|\d+\s*l)|\blata\s+n[aã]o\b|\b([eé]|era|troca|substitui|mud[ae]|altera)\s+\d+\s*l\b/i.test(lower);
  if (isSpecification && hasCartItems) {
    return { intent: 'SUBSTITUIR_ITEM', requires_extraction: false, handoff: false, confidence: 0.9, _isReplace: true };
  }

  const isTaxaQuery = /\b(taxa\s*(de)?\s*entrega|valor\s*(da)?\s*(taxa|entrega)|quanto\s*(custa|e|eh|fica)\s*(a\s*)?(taxa|entrega|delivery))\b/i.test(lower);
  if (isTaxaQuery) {
    return { intent: INTENTS.CONSULTA, requires_extraction: false, handoff: false, confidence: 0.99, _subIntent: 'DELIVERY_FEE' };
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
    // ── JSON Schema extraction (substitui LLM não-estruturado) ──────────
    const schemaResult = await extractIntentSchema(openai, groupedText, {
      model: runtime.model,
      menuSample: buildMenuSample(conversation.catalog || []),
    });
    // Armazenar resultado bruto para uso pelo pipeline de extração
    conversation._lastSchemaIntent = schemaResult;
    const mapped = mapSchemaIntentToClassification(schemaResult);
    return { ...mapped, handoff: false };
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

  const nameMatch = groupedText.match(/(?:meu nome (?:e|eh)|sou|chamo-me|me chamo)\s+([A-Za-z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF\s]{2,60})/i);
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

function _mergeRestaurantTransactionLegacy(conv, extracted) {
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
        if (item.incremental) existing.quantity += toNumberOrOne(item.quantity);
        else existing.quantity = toNumberOrOne(item.quantity);
        if (Number(existing.quantity || 0) !== before) changed = true;
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

/**
 * V2: Usa tools de business-logic.js para merge determinístico.
 * Items são validados contra catálogo antes de adicionar.
 */
function mergeRestaurantTransaction(conv, extracted) {
  const catalog = conv.catalog || [];

  // ── Customer name ──
  if (extracted.customer_name) {
    const next = cleanText(extracted.customer_name);
    if (next && next !== cleanText(conv.transaction.customer_name)) {
      conv.transaction.customer_name = next;
      markFieldChanged(conv, 'customer_name');
    }
  }

  // ── Notes ──
  if (typeof extracted.notes === 'string' && extracted.notes) {
    const next = cleanText(extracted.notes);
    if (next && next !== cleanText(conv.transaction.notes)) {
      conv.transaction.notes = next;
      markFieldChanged(conv, 'notes');
    }
  }

  // ── Mode (via business-logic pattern) ──
  if (extracted.mode && extracted.mode !== conv.transaction.mode) {
    conv.transaction.mode = extracted.mode;
    markFieldChanged(conv, 'mode');
  }

  // ── Payment (via setPayment tool) ──
  if (extracted.payment) {
    const payResult = setPayment(extracted.payment, conv.transaction);
    if (payResult.success && extracted.payment !== conv.transaction.payment) {
      // setPayment already set conv.transaction.payment
    }
    if (payResult.success) markFieldChanged(conv, 'payment');
  }

  // ── Change/Troco (detecção automática para pagamento em dinheiro) ──
  if (conv.transaction.payment === 'CASH') {
    const text = cleanText(extracted._rawText || '');
    if (/\b(sem troco|n[aã]o precis[ao]? de troco|n[aã]o quero troco|troco n[aã]o|dispenso troco)\b/i.test(text)) {
      conv.transaction.change_for = 'nao';
      markFieldChanged(conv, 'change_for');
    } else {
      const trocoMatch = text.match(/troco\s+(?:para?|pra|de)\s+(\d+[\.,]?\d*)/i)
        || text.match(/(\d+[\.,]?\d*)\s+(?:de\s+)?troco/i);
      if (trocoMatch) {
        conv.transaction.change_for = trocoMatch[1].replace(',', '.');
        markFieldChanged(conv, 'change_for');
      } else {
        const pureAmountMatch = text.match(/^\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*$/);
        const awaitingChange = conv.pendingFieldConfirmation === 'change_for'
          || conv.state === STATES.COLETANDO_PAGAMENTO
          || conv.state === STATES.FINALIZANDO;
        if (pureAmountMatch && awaitingChange) {
          conv.transaction.change_for = pureAmountMatch[1].replace(',', '.');
          markFieldChanged(conv, 'change_for');
        }
      }
    }
    if (extracted.change_for) {
      conv.transaction.change_for = String(extracted.change_for).replace(',', '.');
      markFieldChanged(conv, 'change_for');
    }
  }

  // ── Items (via addItemToCart tool — valida contra catálogo) ──
  if (Array.isArray(extracted.items)) {
    let changed = false;
    for (const item of extracted.items) {
      const name = cleanText(item.name || item.nome || '');
      if (!name) continue;

      // Tentar via business-logic (validação de catálogo)
      const result = addItemToCart(
        { item_name: name, quantity: toNumberOrOne(item.quantity), incremental: Boolean(item.incremental) },
        catalog,
        conv.transaction
      );

      if (result.success) {
        changed = true;
      } else {
        // Fallback: item não encontrado no catálogo — adicionar direto (compatibilidade)
        const existing = conv.transaction.items.find((i) => {
          if (cleanText(item.integration_code) && cleanText(i.integration_code)) {
            return cleanText(i.integration_code) === cleanText(item.integration_code);
          }
          return normalizeForMatch(i.name) === normalizeForMatch(name);
        });
        if (existing) {
          if (item.incremental) existing.quantity += toNumberOrOne(item.quantity);
          else existing.quantity = toNumberOrOne(item.quantity);
          if (!existing.integration_code && item.integration_code) existing.integration_code = String(item.integration_code);
          if (!existing.unit_price && Number(item.unit_price || 0)) existing.unit_price = Number(item.unit_price);
        } else {
          conv.transaction.items.push({
            name,
            quantity: toNumberOrOne(item.quantity),
            integration_code: item.integration_code || null,
            unit_price: Number(item.unit_price || 0) || null,
          });
        }
        changed = true;
      }
    }
    if (changed) {
      markFieldChanged(conv, 'items');
      conv.upsellDone = false;
      conv.itemsPhaseComplete = false;
    }
  }

  // ── Address (via setAddress tool — merge progressivo) ──
  if (extracted.address && typeof extracted.address === 'object') {
    // Filtrar valores não-informativos antes de passar para setAddress
    const cleanAddr = {};
    for (const [k, v] of Object.entries(extracted.address)) {
      const next = cleanText(v);
      if (next && !isNonInformativeFieldValue(next)) cleanAddr[k] = next;
    }
    if (Object.keys(cleanAddr).length) {
      const addrResult = setAddress(cleanAddr, conv.transaction);
      if (addrResult.success) {
        for (const k of Object.keys(cleanAddr)) {
          markFieldChanged(conv, `address.${k}`);
        }
      }
    }
  }

  // ── Auto-detect delivery mode ──
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
  // Troco obrigatório quando pagamento é dinheiro
  if (tx.payment === 'CASH' && !cleanText(tx.change_for) && tx.change_for !== 'nao') {
    missing.push('change_for');
  }
  return missing;
}

function clearTransactionField(tx, field) {
  if (field === 'customer_name') tx.customer_name = '';
  else if (field === 'notes') tx.notes = '';
  else if (field === 'mode') tx.mode = '';
  else if (field === 'payment') tx.payment = '';
  else if (field === 'change_for') tx.change_for = '';
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
    'change_for': 'troco',
  };
  return labels[field] || field;
}

function fieldConfirmationValue(tx, field) {
  if (field === 'customer_name') return tx.customer_name || '-';
  if (field === 'notes') return tx.notes || '-';
  if (field === 'mode') return tx.mode === 'TAKEOUT' ? 'retirada' : 'entrega';
  if (field === 'payment') return tx.payment === 'PIX' ? 'PIX' : (tx.payment === 'CARD' ? 'cartão' : (tx.payment === 'CASH' ? 'dinheiro' : (tx.payment || '-')));
  if (field === 'change_for') return tx.change_for ? `R$ ${tx.change_for}` : '-';
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

/**
 * orchestrateV2 — usa state-machine.transition() como motor central.
 * Preserva toda lógica de negócio (repeat order, upsell, confirmation, correction).
 */
function orchestrate({ runtime, conversation, customer, classification, extracted, groupedText }) {
  // ── Merge (igual ao V1) ──
  if (runtime.segment === 'restaurant') {
    const extractedHasItems = Array.isArray(extracted?.items) && extracted.items.length > 0;
    const mergeExtracted = (classification.intent === INTENTS.CONSULTA && !extractedHasItems)
      ? { ...extracted, items: [] }
      : (extracted || {});
    mergeRestaurantTransaction(conversation, mergeExtracted);
  }
  if (runtime.segment === 'restaurant') enrichAddressWithCompanyDefaults(conversation);
  if (runtime.segment === 'restaurant') conversation.pendingFieldConfirmation = null;

  if (runtime.segment === 'restaurant' && Array.isArray(conversation.transaction?.items)) {
    const amounts = calculateOrderAmounts(conversation.transaction, conversation);
    conversation.transaction.total_amount = amounts.total;
  }

  // ── Handoff (igual ao V1) ──
  const handoff = classification.handoff
    || classification.intent === INTENTS.HUMANO
    || Number(classification.confidence || 0) < 0.45
    || /(raiva|horrivel|horrible|péssimo|pessimo|absurdo|ridículo|ridiculo|lamentável|lamentavel|inacreditável|inacreditavel|vergonha|uma merda|tô bravo|to bravo|tô com raiva|to com raiva|que saco|tô puto|to puto|não acredito|nao acredito|péssimo atendimento|pessimo atendimento)/i.test(groupedText)
    || (conversation.consecutiveFailures || 0) >= 3;
  if (handoff) return { nextState: STATES.HUMAN_HANDOFF, action: 'HUMAN_HANDOFF', missing: [] };

  // ── Normalizar estado legado ──
  let s = conversation.state;
  if (s === 'COLLECTING_DATA') s = STATES.ADICIONANDO_ITEM;
  if (s === 'WAITING_CONFIRMATION') s = STATES.FINALIZANDO;
  conversation.state = s;

  const i = classification.intent;
  const yes = detectYes(groupedText);
  const no = detectNo(groupedText);
  const menuQuery = isMenuQueryText(groupedText);
  const hasQuestion = /\?/.test(groupedText) || /\b(qual|quando|como|onde|que horas|card[aá]pio|pre[cç]o)\b/i.test(groupedText);

  // ── Clinic (passthrough) ──
  if (runtime.segment === 'clinic') {
    if (s === STATES.INIT && i === INTENTS.NOVO_PEDIDO) return { nextState: STATES.ADICIONANDO_ITEM, action: 'CLINIC_COLLECT', missing: ['service', 'date', 'time'] };
    if (s === STATES.FINALIZANDO && yes) return { nextState: STATES.CONFIRMED, action: 'CLINIC_CONFIRMED', missing: [] };
    if (s === STATES.FINALIZANDO && no) return { nextState: STATES.ADICIONANDO_ITEM, action: 'REQUEST_ADJUSTMENTS', missing: [] };
    return { nextState: s, action: s === STATES.INIT ? 'WELCOME' : 'ASK_MISSING_FIELDS', missing: ['service', 'date', 'time'] };
  }

  if (runtime.segment === 'restaurant' && menuQuery) {
    const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
      itemsPhaseComplete: conversation.itemsPhaseComplete,
    });
    return { nextState: s === STATES.INIT ? STATES.ADICIONANDO_ITEM : s, action: 'SHOW_MENU', missing };
  }

  // ── INIT: repeat order flow (preservado) ──
  if (s === STATES.INIT) {
    const today = nowISO().slice(0, 10);
    const hasPreviousOrder = Boolean(customer?.lastOrderSnapshot && Array.isArray(customer.lastOrderSnapshot.items) && customer.lastOrderSnapshot.items.length);

    if (conversation.awaitingRepeatChoice && hasPreviousOrder) {
      if (yes) {
        applySnapshotToConversation(conversation, customer.lastOrderSnapshot);
        conversation.awaitingRepeatChoice = false;
        return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
      }
      if (no) { conversation.awaitingRepeatChoice = false; conversation.repeatPreview = ''; }
      else return { nextState: STATES.INIT, action: hasQuestion ? 'ANSWER_AND_RESUME_REPEAT' : 'ASK_REPEAT_LAST_ORDER', missing: [] };
    }
    if (hasPreviousOrder && conversation.lastRepeatOfferDate !== today) {
      conversation.lastRepeatOfferDate = today;
      conversation.awaitingRepeatChoice = true;
      conversation.repeatPreview = customer.lastOrderSummary || formatOrderPreview(customer.lastOrderSnapshot);
      return { nextState: STATES.INIT, action: 'ASK_REPEAT_LAST_ORDER', missing: [] };
    }
  }

  // ── Mapear intent do classificador para action do state-machine ──
  const schemaIntent = conversation._lastSchemaIntent;
  let smAction = _mapIntentToAction(i, { yes, no, groupedText, state: s });
  console.log(`[ANA-DEBUG] ORCHESTRATE CHECK: state=${s}, intent=${i}, yes=${yes}, no=${no}, smAction=${smAction}`);

  // Se o mapping determinístico resultou em confirmação/cancelamento, priorizar sobre o schema.
  // Caso contrário, se o schema tem uma action sugerida, usá-la.
  if (smAction !== 'confirm_order' && smAction !== 'cancel_order' && schemaIntent?.action) {
    smAction = schemaIntent.action;
  }

  // ── FINALIZANDO: correction flow (preservado) ──
  if (s === STATES.FINALIZANDO) {
    const reviewAlreadyShown = hasRecentOrderReviewShown(conversation, 4);
    if (!reviewAlreadyShown) {
      return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
    }

    const missingBeforeConfirm = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
      itemsPhaseComplete: conversation.itemsPhaseComplete,
    });
    if (yes && missingBeforeConfirm.length > 0) {
      const firstMissing = missingBeforeConfirm[0];
      let subState = STATES.ADICIONANDO_ITEM;
      if (firstMissing === 'change_for' || firstMissing === 'payment') subState = STATES.COLETANDO_PAGAMENTO;
      else if (firstMissing.startsWith('address.')) subState = STATES.COLETANDO_ENDERECO;
      return { nextState: subState, action: 'ASK_MISSING_FIELDS', missing: missingBeforeConfirm };
    }

    if (i === 'CORRECAO' || /\b(faltou|corrige|corrigir|ajusta|ajustar|mudar|alterar|ta errado|tá errado|está errado|errado|errei|n[aã]o [eé] isso)\b/i.test(groupedText)) {
      const correction = classification.correction || detectCorrectionStable(groupedText);
      if (correction.type === 'QTY_UPDATE' && correction.newQty != null) {
        const corrText = normalizeForMatch(groupedText);
        const items = conversation.transaction.items || [];
        let corrected = false;
        for (const item of items) {
          const itemNorm = normalizeForMatch(item.name);
          if (corrText.includes(itemNorm) || itemNorm.includes(corrText.split(/\s+/).slice(-2).join(' '))) {
            item.quantity = correction.newQty;
            corrected = true;
            break;
          }
        }
        if (!corrected && items.length > 0) {
          for (const item of items) {
            if (item.quantity > correction.newQty) { item.quantity = correction.newQty; corrected = true; }
          }
        }
        const amounts = calculateOrderAmounts(conversation.transaction, conversation);
        conversation.transaction.total_amount = amounts.total;
        return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
      }
      if (no) return { nextState: STATES.FINALIZANDO, action: 'CORRECTION_REBUILD', missing: [] };
      return { nextState: STATES.FINALIZANDO, action: 'CORRECTION_REBUILD', missing: [] };
    }
    if (no) return { nextState: STATES.FINALIZANDO, action: 'CORRECTION_REBUILD', missing: [] };
    if (i === INTENTS.CONSULTA || hasQuestion) return { nextState: STATES.FINALIZANDO, action: 'ANSWER_AND_CONFIRM', missing: [] };
  }

  // ── Cancelamento explícito ──
  if ([STATES.ADICIONANDO_ITEM, STATES.MENU, STATES.CONFIRMANDO_CARRINHO, STATES.COLETANDO_ENDERECO, STATES.COLETANDO_PAGAMENTO].includes(s)) {
    const explicitCancel = /\b(cancela|cancelar|deixa quieto|desisti|desisto|aborta|encerrar pedido)\b/i.test(groupedText);
    if (explicitCancel || i === INTENTS.CANCELAMENTO) {
      conversation.transaction = { mode: '', customer_name: '', items: [], notes: '', address: { street_name: '', street_number: '', neighborhood: '', city: '', state: '', postal_code: '' }, payment: '', total_amount: 0, order_id: null };
      conversation.confirmed = {};
      conversation.pendingFieldConfirmation = null;
      conversation.upsellDone = false;
      conversation.itemsPhaseComplete = false;
      return { nextState: STATES.INIT, action: 'FLOW_CANCELLED', missing: [] };
    }
  }

  // ── STATE MACHINE TRANSITION (core determinístico) ──
  const smResult = smTransition(s, smAction, conversation.transaction, {
    requireAddress: runtime.delivery?.requireAddress !== false,
    itemsPhaseComplete: conversation.itemsPhaseComplete,
  });
  console.log(`[ANA-DEBUG] SM_RESULT: ${JSON.stringify(smResult)}`);

  // ── Field confirmation flow (preservado) ──
  if ([STATES.ADICIONANDO_ITEM, STATES.MENU, STATES.CONFIRMANDO_CARRINHO, STATES.COLETANDO_ENDERECO, STATES.COLETANDO_PAGAMENTO].includes(s)) {
    if (conversation.pendingFieldConfirmation) {
      const field = conversation.pendingFieldConfirmation;
      if (field === 'items' && Array.isArray(extracted?.items) && extracted.items.length) {
        conversation.pendingFieldConfirmation = null;
      }
    }
    if (conversation.pendingFieldConfirmation) {
      const field = conversation.pendingFieldConfirmation;
      if (yes) { conversation.confirmed[field] = true; conversation.pendingFieldConfirmation = null; }
      else if (no) {
        clearTransactionField(conversation.transaction, field);
        conversation.confirmed[field] = false;
        conversation.pendingFieldConfirmation = null;
        return { nextState: STATES.ADICIONANDO_ITEM, action: 'ASK_MISSING_FIELDS', missing: [field] };
      } else {
        return { nextState: STATES.ADICIONANDO_ITEM, action: hasQuestion ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION', missing: [field] };
      }
    }
  }

  // ── Upsell flow (preservado) ──
  const hasItems = Array.isArray(conversation.transaction.items) && conversation.transaction.items.length > 0;
  const hasNewItemsInMessage = Array.isArray(extracted?.items) && extracted.items.length > 0;
  const finishedSelectingItems = detectItemsPhaseDone(groupedText);
  if (hasNewItemsInMessage) conversation.itemsPhaseComplete = false;
  if (hasItems && !conversation.itemsPhaseComplete && finishedSelectingItems && !hasNewItemsInMessage) {
    conversation.itemsPhaseComplete = true;
    conversation.upsellDone = true;
  }
  if (hasItems && !conversation.itemsPhaseComplete && !conversation.upsellDone && i !== INTENTS.CANCELAMENTO && !yes && !no && !hasQuestion && !finishedSelectingItems) {
    conversation.upsellDone = true;
    const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, { itemsPhaseComplete: conversation.itemsPhaseComplete });
    return { nextState: STATES.ADICIONANDO_ITEM, action: 'UPSELL_SUGGEST', missing };
  }
  if (hasItems && !conversation.itemsPhaseComplete && conversation.upsellDone && (no || finishedSelectingItems) && !hasNewItemsInMessage) {
    conversation.itemsPhaseComplete = true;
    const updatedMissing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, { itemsPhaseComplete: true });
    return { nextState: STATES.ADICIONANDO_ITEM, action: 'ASK_MISSING_FIELDS', missing: updatedMissing };
  }
  if (
    [STATES.ADICIONANDO_ITEM, STATES.MENU, STATES.CONFIRMANDO_CARRINHO, STATES.COLETANDO_ENDERECO, STATES.COLETANDO_PAGAMENTO].includes(s)
    && yes
    && hasItems
    && conversation.itemsPhaseComplete
    && !conversation.pendingFieldConfirmation
  ) {
    const updatedMissing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
      itemsPhaseComplete: true,
    });
    if (!updatedMissing.length) return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
    const firstMissing = updatedMissing[0];
    let subState = STATES.ADICIONANDO_ITEM;
    if (firstMissing === 'mode') subState = STATES.CONFIRMANDO_CARRINHO;
    else if (firstMissing.startsWith('address.')) subState = STATES.COLETANDO_ENDERECO;
    else if (firstMissing === 'payment' || firstMissing === 'change_for') subState = STATES.COLETANDO_PAGAMENTO;
    return { nextState: subState, action: 'ASK_MISSING_FIELDS', missing: updatedMissing };
  }

  // ── Calcular missing fields (determinístico) ──
  const missing = restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
    itemsPhaseComplete: conversation.itemsPhaseComplete,
  });

  // ── Field pending confirmation ──
  if (missing.length && !conversation.pendingFieldConfirmation) {
    const firstMissing = missing[0];
    const hasValueForField = firstMissing === 'items'
      ? Array.isArray(conversation.transaction.items) && conversation.transaction.items.length > 0
      : firstMissing.startsWith('address.')
        ? Boolean(cleanText(conversation.transaction.address?.[firstMissing.slice('address.'.length)]))
        : Boolean(cleanText(conversation.transaction[firstMissing]));
    if (firstMissing !== 'items' && hasValueForField) conversation.pendingFieldConfirmation = firstMissing;
  }
  if (conversation.pendingFieldConfirmation === 'items') conversation.pendingFieldConfirmation = null;
  if (conversation.pendingFieldConfirmation) {
    let subState = STATES.ADICIONANDO_ITEM;
    if (conversation.pendingFieldConfirmation.startsWith('address.')) subState = STATES.COLETANDO_ENDERECO;
    else if (conversation.pendingFieldConfirmation === 'payment') subState = STATES.COLETANDO_PAGAMENTO;
    else if (conversation.pendingFieldConfirmation === 'mode') subState = STATES.CONFIRMANDO_CARRINHO;
    return { nextState: subState, action: (i === INTENTS.CONSULTA || hasQuestion) ? 'ANSWER_AND_RESUME_CONFIRM' : 'ASK_FIELD_CONFIRMATION', missing: [conversation.pendingFieldConfirmation] };
  }

  // ── Usar resultado do state-machine (com override para missing/sub-estado) ──
  if (missing.length) {
    let subState = STATES.ADICIONANDO_ITEM;
    const firstMissing = missing[0];
    if (firstMissing === 'items') subState = STATES.ADICIONANDO_ITEM;
    else if (firstMissing === 'mode') subState = STATES.CONFIRMANDO_CARRINHO;
    else if (firstMissing.startsWith('address.')) subState = STATES.COLETANDO_ENDERECO;
    else if (firstMissing === 'payment') subState = STATES.COLETANDO_PAGAMENTO;
    return { nextState: subState, action: (i === INTENTS.CONSULTA || hasQuestion) ? 'ANSWER_AND_RESUME' : smResult.action, missing };
  }

  if (smResult.nextState === STATES.FINALIZANDO && !hasRecentOrderReviewShown(conversation, 4)) {
    return { nextState: STATES.FINALIZANDO, action: 'ORDER_REVIEW', missing: [] };
  }

  return { nextState: smResult.nextState, action: smResult.action, missing: [] };
}

/**
 * Mapeia intent do classificador para action do state-machine.
 */
function _mapIntentToAction(intent, ctx) {
  if (ctx.yes && ctx.state === STATES.FINALIZANDO) return 'confirm_order';
  if (ctx.no && ctx.state === STATES.FINALIZANDO) return 'cancel_order';

  const map = {
    [INTENTS.NOVO_PEDIDO]: 'add_item',
    [INTENTS.SAUDACAO]: 'greeting',
    [INTENTS.CONSULTA]: 'ask_question',
    [INTENTS.CANCELAMENTO]: 'cancel_order',
    [INTENTS.PAGAMENTO]: 'set_payment',
    [INTENTS.GERENCIAMENTO]: 'add_item',
    [INTENTS.HUMANO]: 'unknown',
    [INTENTS.SPAM]: 'unknown',
  };
  return map[intent] || 'unknown';
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
  }, 5 * ONE_MINUTE_MS);

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
  }, 30 * ONE_MINUTE_MS);

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
  console.log('[CATÁLOGO DE TESTE]:', conversation.catalog.map(i => i.name).join(', '));
  return conversation.catalog;
}

function hasRecentOrderReviewShown(conversation, lookback = 6) {
  const recent = Array.isArray(conversation?.messages)
    ? conversation.messages.slice(-Math.max(1, Number(lookback) || 1))
    : [];
  console.log(`[ANA-DEBUG] CHECK_REVIEW: checking ${recent.length} recent messages`);
  return recent.some((m) => {
    if (m?.role !== 'assistant') return false;
    const text = normalizeForMatch(m?.content || '');
    const found = text.includes('subtotal');
    if (found) console.log(`[ANA-DEBUG] CHECK_REVIEW: found 'subtotal' in message: ${text.slice(0, 30)}...`);
    return found;
  });
}

/**
 * Retroativamente popula unit_price nos itens do carrinho que
 * ficaram sem preço (null/0) mas têm match no catálogo atual.
 * Chamada sempre que o catálogo for (re)carregado.
 */
function backfillItemPricesFromCatalog(conv) {
  const catalog = conv?.catalog;
  if (!Array.isArray(catalog) || !catalog.length) return;
  const items = conv?.transaction?.items;
  if (!Array.isArray(items) || !items.length) return;

  for (const item of items) {
    if (Number(item?.unit_price || 0) > 0) continue;

    const normName = normalizeForMatch(item?.name || '');
    if (!normName) continue;
    let bestMatch = null;
    let bestScore = 0;

    for (const cat of catalog) {
      const catNorm = normalizeForMatch(cat?.name || '');
      if (!catNorm) continue;
      let score = 0;
      if (catNorm === normName) score = 100;
      else if (catNorm.includes(normName) || normName.includes(catNorm)) score = 70;
      else {
        const catTokens = new Set(canonicalTokens(catNorm));
        const itemTokens = canonicalTokens(normName);
        const overlap = itemTokens.filter((t) => catTokens.has(t)).length;
        if (overlap > 0 && itemTokens.length > 0) {
          score = Math.round((overlap / itemTokens.length) * 60);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = cat;
      }
    }

    if (bestMatch && bestScore >= 60 && Number(bestMatch?.unit_price || 0) > 0) {
      item.unit_price = Number(bestMatch.unit_price);
      if (!item.integration_code && bestMatch.integration_code) {
        item.integration_code = bestMatch.integration_code;
      }
      if (bestScore === 100 && cleanText(bestMatch.name)) {
        item.name = cleanText(bestMatch.name);
      }
    }
  }
}

/**
 * Remove um item do carrinho a partir de texto livre.
 * Retorna true se removeu algo.
 */
function applyItemRemoval(conversation, text) {
  const items = conversation?.transaction?.items;
  if (!Array.isArray(items) || !items.length) return false;

  const normText = normalizeForMatch(text);
  const cleaned = normText
    .replace(/\b(retira|retire|remov[ae]r?|tira|tire|nao\s+quero\s+mais?|nao\s+quero|sem|exclui|excluir|deleta|cancel[ae])\b/gi, ' ')
    .replace(/\b(a|o|as|os|mais|item|esse|esta|este|por\s+favor)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 2) return false;

  const targetTokens = new Set(canonicalTokens(cleaned));
  if (!targetTokens.size) return false;

  let bestIdx = -1;
  let bestScore = 0;

  for (let idx = 0; idx < items.length; idx++) {
    const itemNorm = normalizeForMatch(items[idx]?.name || '');
    const itemTokens = canonicalTokens(itemNorm);
    const overlap = itemTokens.filter((t) => targetTokens.has(t)).length;
    const score = itemTokens.length > 0 ? overlap / itemTokens.length : 0;
    const exactMatch = itemNorm.includes(cleaned) || cleaned.includes(itemNorm);
    const finalScore = exactMatch ? 1 : score;
    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestIdx = idx;
    }
  }

  if (bestIdx >= 0 && bestScore >= 0.5) {
    items.splice(bestIdx, 1);
    conversation.itemsPhaseComplete = false;
    conversation.upsellDone = false;
    return true;
  }
  return false;
}

/**
 * Substitui um item do carrinho por outro (ex.: coca 1,5L -> coca lata).
 * Retorna true se substituiu.
 */
function applyItemReplacement(conversation, text, extractedItems = []) {
  const items = conversation?.transaction?.items;
  const catalog = Array.isArray(conversation?.catalog) ? conversation.catalog : [];
  if (!Array.isArray(items) || !items.length || !catalog.length) return false;

  const normText = normalizeForMatch(text);
  const wantsLata = /\b(lata|latinha)\b/.test(normText);
  const wants15l = /\b1[,.]?\s*5\s*l\b|\b1[,.]?5l\b/.test(normText);
  const wants2l = /\b2\s*l\b|\b2l\b/.test(normText);
  const wantsCocaFamily = /\b(coca|cola)\b/.test(normText)
    || (Array.isArray(extractedItems) && extractedItems.some((it) => /\b(coca|cola)\b/.test(normalizeForMatch(it?.name || ''))));

  const pickCatalogMatch = (query) => {
    const q = normalizeForMatch(query);
    if (!q) return null;
    let best = null;
    let bestScore = 0;
    const qTokens = new Set(canonicalTokens(q));
    for (const cat of catalog) {
      const catNorm = normalizeForMatch(cat?.name || '');
      if (!catNorm) continue;
      let score = 0;
      if (catNorm === q) score = 100;
      else if (catNorm.includes(q) || q.includes(catNorm)) score = 80;
      else {
        const ct = canonicalTokens(catNorm);
        const overlap = ct.filter((t) => qTokens.has(t)).length;
        score = ct.length ? Math.round((overlap / ct.length) * 60) : 0;
      }
      if (score > bestScore) {
        bestScore = score;
        best = cat;
      }
    }
    return bestScore >= 50 ? best : null;
  };

  let replacement = null;
  if (Array.isArray(extractedItems) && extractedItems.length) {
    replacement = pickCatalogMatch(extractedItems[0]?.name || '');
  }
  if (!replacement && wantsCocaFamily && wantsLata) {
    replacement = catalog.find((c) => {
      const n = normalizeForMatch(c?.name || '');
      return n.includes('coca') && n.includes('lata');
    }) || null;
  }
  if (!replacement && wantsCocaFamily && wants15l) {
    replacement = catalog.find((c) => {
      const n = normalizeForMatch(c?.name || '');
      return n.includes('coca') && (n.includes('1 5') || n.includes('1,5') || n.includes('1.5') || n.includes('1 5l') || n.includes('1 5 l') || n.includes('1 5lt') || n.includes('1 5 lt'));
    }) || null;
  }
  if (!replacement && wantsCocaFamily && wants2l) {
    replacement = catalog.find((c) => {
      const n = normalizeForMatch(c?.name || '');
      return n.includes('coca') && (n.includes('2l') || n.includes('2 l'));
    }) || null;
  }
  if (!replacement) return false;

  const replacementNorm = normalizeForMatch(replacement?.name || '');
  if (!replacementNorm) return false;

  const targetIdx = items.findIndex((it) => {
    const n = normalizeForMatch(it?.name || '');
    if (!n || n === replacementNorm) return false;
    if (wantsCocaFamily) return n.includes('coca') || n.includes('cola');
    const repTokens = new Set(canonicalTokens(replacementNorm));
    const itTokens = canonicalTokens(n);
    const overlap = itTokens.filter((t) => repTokens.has(t)).length;
    return itTokens.length > 0 && (overlap / itTokens.length) >= 0.5;
  });
  if (targetIdx < 0) return false;

  const oldItem = items[targetIdx];
  const qty = Math.max(1, Number(oldItem?.quantity || 1));
  const existingIdx = items.findIndex((it, idx) => idx !== targetIdx && normalizeForMatch(it?.name || '') === replacementNorm);
  if (existingIdx >= 0) {
    items[existingIdx].quantity = Math.max(1, Number(items[existingIdx].quantity || 1) + qty);
    items.splice(targetIdx, 1);
  } else {
    items[targetIdx] = {
      name: replacement.name,
      quantity: qty,
      integration_code: replacement.integration_code || null,
      unit_price: Number(replacement.unit_price || 0) || null,
    };
  }

  conversation.itemsPhaseComplete = false;
  conversation.upsellDone = false;
  return true;
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
  if (detectYes(text) || detectNo(text)) return;
  const isNumericOnly = /^\s*\d+[\.,]?\d*\s*$/.test(text);
  const numericFields = ['address.street_number', 'address.postal_code', 'change_for'];
  if (isNumericOnly && !numericFields.includes(pendingField)) return;
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
  let feeInfo = null;
  if (tx?.mode === 'DELIVERY') {
    feeInfo = resolveDeliveryFee(conversation, tx);
    if (!feeInfo) {
      const flatFee = resolveFlatDeliveryFee(conversation);
      if (flatFee > 0) {
        feeInfo = {
          neighborhood: cleanText(tx?.address?.neighborhood || ''),
          fee: flatFee,
        };
      }
    }
  }
  const feeCents = feeInfo ? Math.round(Number(feeInfo.fee || 0) * 100) : 0;
  return { itemTotal, feeCents, total: itemTotal + feeCents, feeInfo };
}

function generateOrderSummary(tx, conversation = null, { withConfirmation = true } = {}) {
  const safeTx = tx || {};

  const itemLines = (safeTx.items || []).map((it) => {
    const unitPrice = Number(it.unit_price || 0);
    const qty = Number(it.quantity || 1);
    const lineTotal = unitPrice * qty;
    const emoji = categorizeItem(it.name);
    const priceStr = lineTotal > 0 ? ` — *${formatBRL(lineTotal / 100)}*` : '';
    return `${emoji} ${it.name} (${qty})${priceStr}`;
  }).join('\n') || '• Sem itens';

  const paymentMap = { PIX: 'PIX', CARD: 'Cartão', CASH: 'Dinheiro' };
  const payment = paymentMap[safeTx.payment] || safeTx.payment || 'Não informado';

  const addrParts = [
    safeTx.address?.street_name,
    safeTx.address?.street_number ? `nº ${safeTx.address.street_number}` : '',
    safeTx.address?.neighborhood,
    safeTx.address?.city,
    safeTx.address?.state,
    safeTx.address?.postal_code ? `CEP ${safeTx.address.postal_code}` : '',
  ].filter(cleanText);
  const uniqueAddrParts = addrParts.filter((part, idx, arr) => {
    const normPart = normalizeForMatch(part);
    return !arr.slice(0, idx).some((prev) => normalizeForMatch(prev) === normPart);
  });

  const amounts = calculateOrderAmounts(safeTx, conversation);
  const feeNeighborhood = amounts.feeInfo?.neighborhood || cleanText(safeTx.address?.neighborhood || '');

  const lines = [
    '🧾 *Resumo do pedido*',
    '',
    itemLines,
    '',
  ];

  lines.push(`Subtotal: *${formatBRL(amounts.itemTotal / 100)}*`);

  if (safeTx.mode === 'DELIVERY') {
    const feeLabel = feeNeighborhood ? `🚚 Taxa de entrega (${feeNeighborhood})` : '🚚 Taxa de entrega';
    const feeValue = amounts.feeCents > 0 ? `*${formatBRL(amounts.feeCents / 100)}*` : '_a confirmar_';
    lines.push(`${feeLabel}: ${feeValue}`);
  }

  lines.push(`💰 *Total: ${formatBRL(amounts.total / 100)}*`);
  lines.push('');

  if (safeTx.mode === 'DELIVERY' && uniqueAddrParts.length) {
    lines.push(`📍 *Entrega:* ${uniqueAddrParts.join(', ')}`);
  } else if (safeTx.mode === 'TAKEOUT') {
    lines.push(`🏪 *Retirada no local*`);
  }

  lines.push(`💳 *Pagamento:* ${payment}`);

  if (safeTx.payment === 'CASH' && safeTx.change_for) {
    const normalizedChange = Number(String(safeTx.change_for).replace(/[^\d,.-]/g, '').replace(',', '.'));
    const changeVal = Number.isFinite(normalizedChange) ? normalizedChange : Number(safeTx.change_for);
    const changeText = Number.isFinite(changeVal) ? formatBRL(changeVal) : safeTx.change_for;
    lines.push(`💵 *Troco para:* ${changeText}`);
    if (Number.isFinite(changeVal) && changeVal > 0) {
      const delta = changeVal - (amounts.total / 100);
      if (delta >= 0) lines.push(`💸 *Troco:* ${formatBRL(delta)}`);
    }
  }

  if (withConfirmation) lines.push('', 'Está tudo certo para confirmar? 😊');

  return lines.join('\n');
}

async function createSaiposOrder({ conversation, customer, runtime, apiRequest, getEnvConfig, log }) {
  if (runtime.segment !== 'restaurant') return { ok: true, skipped: true };

  const { ok, payload, unresolved } = createOrderPayload({ conversation, customer, runtime });
  if (!ok) return { ok: false, unresolved };

  const order_id = `${runtime.id}-ANA-${Date.now()}`;
  const display_id = String(Date.now()).slice(-4);
  const paymentCode = conversation.transaction.payment === 'PIX' ? 'PARTNER_PAYMENT' : 'CRE';
  const cfg = getEnvConfig(runtime.environment);

  const body = {
    order_id,
    display_id,
    cod_store: cfg.codStore,
    created_at: nowISO(),
    notes: payload.observations,
    total_amount: payload.total * 100,
    total_discount: 0,
    order_method: {
      mode: conversation.transaction.mode || 'DELIVERY',
      scheduled: false,
      delivery_date_time: nowISO(),
      ...((conversation.transaction.mode || 'DELIVERY') === 'DELIVERY' ? { delivery_by: 'RESTAURANT', delivery_fee: payload.delivery_fee * 100 } : {}),
    },
    customer: { id: payload.customer_phone, name: payload.customer_name, phone: payload.customer_phone },
    ...(((conversation.transaction.mode || 'DELIVERY') === 'DELIVERY') ? {
      delivery_address: {
        street_name: payload.address,
        street_number: payload.address_number || 'S/N',
        neighborhood: payload.neighborhood,
        district: payload.neighborhood,
        city: payload.city,
        state: payload.state,
        country: 'BR',
        postal_code: payload.zip_code,
      },
    } : {}),
    items: payload.items.map(i => ({ ...i, desc_item: i.name, unit_price: i.price * 100 })),
    payment_types: [{ code: paymentCode, amount: payload.total * 100, change_for: 0 }],
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



async function createAnaFoodOrder({ conversation, customer, runtime, log }) {
  if (runtime.segment !== 'restaurant') return { ok: true, skipped: true };
  if (!runtime.anafood.endpoint) return { ok: false, error: 'ANAFOOD endpoint nao configurado' };

  const { ok, payload, unresolved } = createOrderPayload({ conversation, customer, runtime });
  if (!ok) return { ok: false, unresolved };

  const anaFoodPayload = {
    action: 'create',
    ...(runtime.anafood.companyId ? { company_id: runtime.anafood.companyId } : {}),
    order: {
      ...payload,
      ...(runtime.anafood.companyId ? { company_id: runtime.anafood.companyId } : {}),
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
    items: anaFoodPayload.order.items,
    total: anaFoodPayload.order.total,
    delivery_fee: anaFoodPayload.order.delivery_fee,
    customer: anaFoodPayload.order.customer_name,
    payment: anaFoodPayload.order.payment_method,
    type: anaFoodPayload.order.type,
  });

  try {
    const startMs = Date.now();
    const response = await fetch(runtime.anafood.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(anaFoodPayload),
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

async function createOrderByProviderIfNeeded({ conversation, customer, runtime, apiRequest, getEnvConfig, log }) {
  if (runtime.segment !== 'restaurant') return { ok: true, skipped: true };
  if (conversation.transaction.order_id) return { ok: true, already: true };

  if (runtime.orderProvider === 'anafood') {
    return createAnaFoodOrder({ conversation, customer, runtime, log });
  }

  const saipos = await createSaiposOrder({ conversation, customer, runtime, apiRequest, getEnvConfig, log });
  if (saipos.ok) return saipos;
  if (runtime.anafood?.endpoint) {
    log('INFO', 'Ana: fallback para AnaFood apos falha no SAIPOS', { tenantId: runtime.id, phone: conversation.phone, err: saipos.error || '' });
    return createAnaFoodOrder({ conversation, customer, runtime, log });
  }
  return saipos;
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
  const n = normalizeForMatch(name);
  if (isBeverageItemName(n)) return '🥤';
  if (isDessertItemName(n)) return '🍮';
  if (isSideItemName(n)) return '🍟';
  return '🍽️';
}



function resolveFlatDeliveryFee(conversation) {
  const raw = (
    conversation?.companyData?.deliveryFee
    ?? conversation?.companyData?.delivery_fee
    ?? conversation?.companyData?.company?.delivery_fee
    ?? conversation?.companyData?.company?.deliveryFee
    ?? 0
  );
  const fee = toReaisAmount(raw);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

function buildDeliveryFeeReply(conversation, userMessage = '') {
  const deliveryAreas = Array.isArray(conversation?.companyData?.deliveryAreas)
    ? conversation.companyData.deliveryAreas
    : [];
  const text = cleanText(userMessage).toLowerCase();

  const bairroMatch = text.match(/bairro\s+([a-z0-9\s]+)/i);
  if (bairroMatch && deliveryAreas.length) {
    const asked = normalizeForMatch(bairroMatch[1]);
    const found = deliveryAreas.find((a) => {
      const n = normalizeForMatch(a?.neighborhood || a?.bairro || a?.zone_name || a?.name || '');
      return n.includes(asked) || asked.includes(n);
    });
    if (found) {
      return `A taxa para ${found.neighborhood || found.bairro || found.zone_name || found.name || 'essa regiao'} e ${formatBRL(toReaisAmount(found?.fee ?? found?.taxa ?? found?.delivery_fee ?? 0))}.`;
    }
  }

  const tx = conversation?.transaction || {};
  if (cleanText(tx?.address?.neighborhood) || cleanText(tx?.address?.street_name)) {
    const feeInfo = resolveDeliveryFee(conversation, tx);
    if (feeInfo && Number(feeInfo.fee) > 0) {
      return `A taxa de entrega para ${feeInfo.neighborhood || tx.address.neighborhood || 'sua regiao'} e ${formatBRL(feeInfo.fee)}.`;
    }
  }

  const amounts = calculateOrderAmounts(tx, conversation);
  if (amounts.feeCents > 0) {
    return `A taxa de entrega para ${amounts.feeInfo?.neighborhood || tx?.address?.neighborhood || 'sua regiao'} e ${formatBRL(amounts.feeCents / 100)}.`;
  }

  const flatFee = resolveFlatDeliveryFee(conversation);
  if (flatFee > 0) {
    return `A taxa de entrega e ${formatBRL(flatFee)}.`;
  }

  if (deliveryAreas.length) {
    const sample = deliveryAreas
      .slice(0, 5)
      .map((a) => `• ${a.neighborhood || a.bairro || a.zone_name || a.name || 'Regiao'}: ${formatBRL(toReaisAmount(a?.fee ?? a?.taxa ?? a?.delivery_fee ?? 0))}`)
      .join('\n');
    return `As taxas de entrega sao:\n${sample}\n\nMe informa o seu bairro para calcular certinho.`;
  }

  return 'A taxa de entrega sera calculada com base no seu bairro. Pode informar o endereco que eu confirmo o valor completo.';
}

function fallbackText(runtime, action, tx, missing, conversation = null) {
  const firstName = cleanText(tx?.customer_name || '').split(' ')[0] || '';
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
    if (preview) return `Vi que seu último pedido foi:\n${preview}\n\nDeseja repetir o mesmo? 😊`;
    return `Vi que você já pediu aqui antes. Quer repetir o último pedido?`;
  }

  if (action === 'ASK_FIELD_CONFIRMATION') {
    const field = (missing || [])[0];
    if (!field) return 'Pode confirmar esse dado?';
    const label = fieldConfirmationLabel(field);
    const value = fieldConfirmationValue(tx, field);
    return `Só confirmar: ${label} é *${value}*? 😊`;
  }

  if (action === 'SHOW_MENU') {
    const follow = (() => {
      if (conversation?.state === STATES.FINALIZANDO) return fallbackText(runtime, 'ASK_CONFIRMATION', tx, missing, conversation);
      if (Array.isArray(missing) && missing.length) return fallbackText(runtime, 'ASK_MISSING_FIELDS', tx, missing, conversation);
      return 'O que voce vai querer hoje?';
    })();
    const menuText = buildMenuReply(conversation, follow);
    return menuText || 'No momento nao encontrei o cardapio cadastrado no banco de dados.';
  }

  if (action === 'DELIVERY_FEE_REPLY') {
    const feeReply = buildDeliveryFeeReply(conversation);
    const follow = (Array.isArray(missing) && missing.length)
      ? fallbackText(runtime, 'ASK_MISSING_FIELDS', tx, missing, conversation)
      : '';
    return follow ? `${feeReply}\n\n${follow}` : feeReply;
  }

  if (action === 'ASK_MISSING_FIELDS') {
    const first = (missing || [])[0];
    const payments = getAvailablePaymentMethods(runtime, conversation).join(', ');
    const hasItems = Array.isArray(tx?.items) && tx.items.length > 0;

    // Lógica para respostas mais inteligentes e contextuais
    const hasMode = cleanText(tx.mode);
    const hasPayment = cleanText(tx.payment);

    // Se já temos modo e pagamento, e falta o endereço, vamos direto ao ponto.
    if (hasMode && hasPayment && first && first.startsWith('address.')) {
      return `Ok, entendi. Para entrega com pagamento via ${tx.payment}, só preciso do seu endereço. Qual a rua?`;
    }

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
      'change_for': '💵 Pagamento em dinheiro. Vai precisar de troco? Se sim, pra quanto?\nSe não precisar, é só dizer "sem troco".',
    };
    if (!first) {
      if (hasItems) return generateOrderSummary(tx, conversation, { withConfirmation: true });
      return 'O que voce vai querer hoje?';
    }
    return map[first] || 'Me passa mais um dado para continuar.';
  }

  if (action === 'ANSWER_AND_RESUME') {
    const lastUser = cleanText(conversation?.messages?.slice(-1)?.[0]?.content || '').toLowerCase();
    const contextual = buildContextualAnswer(conversation, lastUser);
    if (contextual) {
      const follow = (Array.isArray(missing) && missing.length)
        ? fallbackText(runtime, 'ASK_MISSING_FIELDS', tx, missing, conversation)
        : (conversation?.state === STATES.FINALIZANDO
          ? fallbackText(runtime, 'ASK_CONFIRMATION', tx, missing, conversation)
          : '');
      return follow ? `${contextual}\n\n${follow}` : contextual;
    }
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

  if (action === 'ITEM_REMOVED') {
    const itemLines = (tx.items || []).map((it) => `• ${it.quantity}x ${it.name}`).join('\n') || '• Carrinho vazio';
    return `Removido! ✅ Seu carrinho agora:\n${itemLines}\n\nQuer acrescentar, remover ou alterar algum item? Se estiver tudo certo, me diga "somente isso".`;
  }

  if (action === 'ITEM_UPDATED') {
    const itemLines = (tx.items || []).map((it) => `• ${it.quantity}x ${it.name}`).join('\n') || '• Carrinho vazio';
    return `Atualizado! ✅ Seu carrinho agora:\n${itemLines}\n\nQuer acrescentar, remover ou alterar algum item? Se estiver tudo certo, me diga "somente isso".`;
  }

  // Garantir resumo completo (subtotal/taxa/total) em perguntas durante confirmacao final
  if (action === 'ANSWER_AND_CONFIRM') {
    return generateOrderSummary(tx, conversation, { withConfirmation: true });
  }

  if (action === 'ASK_CONFIRMATION') {
    const hasShownReview = hasRecentOrderReviewShown(conversation, 6);
    if (!hasShownReview) {
      return generateOrderSummary(tx, conversation, { withConfirmation: true });
    }
    return 'Está tudo certo para eu concluir o pedido? 😊';
  }

  if (action === 'ORDER_REVIEW') {
    return generateOrderSummary(tx, conversation, { withConfirmation: true });
  }

  if (action === 'CREATE_ORDER_AND_WAIT_PAYMENT') {
    const orderSummary = generateOrderSummary(tx, conversation, { withConfirmation: false });
    const pixKey = cleanText(
      conversation?.companyData?.company?.pix_key
      || conversation?.companyData?.pixKey
      || conversation?.companyData?.company?.chave_pix
      || ''
    );
    const pixLine = pixKey ? `\n\n🔑 *Chave PIX:* \`${pixKey}\`` : '';
    return `${orderSummary}\n\n⏳ *Aguardando pagamento via PIX*${pixLine}\n\nAssim que pagar, envie o comprovante aqui 🙌`;
  }

  if (action === 'CREATE_ORDER_AND_CONFIRM' || action === 'PAYMENT_CONFIRMED') {
    const eta = cleanText(runtime?.deliveryEstimate || '') || '30–45 minutos';
    const isDelivery = tx?.mode === 'DELIVERY';
    const nameBlock = firstName ? `, ${firstName}` : '';
    const orderSummary = generateOrderSummary(tx, conversation, { withConfirmation: false });
    const lines = [
      `✅ *Pedido confirmado${nameBlock}!*`,
      '',
      orderSummary,
      '',
      `Seu pedido já foi para a cozinha 👩‍🍳`,
    ];
    if (isDelivery) {
      lines.push(`⏱ Tempo estimado: ${eta}`);
      lines.push('');
      lines.push('Avisaremos quando sair para entrega 🚚');
    } else {
      lines.push(`⏱ Tempo estimado: ${eta}`);
      lines.push('');
      lines.push('Avisaremos quando estiver pronto para retirada 🏪');
    }
    lines.push('Se precisar de algo, é só chamar!');
    return lines.join('\n');
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
    return 'Claro! Vou te passar para um atendente agora. Um instante 😊';
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

  if (/\b(entrega|delivery|bairro|taxa)\b/.test(text)) {
    return buildDeliveryFeeReply(conversation, text);
  }

  if (/\b(valor|preco|quanto|marmita grande|marmita pequena|cardapio|menu)\b/.test(text) && !/\b(taxa|entrega|delivery|bairro)\b/.test(text)) {
    if (!menu.length) return 'No momento nao encontrei o cardapio cadastrado no banco de dados.';
    if (/\b(cardapio|menu)\b/.test(text)) {
      const full = menu
        .filter((i) => i.available !== false)
        .map((i) => `- ${i.name}${Number(i.price || 0) > 0 ? ` (${formatBRL(i.price)})` : ''}`)
        .join('\n');
      return `Cardapio de hoje:\n\n${full}`;
    }
    const sizeHint = text.includes('grande') ? 'grande' : (text.includes('pequena') ? 'pequena' : '');
    if (sizeHint) {
      const item = menu.find((i) => String(i?.name || '').toLowerCase().includes(sizeHint));
      if (item && Number(item.price || 0) > 0) return `A opcao ${item.name} esta por ${formatBRL(item.price)}.`;
    }
    const priced = menu.filter((i) => Number(i.price || 0) > 0).slice(0, 4);
    if (priced.length) {
      return `Alguns valores do cardapio: ${priced.map((i) => `${i.name} (${formatBRL(i.price)})`).join(', ')}.`;
    }
    return 'Encontrei o cardapio, mas sem precos preenchidos.';
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
    const externalSystemPrompt = loadAnaSystemPrompt();

    // Montar mensagens: system prompt + resumo de contexto + últimas N mensagens + input atual
    const messages = [];

    messages.push({
      role: 'system',
      content: `${externalSystemPrompt ? `${externalSystemPrompt}\n\n` : ''}Você é ${runtime.agentName}${companyName ? `, assistente virtual da ${companyName}` : ', assistente virtual'}. Tom: ${runtime.tone}.

IDENTIDADE DA MARCA:
${conversation.presented
          ? '- Já se apresentou nesta sessão. NÃO repita apresentação. Vá direto ao ponto.'
          : `- Apresente-se APENAS nesta primeira mensagem: "Olá! Aqui é a ${runtime.agentName}${companyName ? `, do ${companyName}` : ''} 👋"
- O nome da empresa DEVE aparecer na primeira mensagem. Sempre.`}
- NUNCA se reapresente após o primeiro contato.

USO DO NOME DO CLIENTE:
${customerFirstName
          ? `- Nome: ${customerFirstName}. Use APENAS na saudação inicial e na confirmação final do pedido.
- NÃO use o nome em mensagens intermediárias (perguntas, confirmações parciais, resumos). Isso soa robótico.`
          : '- Pergunte o nome se ainda não souber.'}

FLUXO DE VENDA (siga esta ordem):
1. Receber item → confirmar o que foi pedido
2. (action=UPSELL_SUGGEST) Sugerir complemento — nunca insistir
3. Perguntar retirada ou entrega
4. Coletar endereço (só se entrega)
5. Perguntar pagamento
6. Se pagamento = DINHEIRO → perguntar "Vai precisar de troco? Se sim, pra quanto?"
7. Apresentar resumo padronizado (o sistema já gera, use-o como base)
8. Pedir confirmação — SOMENTE por último

REGRAS OBRIGATÓRIAS:
- Respostas curtas e naturais (1-3 frases no máximo)
- Uma pergunta ou ação por vez
- Nunca invente preço, prazo ou regra
- Não repita informações já confirmadas
- Se não entender um item → pergunte o nome exato
- NUNCA mude quantidade já extraída; se houver dúvida → peça confirmação
- Responda perguntas laterais e retome o fluxo na etapa pendente

FORMATAÇÃO (WhatsApp):
- Mensagens curtas e escaneáveis — NÃO blocos de texto
- Use linhas em branco para separar seções
- Emojis funcionais (🍮=sobremesa, 🥤=bebida, 🚚=entrega, 📍=endereço, 💳=pagamento, 💰=total) — não decoração
- (action=ORDER_REVIEW) O sistema gera o resumo formatado. Envie-o como está, sem reescrever.
- Se "contextualHint" vier preenchido, use como base da resposta final.

PÓS-CONFIRMAÇÃO:
- Incluir ETA: "⏱ Tempo estimado: 30–45 minutos" (ou dado real se disponível)
- Informar que pedido foi para cozinha
- Avisar que entregador/retirada será comunicado

SEGURANÇA:
- Assistente virtual EXCLUSIVA da ${companyName || runtime.agentName}. NUNCA mencione outra empresa.
- NUNCA mencione "Mais Sistem", "Automação Comercial" ou fornecedor de software.

ESTILO: Linguagem natural brasileira. Prefira "já anotei", "pode deixar", "tudo certo". Evite palavras robóticas.

DADOS DO ESTABELECIMENTO:
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
  backfillItemPricesFromCatalog(conversation);

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

  // ── Merge: preencher lacunas do regex com resultados do JSON Schema ──
  if (conversation._lastSchemaIntent && shouldExtract) {
    const schemaExtracted = mapSchemaIntentToExtracted(conversation._lastSchemaIntent);
    // Items: se regex não encontrou items mas schema sim, usar schema
    if ((!Array.isArray(extracted.items) || !extracted.items.length) && schemaExtracted.items.length) {
      extracted.items = schemaExtracted.items;
    }
    // Mode: se regex não detectou, usar schema
    if (!extracted.mode && schemaExtracted.mode) extracted.mode = schemaExtracted.mode;
    // Payment: se regex não detectou, usar schema
    if (!extracted.payment && schemaExtracted.payment) extracted.payment = schemaExtracted.payment;
    // Customer name: se regex não detectou, usar schema
    if (!extracted.customer_name && schemaExtracted.customer_name) extracted.customer_name = schemaExtracted.customer_name;
    // Notes: se regex não detectou, usar schema
    if (!extracted.notes && schemaExtracted.notes) extracted.notes = schemaExtracted.notes;
    // Address: merge campo a campo (regex tem prioridade)
    if (schemaExtracted.address && typeof schemaExtracted.address === 'object') {
      if (!extracted.address) extracted.address = {};
      for (const [k, v] of Object.entries(schemaExtracted.address)) {
        if (v && !cleanText(extracted.address[k])) extracted.address[k] = v;
      }
    }
  }

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

  // Passar texto bruto para o merge detectar troco/change_for
  extracted._rawText = normalizedText;

  // Remocao/substituicao de item sao tratadas de forma deterministica para evitar re-adicao via merge.
  let deterministicCartMutation = '';
  if (runtime.segment === 'restaurant' && (classification._isRemove || classification._isReplace)) {
    const extractedItemsSnapshot = Array.isArray(extracted.items) ? [...extracted.items] : [];
    extracted.items = [];
    classification.intent = INTENTS.GERENCIAMENTO;

    if (classification._isRemove) {
      const removed = applyItemRemoval(conversation, normalizedText);
      if (removed) deterministicCartMutation = 'ITEM_REMOVED';
    } else if (classification._isReplace) {
      const replaced = applyItemReplacement(conversation, normalizedText, extractedItemsSnapshot);
      if (replaced) deterministicCartMutation = 'ITEM_UPDATED';
    }

    if (deterministicCartMutation) {
      const amounts = calculateOrderAmounts(conversation.transaction, conversation);
      conversation.transaction.total_amount = amounts.total;
      markFieldChanged(conversation, 'items');
    }
  }

  const previousState = conversation.state;
  const orchestratorResult = deterministicCartMutation
    ? {
      nextState: STATES.ADICIONANDO_ITEM,
      action: deterministicCartMutation,
      missing: restaurantMissingFields(runtime, conversation.transaction, conversation.confirmed, {
        itemsPhaseComplete: conversation.itemsPhaseComplete,
      }),
    }
    : orchestrate({ runtime, conversation, customer, classification, extracted, groupedText: normalizedText });
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
    const order = await createOrderByProviderIfNeeded({ conversation, customer, runtime, apiRequest, getEnvConfig, log });
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

  if (runtime.segment === 'restaurant' && classification._subIntent === 'DELIVERY_FEE') {
    orchestratorResult.action = 'DELIVERY_FEE_REPLY';
  }

  const alwaysDeterministicActions = new Set([
    'ORDER_REVIEW',
    'SHOW_MENU',
    'DELIVERY_FEE_REPLY',
    'ITEM_REMOVED',
    'ITEM_UPDATED',
    'ASK_MISSING_FIELDS',
    'ASK_FIELD_CONFIRMATION',
    'ASK_CONFIRMATION',
    'ANSWER_AND_RESUME',
    'ANSWER_AND_RESUME_CONFIRM',
    'ANSWER_AND_RESUME_REPEAT',
    'ANSWER_AND_CONFIRM',
    'UPSELL_SUGGEST',
    'REQUEST_ADJUSTMENTS',
    'CORRECTION_REBUILD',
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
  const effectiveRawReply = (replyContainsFailSafePhrase(rawReply) && orchestratorResult.action !== 'HUMAN_HANDOFF')
    ? fallbackText(runtime, orchestratorResult.action, conversation.transaction, orchestratorResult.missing || [], conversation)
    : rawReply;
  const reply = sanitizeAssistantReply({
    reply: effectiveRawReply,
    conversation,
    action: orchestratorResult.action,
  });
  // ── [ANA-DEBUG] RESPONSE ──────────────────────────────────────────────
  anaDebug('RESPONSE', {
    action: orchestratorResult.action,
    deterministic: alwaysDeterministicActions.has(orchestratorResult.action),
    rawReplyPreview: String(effectiveRawReply || '').slice(0, 200),
    finalReplyPreview: String(reply || '').slice(0, 200),
    sanitized: effectiveRawReply !== reply,
  });
  let finalReply = reply;
  if (conversation.state !== STATES.HUMAN_HANDOFF || !conversation.handoffNotified) {
    const today = nowISO().slice(0, 10);
    const shouldPrefixGreeting = previousState === STATES.INIT
      && cleanText(conversation.greetedDate || '') !== today
      && !replyContainsGreeting(reply);
    finalReply = shouldPrefixGreeting
      ? `${buildInitialGreeting(runtime, conversation, customer)}\n\n${reply}`
      : reply;

    if (shouldPrefixGreeting) {
      conversation.greeted = true;
      conversation.greetedDate = today;
      conversation.presented = true;
    }

    const sent = await sendWhatsAppMessage(conversation.phone, finalReply, runtime, conversation.remoteJid);
    if (sent && typeof onSend === 'function') {
      onSend({
        phone: conversation.phone,
        remoteJid: conversation.remoteJid || null,
        text: finalReply,
        instance: runtime.evolution.instance || null,
      });
    }
    if (conversation.state === STATES.HUMAN_HANDOFF) conversation.handoffNotified = true;
    if (sent) {
      conversation.greeted = true;
      conversation.greetedDate = nowISO().slice(0, 10);
    }
  }

  appendMessage(conversation, 'assistant', finalReply, {
    action: orchestratorResult.action,
    intent: classification.intent,
    prevState: previousState,
    nextState: conversation.state,
  });
  appendCustomerMemory(customer, 'assistant', finalReply, { action: orchestratorResult.action }, conversation.state);
  _persistOutbound(finalReply);

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
  return { success: true, reply: finalReply };
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
