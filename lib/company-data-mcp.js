'use strict';

const CACHE_TTL_MS = Number(process.env.COMPANY_MCP_CACHE_TTL_MS || 60_000);
const cache = new Map();

const clean = (v) => String(v || '').trim();
const asArray = (v) => Array.isArray(v) ? v : [];

function cacheKey(tenantId) {
  return String(tenantId || 'default');
}

function readCache(tenantId) {
  const key = cacheKey(tenantId);
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() - row.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return row.data;
}

function writeCache(tenantId, data) {
  cache.set(cacheKey(tenantId), { at: Date.now(), data });
}

function normalizeMenuRows(rows) {
  return asArray(rows).map((r) => ({
    name: clean(r?.name || r?.item || r?.produto || r?.title),
    price: Number(r?.price || r?.unit_price || r?.valor || 0) || 0,
    category: clean(r?.category || r?.categoria || ''),
    available: r?.available !== false && r?.is_available !== false,
  })).filter((r) => r.name);
}

function normalizePaymentRows(rows) {
  return asArray(rows).map((r) => clean(r?.name || r?.method || r?.payment_method || r?.code)).filter(Boolean);
}

function normalizeDeliveryRows(rows) {
  return asArray(rows).map((r) => ({
    neighborhood: clean(r?.neighborhood || r?.bairro || r?.name),
    fee: Number(r?.fee || r?.delivery_fee || r?.taxa || 0) || 0,
  })).filter((r) => r.neighborhood);
}

async function supabaseSelect({ baseUrl, serviceRoleKey, table, select = '*', filters = {}, limit = 200 }) {
  if (!baseUrl || !serviceRoleKey || !table) return [];
  const url = new URL(`${String(baseUrl).replace(/\/+$/, '')}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 1000))));
  for (const [k, v] of Object.entries(filters || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, `eq.${v}`);
  }
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) return [];
  const data = await response.json().catch(() => ([]));
  return asArray(data);
}

async function loadCompanyData({ tenant, tenantId, apiRequest, getEnvConfig }) {
  const cached = readCache(tenantId);
  if (cached) return cached;

  const restaurant = tenant?.business?.restaurant || {};
  const supabase = tenant?.integrations?.supabase || {};
  const supabaseUrl = clean(supabase.url || process.env.SUPABASE_URL);
  const serviceRoleKey = clean(supabase.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY);

  const company = {
    name: clean(tenant?.name || ''),
    address: clean(
      restaurant.address
      || restaurant.fullAddress
      || [restaurant.street, restaurant.number, restaurant.neighborhood, restaurant.city]
        .filter(Boolean)
        .join(', ')
    ),
    openingHours: clean(restaurant.openingHours || restaurant.workingHours || restaurant.schedule || ''),
  };

  let menu = [];
  let paymentMethods = [];
  let deliveryAreas = [];

  const tenantFilterKey = clean(process.env.COMPANY_MCP_TENANT_FILTER_KEY || supabase.tenantFilterKey || 'tenant_id');
  const tenantFilterValue = clean(tenantId);

  if (supabaseUrl && serviceRoleKey) {
    const menuTable = clean(process.env.COMPANY_MCP_MENU_TABLE || supabase.menuTable);
    const paymentTable = clean(process.env.COMPANY_MCP_PAYMENT_TABLE || supabase.paymentTable);
    const deliveryTable = clean(process.env.COMPANY_MCP_DELIVERY_TABLE || supabase.deliveryTable);

    if (menuTable) {
      const rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: menuTable,
        filters: { [tenantFilterKey]: tenantFilterValue },
      });
      menu = normalizeMenuRows(rows);
    }
    if (paymentTable) {
      const rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: paymentTable,
        filters: { [tenantFilterKey]: tenantFilterValue },
      });
      paymentMethods = normalizePaymentRows(rows);
    }
    if (deliveryTable) {
      const rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: deliveryTable,
        filters: { [tenantFilterKey]: tenantFilterValue },
      });
      deliveryAreas = normalizeDeliveryRows(rows);
    }
  }

  // fallback to SAIPOS catalog if DB menu is empty
  if (!menu.length && typeof apiRequest === 'function' && typeof getEnvConfig === 'function') {
    try {
      const cfg = getEnvConfig((tenant?.environment || 'homologation').toLowerCase());
      const raw = await apiRequest((tenant?.environment || 'homologation').toLowerCase(), 'GET', `/catalog?cod_store=${cfg.codStore}`);
      const list = Array.isArray(raw) ? raw : (raw?.items || raw?.products || []);
      menu = normalizeMenuRows(list);
    } catch (_) {}
  }

  if (!paymentMethods.length) {
    paymentMethods = asArray(restaurant.paymentMethods).map((x) => clean(x)).filter(Boolean);
  }
  if (!deliveryAreas.length) {
    deliveryAreas = asArray(restaurant.deliveryAreas).map((x) => ({
      neighborhood: clean(x?.neighborhood || x?.bairro || x?.name),
      fee: Number(x?.fee || x?.taxa || 0) || 0,
    })).filter((x) => x.neighborhood);
  }

  const data = { company, menu, paymentMethods, deliveryAreas };
  writeCache(tenantId, data);
  return data;
}

module.exports = {
  loadCompanyData,
};

