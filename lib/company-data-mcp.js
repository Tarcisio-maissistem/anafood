'use strict';

const CACHE_TTL_MS = Number(process.env.COMPANY_MCP_CACHE_TTL_MS || 60_000);
const cache = new Map();

const clean = (v) => String(v || '').trim();
const asArray = (v) => Array.isArray(v) ? v : [];
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const cnpjDigits = (v) => clean(v).replace(/\D/g, '');

function formatAddress(value) {
  if (!value) return '';
  if (typeof value === 'string') return clean(value);
  if (typeof value === 'object') {
    const nested = value.endereco && typeof value.endereco === 'object' ? value.endereco : {};
    const parts = [
      value.logradouro || value.street || value.street_name || value.address_line || nested.logradouro || nested.street || '',
      value.numero || value.number || value.street_number || nested.numero || nested.number || '',
      value.complemento || value.complement || nested.complemento || nested.complement || '',
      value.bairro || value.neighborhood || value.district || nested.bairro || nested.neighborhood || '',
      value.cidade || value.city || nested.cidade || nested.city || '',
      value.estado || value.state || nested.estado || nested.state || '',
      value.cep || value.postal_code || nested.cep || nested.postal_code || '',
    ].filter(Boolean).map((x) => clean(x));
    return clean(parts.join(', '));
  }
  return '';
}

function formatSchedule(value) {
  if (!value) return '';
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) {
    const lines = value.map((row) => {
      const day = clean(row?.day || row?.weekday || row?.dia || row?.name);
      const open = clean(row?.open || row?.start || row?.from || row?.abertura);
      const close = clean(row?.close || row?.end || row?.to || row?.fechamento);
      if (!day || !open || !close) return '';
      return `${day} ${open}-${close}`;
    }).filter(Boolean);
    return clean(lines.join(' | '));
  }
  if (typeof value === 'object') {
    const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const ptMap = {
      segunda: 'monday',
      seg: 'monday',
      terca: 'tuesday',
      ter: 'tuesday',
      quarta: 'wednesday',
      qua: 'wednesday',
      quinta: 'thursday',
      qui: 'thursday',
      sexta: 'friday',
      sex: 'friday',
      sabado: 'saturday',
      sab: 'saturday',
      domingo: 'sunday',
      dom: 'sunday',
    };
    const dayLabel = {
      monday: 'Seg',
      tuesday: 'Ter',
      wednesday: 'Qua',
      thursday: 'Qui',
      friday: 'Sex',
      saturday: 'Sab',
      sunday: 'Dom',
    };
    const chunks = [];
    const normalizedObj = {};
    for (const [k, v] of Object.entries(value)) {
      const key = clean(k).toLowerCase();
      normalizedObj[ptMap[key] || key] = v;
    }
    for (const day of dayOrder) {
      const row = normalizedObj[day];
      if (!row || row.closed) continue;
      const open = clean(row.open || row.start || row.from || row.abertura || '');
      const close = clean(row.close || row.end || row.to || row.fechamento || '');
      if (open && close) chunks.push(`${dayLabel[day]} ${open}-${close}`);
    }
    return clean(chunks.join(' | '));
  }
  return '';
}

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
    neighborhood: clean(r?.neighborhood || r?.bairro || r?.zone_name || r?.name),
    zone_name: clean(r?.zone_name || r?.name || ''),
    fee: Number(r?.fee || r?.delivery_fee || r?.taxa || 0) || 0,
    min_order_value: Number(r?.min_order_value || r?.pedido_minimo || 0) || 0,
    max_distance_km: Number(r?.max_distance_km || r?.distance_km || r?.raio_km || 0) || 0,
    is_active: r?.is_active !== false,
  })).filter((r) => r.neighborhood || r.zone_name);
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

