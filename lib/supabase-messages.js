'use strict';

/**
 * Helpers para ler/gravar mensagens na tabela `msg_history` do Supabase.
 * Schema da tabela:
 *   id, company_id, phone, history_msg, timestamp, id_msg, name, processed, session_id
 */

const clean = (v) => String(v || '').trim();

async function supabaseInsertRow({ baseUrl, serviceRoleKey, table, row }) {
  if (!baseUrl || !serviceRoleKey || !table) return false;
  const url = `${String(baseUrl).replace(/\/+$/, '')}/rest/v1/${table}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

async function supabaseSelectRows({ baseUrl, serviceRoleKey, table, select = '*', filters = {}, order = '', limit = 200 }) {
  if (!baseUrl || !serviceRoleKey || !table) return [];
  const url = new URL(`${String(baseUrl).replace(/\/+$/, '')}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 1000))));
  if (order) url.searchParams.set('order', order);
  for (const [k, v] of Object.entries(filters || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, `eq.${v}`);
  }
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

// Executa o insert de forma assíncrona sem bloquear
const _doInsert = async (url, key, row) => {
  try {
    await supabaseInsertRow({ baseUrl: url, serviceRoleKey: key, table: 'msg_history', row });
  } catch (_) { /* silencioso */ }
};

/**
 * Salva uma mensagem inbound (do cliente) na tabela msg_history.
 * Fire-and-forget — não lança exceção.
 */
async function saveInboundMessage({
  supabaseUrl,
  serviceRoleKey,
  companyId,
  tenantId,
  phone,
  content,
  at,
  msgId = '',
  contactName = '',
}) {
  if (!supabaseUrl || !serviceRoleKey) return;
  const row = {
    company_id:  clean(companyId) || null,
    phone:       clean(phone),
    history_msg: clean(content),
    timestamp:   at || new Date().toISOString(),
    id_msg:      clean(msgId) || null,
    name:        clean(contactName) || null,
    processed:   false,
    session_id:  clean(tenantId) || null,
    role:        'user',
  };
  // Não salvar mensagens vazias
  if (!row.phone || !row.history_msg) return;
  _doInsert(supabaseUrl, serviceRoleKey, row);
}

/**
 * Salva uma mensagem outbound (do assistant) na tabela msg_history.
 * Fire-and-forget — não lança exceção.
 */
async function saveOutboundMessage({
  supabaseUrl,
  serviceRoleKey,
  companyId,
  tenantId,
  phone,
  content,
  at,
}) {
  if (!supabaseUrl || !serviceRoleKey) return;
  const row = {
    company_id:  clean(companyId) || null,
    phone:       clean(phone),
    history_msg: clean(content),
    timestamp:   at || new Date().toISOString(),
    role:        'assistant',
    session_id:  clean(tenantId) || null,
  };
  if (!row.phone || !row.history_msg) return;
  _doInsert(supabaseUrl, serviceRoleKey, row);
}

/**
 * Carrega histórico de mensagens de um contato a partir do msg_history.
 * Retorna array de { role, content, at } ordenado por timestamp ASC.
 * Inclui mensagens do user E do assistant.
 */
async function loadHistoryMessages({
  supabaseUrl,
  serviceRoleKey,
  companyId,
  phone,
  limit = 200,
}) {
  if (!supabaseUrl || !serviceRoleKey || !phone) return [];
  const filters = { phone: clean(phone) };
  if (clean(companyId)) filters.company_id = clean(companyId);

  const rows = await supabaseSelectRows({
    baseUrl: supabaseUrl,
    serviceRoleKey,
    table: 'msg_history',
    select: 'history_msg,timestamp,id_msg,name,role',
    filters,
    order: 'timestamp.asc',
    limit,
  });

  return rows
    .filter((r) => clean(r?.history_msg))
    .map((r) => ({
      role: clean(r.role || 'user'),
      content: clean(r.history_msg),
      at: r.timestamp ? new Date(r.timestamp).toISOString() : null,
      _msgId: clean(r?.id_msg || ''),
    }));
}

module.exports = { saveInboundMessage, saveOutboundMessage, loadHistoryMessages };
