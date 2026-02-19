'use strict';

const CACHE_TTL_MS = Number(process.env.COMPANY_MCP_CACHE_TTL_MS || 60_000);
const cache = new Map();

const clean = (v) => String(v || '').trim();
const asArray = (v) => Array.isArray(v) ? v : [];
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '');

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
    integration_code: clean(
      r?.integration_code
      || r?.codigo_saipos
      || r?.cod_item
      || r?.code
      || r?.external_code
      || r?.id_store_item
      || r?.id
    ),
    name: clean(r?.name || r?.item || r?.desc_item || r?.produto || r?.title),
    price: Number(r?.price || r?.unit_price || r?.valor || 0) || 0,
    unit_price: Math.round((Number(r?.price || r?.unit_price || r?.valor || 0) || 0) * 100),
    category: clean(r?.category || r?.categoria || r?.desc_category || ''),
    available: r?.available !== false && r?.is_available !== false && r?.on_off !== false,
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

async function resolveCompanyIdDynamic({ tenant, tenantId, baseUrl, serviceRoleKey, configuredCompanyId }) {
  const explicit = clean(configuredCompanyId);
  if (explicit) return explicit;

  const instanceName = clean(tenant?.evolution?.instance || '');
  if (instanceName) {
    const waRowsExact = await supabaseSelect({
      baseUrl,
      serviceRoleKey,
      table: 'whatsapp_config',
      select: 'company_id,session_name,is_active',
      filters: { session_name: instanceName, is_active: true },
      limit: 1,
    });
    const exactCompanyId = clean(waRowsExact?.[0]?.company_id || '');
    if (exactCompanyId) return exactCompanyId;

    const waRows = await supabaseSelect({
      baseUrl,
      serviceRoleKey,
      table: 'whatsapp_config',
      select: 'company_id,session_name,is_active',
      filters: { is_active: true },
      limit: 500,
    });
    const target = norm(instanceName);
    const row = waRows.find((r) => norm(r?.session_name) === target);
    const companyId = clean(row?.company_id || '');
    if (companyId) return companyId;
  }

  const subdomain = clean(tenant?.subdomain || tenantId || '');
  if (subdomain) {
    const companyRows = await supabaseSelect({
      baseUrl,
      serviceRoleKey,
      table: 'companies',
      select: 'id,subdomain,name,fantasy_name',
      limit: 500,
    });
    const target = norm(subdomain);
    const row = companyRows.find((r) => norm(r?.subdomain) === target || norm(r?.name) === target || norm(r?.fantasy_name) === target);
    const companyId = clean(row?.id || '');
    if (companyId) return companyId;
  }

  const tenantName = clean(tenant?.name || '');
  if (tenantName) {
    const companyRows = await supabaseSelect({
      baseUrl,
      serviceRoleKey,
      table: 'companies',
      select: 'id,name,fantasy_name,subdomain',
      limit: 500,
    });
    const target = norm(tenantName);
    const row = companyRows.find((r) => norm(r?.name) === target || norm(r?.fantasy_name) === target || norm(r?.subdomain) === target);
    const companyId = clean(row?.id || '');
    if (companyId) return companyId;
  }

  return '';
}

async function loadCompanyData({ tenant, tenantId, apiRequest, getEnvConfig }) {
  const cached = readCache(tenantId);
  if (cached) return cached;

  const restaurant = tenant?.business?.restaurant || {};
  const supabase = tenant?.integrations?.supabase || {};
  const supabaseUrl = clean(supabase.url || process.env.SUPABASE_URL);
  const serviceRoleKey = clean(supabase.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const filterKey = clean(process.env.COMPANY_MCP_TENANT_FILTER_KEY || supabase.tenantFilterKey || 'company_id');
  const explicitCompanyId = clean(
    supabase.filterValue
    || supabase.companyId
    || tenant?.business?.companyId
    || process.env.COMPANY_MCP_FILTER_VALUE
    || process.env.COMPANY_MCP_COMPANY_ID
  );
  let filterValue = explicitCompanyId;
  const companyLookupKey = clean(process.env.COMPANY_MCP_COMPANY_LOOKUP_KEY || supabase.companyLookupKey || 'id');

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
  let menuSource = 'empty';

  if (supabaseUrl && serviceRoleKey) {
    filterValue = await resolveCompanyIdDynamic({
      tenant,
      tenantId,
      baseUrl: supabaseUrl,
      serviceRoleKey,
      configuredCompanyId: explicitCompanyId,
    }) || explicitCompanyId;

    const menuTable = clean(process.env.COMPANY_MCP_MENU_TABLE || supabase.menuTable);
    const paymentTable = clean(process.env.COMPANY_MCP_PAYMENT_TABLE || supabase.paymentTable);
    const deliveryTable = clean(process.env.COMPANY_MCP_DELIVERY_TABLE || supabase.deliveryTable);
    const companyTable = clean(process.env.COMPANY_MCP_COMPANY_TABLE || supabase.companyTable || 'companies');

    if (companyTable) {
      const rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: companyTable,
        filters: { [companyLookupKey]: filterValue },
        limit: 1,
      });
      const row = rows[0] || null;
      if (row) {
        company.name = clean(row?.name || row?.fantasy_name || company.name);
        company.address = clean(row?.address || company.address);
        company.openingHours = clean(
          (typeof row?.schedule === 'string' ? row.schedule : '')
          || company.openingHours
        );
      }
    }

    if (menuTable) {
      const rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: menuTable,
        filters: { [filterKey]: filterValue },
      });
      menu = normalizeMenuRows(rows);
      if (menu.length) menuSource = 'supabase';
    }
    if (paymentTable) {
      const rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: paymentTable,
        filters: { [filterKey]: filterValue, is_active: true },
      });
      paymentMethods = normalizePaymentRows(rows);
    }
    if (deliveryTable) {
      const rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: deliveryTable,
        filters: { [filterKey]: filterValue, is_active: true },
      });
      deliveryAreas = normalizeDeliveryRows(rows);
    }
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

  const data = {
    company,
    menu,
    paymentMethods,
    deliveryAreas,
    meta: {
      companyId: filterValue || '',
      filterKey,
      menuSource,
      supabaseConfigured: Boolean(supabaseUrl && serviceRoleKey),
    },
  };
  writeCache(tenantId, data);
  return data;
}

module.exports = {
  loadCompanyData,
};