async function resolveCompanyIdDynamic({ tenant, tenantId, baseUrl, serviceRoleKey, configuredCompanyId, configuredCompanyCnpj, configuredSubdomain }) {
  const explicit = clean(configuredCompanyId);
  if (explicit) return { companyId: explicit, source: 'explicit_company_id' };

  const explicitCnpj = cnpjDigits(configuredCompanyCnpj || tenant?.business?.companyCnpj || tenant?.cnpj || '');
  if (explicitCnpj) {
    const companyRows = await supabaseSelect({
      baseUrl,
      serviceRoleKey,
      table: 'companies',
      select: 'id,cnpj',
      limit: 1000,
    });
    const row = companyRows.find((r) => cnpjDigits(r?.cnpj) === explicitCnpj);
    const companyId = clean(row?.id || '');
    if (companyId) return { companyId, source: 'explicit_cnpj' };
  }

  const subdomainHint = clean(configuredSubdomain || tenant?.subdomain || tenantId || '');
  if (subdomainHint) {
    const companyRows = await supabaseSelect({
      baseUrl,
      serviceRoleKey,
      table: 'companies',
      select: 'id,subdomain,name,fantasy_name',
      limit: 1000,
    });
    const target = norm(subdomainHint);
    const row = companyRows.find((r) => norm(r?.subdomain) === target);
    const companyId = clean(row?.id || '');
    if (companyId) return { companyId, source: 'subdomain_exact' };
  }

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
    if (exactCompanyId) return { companyId: exactCompanyId, source: 'whatsapp_config_exact' };

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
    if (companyId) return { companyId, source: 'whatsapp_config_fuzzy' };
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
    if (companyId) return { companyId, source: 'subdomain_or_name' };
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
    if (companyId) return { companyId, source: 'tenant_name' };
  }

  return { companyId: '', source: 'not_resolved' };
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
  const explicitCompanyCnpj = clean(
    supabase.companyCnpj
    || tenant?.business?.companyCnpj
    || process.env.COMPANY_MCP_COMPANY_CNPJ
  );
  const explicitSubdomain = clean(
    supabase.subdomain
    || tenant?.subdomain
    || process.env.COMPANY_MCP_COMPANY_SUBDOMAIN
  );
  let filterValue = explicitCompanyId;
  let resolveSource = explicitCompanyId ? 'explicit_company_id' : 'initial';
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
    paymentInfo: clean(restaurant.paymentInfo || ''),
    supportInfo: clean(restaurant.supportInfo || ''),
  };

  let menu = [];
  let paymentMethods = [];
  let deliveryAreas = [];
  let menuSource = 'empty';
  let companyRow = null;

  if (supabaseUrl && serviceRoleKey) {
    const resolved = await resolveCompanyIdDynamic({
      tenant,
      tenantId,
      baseUrl: supabaseUrl,
      serviceRoleKey,
      configuredCompanyId: explicitCompanyId,
      configuredCompanyCnpj: explicitCompanyCnpj,
      configuredSubdomain: explicitSubdomain,
    });
    filterValue = clean(resolved?.companyId || '') || explicitCompanyId;
    resolveSource = clean(resolved?.source || '') || resolveSource;

    const menuTable = clean(process.env.COMPANY_MCP_MENU_TABLE || supabase.menuTable);
    const paymentTable = clean(process.env.COMPANY_MCP_PAYMENT_TABLE || supabase.paymentTable);
    const deliveryTable = clean(process.env.COMPANY_MCP_DELIVERY_TABLE || supabase.deliveryTable);
    const companyTable = clean(process.env.COMPANY_MCP_COMPANY_TABLE || supabase.companyTable || 'companies');

    if (menuTable) {
      const rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: menuTable,
        filters: { [filterKey]: filterValue },
      });
      let menuRows = rows;
      if (!filterValue && rows.length) {
        const guessedCompanyId = clean(rows[0]?.company_id || rows[0]?.companyId || '');
        if (guessedCompanyId) {
          filterValue = guessedCompanyId;
          menuRows = rows.filter((r) => clean(r?.company_id || r?.companyId || '') === guessedCompanyId);
        }
      }
      menu = normalizeMenuRows(menuRows);
      if (menu.length) menuSource = 'supabase';
    }

    if (companyTable && filterValue) {
      const rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: companyTable,
        filters: { [companyLookupKey]: filterValue },
        limit: 1,
      });
      companyRow = rows[0] || null;
      if (companyRow) {
        company.name = clean(companyRow?.name || companyRow?.fantasy_name || company.name);
        company.address = formatAddress(companyRow?.address) || company.address;
        company.openingHours = formatSchedule(companyRow?.schedule) || company.openingHours;
        company.id = clean(companyRow?.id || filterValue);
        company.cnpj = clean(companyRow?.cnpj || '');
        company.fantasy_name = clean(companyRow?.fantasy_name || '');
        company.segment = clean(companyRow?.segment || '');
        company.phone = clean(companyRow?.phone || '');
        company.whatsapp = clean(companyRow?.whatsapp || '');
        company.email = clean(companyRow?.email || '');
        company.description = clean(companyRow?.description || '');
        company.logo_url = clean(companyRow?.logo_url || '');
        company.banner_url = clean(companyRow?.banner_url || '');
        company.delivery_mode = clean(companyRow?.delivery_mode || '');
        company.subdomain = clean(companyRow?.subdomain || '');
        company.owner_id = clean(companyRow?.owner_id || '');
        company.latitude = clean(companyRow?.latitude || '');
        company.longitude = clean(companyRow?.longitude || '');
        company.plan_id = clean(companyRow?.plan_id || '');
        company.subscription_status = clean(companyRow?.subscription_status || '');
        company.trial_ends_at = clean(companyRow?.trial_ends_at || '');
        company.is_active = Boolean(companyRow?.is_active !== false);
        company.address_raw = companyRow?.address || null;
        company.schedule_raw = companyRow?.schedule || null;
      }
    }

    if (paymentTable) {
      let rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: paymentTable,
        filters: { [filterKey]: filterValue, is_active: true },
      });
      if (!rows.length) {
        rows = await supabaseSelect({
          baseUrl: supabaseUrl,
          serviceRoleKey,
          table: paymentTable,
          filters: { [filterKey]: filterValue },
        });
      }
      paymentMethods = normalizePaymentRows(rows);
    }
    if (deliveryTable) {
      let rows = await supabaseSelect({
        baseUrl: supabaseUrl,
        serviceRoleKey,
        table: deliveryTable,
        filters: { [filterKey]: filterValue, is_active: true },
      });
      if (!rows.length) {
        rows = await supabaseSelect({
          baseUrl: supabaseUrl,
          serviceRoleKey,
          table: deliveryTable,
          filters: { [filterKey]: filterValue },
        });
      }
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
    paymentInfo: paymentMethods.join(', '),
    deliveryInfo: deliveryAreas
      .map((x) => `${x.neighborhood || x.zone_name || 'Regiao'} (${x.fee})`)
      .join('; '),
    meta: {
      companyId: filterValue || '',
      companyCnpj: explicitCompanyCnpj || company?.cnpj || '',
      filterKey,
      resolveSource,
      menuSource,
      supabaseConfigured: Boolean(supabaseUrl && serviceRoleKey),
      hasCompanyData: Boolean(companyRow),
      paymentCount: paymentMethods.length,
      deliveryAreasCount: deliveryAreas.length,
    },
  };
  writeCache(tenantId, data);
  return data;
}

module.exports = {
  loadCompanyData,
};
