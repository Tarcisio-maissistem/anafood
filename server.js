const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

dotenv.config();

const { handleWhatsAppMessage, sessions: anaSessions } = require('./agents/ana');
const { resolveTenant, listTenants } = require('./lib/tenants');

const app = express();
const PORT = process.env.PORT || 3993;
const staticNoCacheHeaders = (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: staticNoCacheHeaders }));
app.use('/assets', express.static(path.join(__dirname, 'public', 'lovable', 'assets'), { setHeaders: staticNoCacheHeaders }));

// Avoid stale SPA bundles in production proxies/browsers.
app.use((req, res, next) => {
    if (req.method === 'GET' && !path.extname(req.path)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }
    next();
});

app.get('/qz-tray.js', (_req, res) => {
    const file = path.join(__dirname, 'public', 'lovable', 'qz-tray.js');
    if (!fs.existsSync(file)) return res.sendStatus(404);
    return res.sendFile(file);
});
app.get('/sounds/default-notification.mp3', (_req, res) => {
    // Avoid noisy 404 in dashboards that expect an optional notification sound file.
    return res.sendStatus(204);
});

// Optional analytics endpoints referenced by mirrored Lovable build.
app.get('/~flock.js', (_req, res) => {
    res.type('application/javascript').send('');
});
app.all('/~api/analytics', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    return res.sendStatus(204);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const log = (type, message, data = null) => {
    const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const extra = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`[${type}] [${ts}] ${message}${extra}`);
};

const getEnvConfig = (environment, tenant = null) => {
    const env = (environment || 'homologation').toLowerCase();
    const tenantSaipos = tenant?.saipos?.[env];
    if (tenantSaipos) {
        return {
            baseUrl: tenantSaipos.baseUrl,
            idPartner: tenantSaipos.idPartner,
            secret: tenantSaipos.secret,
            codStore: tenantSaipos.codStore,
        };
    }

    if (env === 'production') {
        return {
            baseUrl: process.env.PRODUCTION_API_URL,
            idPartner: process.env.PRODUCTION_ID_PARTNER,
            secret: process.env.PRODUCTION_SECRET,
            codStore: process.env.PRODUCTION_COD_STORE,
        };
    }
    return {
        baseUrl: process.env.HOMOLOG_API_URL,
        idPartner: process.env.HOMOLOG_ID_PARTNER,
        secret: process.env.HOMOLOG_SECRET,
        codStore: process.env.HOMOLOG_COD_STORE,
    };
};

// ─── Token Cache ─────────────────────────────────────────────────────────────
// Armazena { token, expiresAt } por ambiente
const tokenCache = {};

const getToken = async (environment, tenant = null) => {
    const cfg = getEnvConfig(environment, tenant);
    const tenantId = tenant?.id || 'default';

    if (!cfg.idPartner || !cfg.secret) {
        throw new Error(`Credenciais não configuradas para tenant "${tenantId}" no ambiente "${environment}"`);
    }

    const cacheKey = `${tenantId}:${environment}`;
    const cached = tokenCache[cacheKey];
    if (cached && Date.now() < cached.expiresAt) {
        log('INFO', `Token em cache válido para tenant "${tenantId}" no ambiente "${environment}"`);
        return cached.token;
    }

    log('INFO', `Obtendo novo token para tenant "${tenantId}" no ambiente "${environment}"`);
    const response = await fetch(`${cfg.baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ idPartner: cfg.idPartner, secret: cfg.secret }),
    });

    const data = await response.json();

    if (!response.ok) {
        log('ERROR', 'Falha na autenticação', data);
        throw new Error(data.errorMessage || 'Falha na autenticação');
    }

    // O token JWT expira em ~2 dias; renovamos com 5 min de antecedência
    let expiresAt = Date.now() + 47 * 60 * 60 * 1000; // padrão 47h
    try {
        const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64').toString());
        if (payload.exp) expiresAt = payload.exp * 1000 - 5 * 60 * 1000;
    } catch (_) {}

    tokenCache[cacheKey] = { token: data.token, expiresAt };
    log('INFO', 'Token obtido com sucesso');
    return data.token;
};

const apiRequest = async (environment, method, path, body = null, tenant = null) => {
    const cfg = getEnvConfig(environment, tenant);
    const token = await getToken(environment, tenant);
    const url = `${cfg.baseUrl}${path}`;

    log('INFO', `${method} ${url}`, body || undefined);

    const options = {
        method,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: token,
        },
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
        log('ERROR', `Erro na resposta da API (${response.status})`, data);
        const err = new Error(data.errorMessage || `HTTP ${response.status}`);
        err.apiError = data;
        throw err;
    }

    return data;
};

const getTenantFromRequest = (req) => {
    const queryTenant = req.query?.tenant_id || req.query?.tenant;
    const headerTenant = req.get('x-tenant-id') || req.get('x-tenant');
    const bodyTenant = req.body?.tenant_id || req.body?.tenant;

    const bodyData = req.body?.data;
    const payload = Array.isArray(bodyData) ? bodyData[0] : (bodyData || req.body || {});
    const key = payload.key || payload?.messages?.[0]?.key || {};
    const instanceName =
        req.body?.instance ||
        req.body?.instanceName ||
        payload.instance ||
        payload.instanceName ||
        payload.sender ||
        payload?.messages?.[0]?.instance ||
        null;

    const tenant = resolveTenant({
        tenantId: queryTenant || headerTenant || bodyTenant || null,
        instanceName,
    });

    return {
        tenant,
        instanceName,
        hints: {
            queryTenant,
            headerTenant,
            bodyTenant,
            remoteJid: key.remoteJid || payload.remoteJid || null,
        },
    };
};

// ─── Middleware de tratamento de erros ───────────────────────────────────────

const handleError = (res, error) => {
    log('ERROR', error.message, error.apiError || undefined);
    const status = error.apiError ? 400 : 500;
    res.status(status).json({
        success: false,
        error: error.message,
        details: error.apiError || undefined,
    });
};

// ─── Rotas ───────────────────────────────────────────────────────────────────

/**
 * GET /api/auth
 * Testa autenticação e retorna token (apenas para debug)
 */
app.get('/api/auth', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    try {
        const token = await getToken(environment);
        res.json({ success: true, token });
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * GET /api/catalog
 * Retorna catálogo de produtos da loja
 */
app.get('/api/catalog', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    const cfg = getEnvConfig(environment);
    try {
        const data = await apiRequest(environment, 'GET', `/catalog?cod_store=${cfg.codStore}`);
        res.json(data);
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * GET /api/orders
 * Lista pedidos. Pode filtrar por order_id.
 * Query: environment, order_id
 */
app.get('/api/orders', async (req, res) => {
    const { environment = 'homologation', order_id } = req.query;
    const cfg = getEnvConfig(environment);

    if (!order_id) {
        return res.status(400).json({
            success: false,
            error: 'Parâmetro "order_id" é obrigatório. A API SAIPOS não suporta listagem sem filtro.',
            example: '/api/orders?order_id=TICKET-1234567890&environment=homologation',
        });
    }

    try {
        const path = `/order?cod_store=${cfg.codStore}&order_id=${order_id}`;
        const data = await apiRequest(environment, 'GET', path);
        res.json(data);
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * GET /api/orders/status
 * Consulta status de comandas/mesas abertas
 * Query: environment, table (número da mesa), pad (número da comanda)
 *
 * Exemplo: GET /api/orders/status?pad=1&pad=2
 *          GET /api/orders/status?table=5
 */
app.get('/api/orders/status', async (req, res) => {
    const { environment = 'homologation' } = req.query;

    // Aceita múltiplos valores: ?table=1&table=2 ou ?table[]=1
    const tables = [].concat(req.query.table || []).map(Number).filter(n => !isNaN(n));
    const pads   = [].concat(req.query.pad   || []).map(Number).filter(n => !isNaN(n));

    if (tables.length === 0 && pads.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Informe ao menos um parâmetro: table ou pad (numérico)',
        });
    }

    try {
        // A API SAIPOS exige arrays JSON no query string
        // Formato correto: ?table=[10]&pad=[2,3]
        const parts = [];
        if (tables.length) parts.push(`table=${encodeURIComponent(JSON.stringify(tables))}`);
        if (pads.length)   parts.push(`pad=${encodeURIComponent(JSON.stringify(pads))}`);

        const data = await apiRequest(environment, 'GET', `/sale-status-by-table-or-pad?${parts.join('&')}`);
        res.json(data);
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * GET /api/waiters
 * Lista garçons disponíveis
 */
app.get('/api/waiters', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    const cfg = getEnvConfig(environment);
    try {
        const data = await apiRequest(environment, 'GET', `/waiters?cod_store=${cfg.codStore}`);
        res.json(data);
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * GET /api/tenants
 * Lista tenants carregados (sem segredos)
 */
app.get('/api/tenants', (_req, res) => {
    const tenants = listTenants().map(t => ({
        id: t.id,
        name: t.name,
        active: t.active !== false,
        environment: t.environment || 'homologation',
        agent: t.agent || {},
        evolution: {
            instance: t?.evolution?.instance || null,
            apiUrl: t?.evolution?.apiUrl || null,
        },
        saipos: {
            homologation: { codStore: t?.saipos?.homologation?.codStore || null },
            production: { codStore: t?.saipos?.production?.codStore || null },
        },
        business: {
            segment: t?.business?.segment || 'restaurant',
            orderProvider: t?.business?.restaurant?.orderProvider || 'saipos',
        },
        integrations: {
            anafood: {
                endpoint: t?.integrations?.anafood?.endpoint || null,
                authMode: t?.integrations?.anafood?.authMode || null,
            },
        },
    }));
    res.json({ success: true, count: tenants.length, tenants });
});

/**
 * GET /api/ana/session
 * Inspeciona sessao conversacional atual por telefone/tenant.
 * Query: phone, tenant_id (opcional), instance (opcional)
 */
app.get('/api/ana/session', (req, res) => {
    const phoneRaw = String(req.query.phone || '').trim();
    const phone = phoneRaw.replace(/\D/g, '');
    if (!phone) {
        return res.status(400).json({ success: false, error: 'Parametro "phone" e obrigatorio' });
    }

    const tenant = resolveTenant({
        tenantId: req.query.tenant_id || req.query.tenant || null,
        instanceName: req.query.instance || null,
    });
    const tenantId = tenant?.id || 'default';
    const key = `${tenantId}:${phone}`;
    const session = anaSessions.get(key);

    if (!session) {
        return res.json({ success: true, found: false, tenantId, phone, key });
    }

    return res.json({
        success: true,
        found: true,
        tenantId,
        phone,
        key,
        state: session.state,
        contextSummary: session.contextSummary || '',
        messageCount: session.messageCount || 0,
        consecutiveFailures: session.consecutiveFailures || 0,
        lastActivityAt: session.lastActivityAt,
        transaction: session.transaction || {},
        recentMessages: Array.isArray(session.messages) ? session.messages.slice(-12) : [],
    });
});

/**
 * POST /api/ana/simulate
 * Simula mensagem recebida de cliente (sem depender do webhook Evolution).
 * Body: { phone, text, tenant_id?, tenant?, instance? }
 */
app.post('/api/ana/simulate', async (req, res) => {
    try {
        const phoneRaw = String(req.body?.phone || '').trim();
        const text = String(req.body?.text || '').trim();
        const phone = phoneRaw.replace(/\D/g, '');

        if (!phone || !text) {
            return res.status(400).json({ success: false, error: 'Campos "phone" e "text" sao obrigatorios' });
        }

        const tenant = resolveTenant({
            tenantId: req.body?.tenant_id || req.body?.tenant || null,
            instanceName: req.body?.instance || req.body?.instanceName || null,
        });
        const tenantId = tenant?.id || 'default';

        const boundApiRequest = (environment, method, apiPath, body = null) =>
            apiRequest(environment, method, apiPath, body, tenant);
        const boundGetEnvConfig = (environment) => getEnvConfig(environment, tenant);

        const result = await handleWhatsAppMessage(phone, text, {
            apiRequest: boundApiRequest,
            getEnvConfig: boundGetEnvConfig,
            log,
            tenant,
            rawMessage: null,
            instanceName: req.body?.instance || req.body?.instanceName || null,
        });

        return res.json({
            success: true,
            tenantId,
            phone,
            queued: result?.queued || false,
            conversationId: result?.conversationId || `${tenantId}:${phone}`,
            state: result?.state || null,
            bufferWindowMs: result?.bufferWindowMs || null,
        });
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * POST /api/orders/ticket
 * Abre uma comanda (TICKET) sem mesa
 *
 * Body:
 * {
 *   "order_id": "único por pedido",          // opcional, gerado automaticamente
 *   "display_id": "número visível",           // opcional
 *   "ticket_reference": "Comanda 01",         // opcional
 *   "customer": { "id", "name", "phone" },    // opcional
 *   "notes": "",                              // opcional
 *   "items": [                                // opcional
 *     { "integration_code", "desc_item", "quantity", "unit_price" }
 *   ],
 *   "payment_types": [{ "code", "amount" }]  // opcional
 * }
 */
app.post('/api/orders/ticket', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    const cfg = getEnvConfig(environment);

    const {
        order_id = `TICKET-${Date.now()}`,
        display_id = String(Date.now()).slice(-4),
        ticket_reference,
        customer,
        notes = '',
        total_amount = 0,
        total_discount = 0,
        items = [],
        payment_types = [],
    } = req.body;

    // Garante change_for em cada payment_type (obrigatório pela API)
    const normalizedPayments = payment_types.map(p => ({
        change_for: 0,
        ...p,
    }));

    const body = {
        order_id,
        display_id,
        cod_store: cfg.codStore,
        created_at: new Date().toISOString(),
        notes,
        total_amount,
        total_discount,
        order_method: {
            mode: 'TICKET',
            ...(ticket_reference && { ticket_reference }),
        },
        ...(customer && { customer }),
        ...(items.length && { items }),
        ...(normalizedPayments.length && { payment_types: normalizedPayments }),
    };

    try {
        const data = await apiRequest(environment, 'POST', '/order', body);
        log('INFO', 'Comanda (TICKET) criada com sucesso', { order_id });
        res.json({ success: true, order_id, data });
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * POST /api/orders/delivery
 * Cria pedido de delivery (entrega ou retirada)
 *
 * Body:
 * {
 *   "mode": "DELIVERY" | "TAKEOUT",          // obrigatório
 *   "order_id": "único",                     // opcional
 *   "display_id": "número visível",           // opcional
 *   "customer": { "id", "name", "phone" },   // recomendado
 *   "address": {                              // obrigatório para DELIVERY
 *     "street_name", "street_number", "neighborhood", "city", "state"
 *   },
 *   "notes": "",
 *   "total_amount": 0,
 *   "total_discount": 0,
 *   "items": [...],
 *   "payment_types": [...]
 * }
 */
app.post('/api/orders/delivery', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    const cfg = getEnvConfig(environment);

    const {
        mode,
        order_id = `DEL-${Date.now()}`,
        display_id = String(Date.now()).slice(-4),
        customer,
        address,
        notes = '',
        total_amount = 0,
        total_discount = 0,
        scheduled = false,
        delivery_date_time = new Date().toISOString(),
        items = [],
        payment_types = [],
    } = req.body;

    if (!mode || !['DELIVERY', 'TAKEOUT'].includes(mode.toUpperCase())) {
        return res.status(400).json({
            success: false,
            error: 'Campo "mode" é obrigatório: DELIVERY ou TAKEOUT',
        });
    }

    if (mode.toUpperCase() === 'DELIVERY' && !address) {
        return res.status(400).json({
            success: false,
            error: 'Campo "address" é obrigatório para pedidos DELIVERY',
        });
    }

    // Garante change_for em cada payment_type (obrigatório pela API)
    const normalizedPayments = payment_types.map(p => ({
        change_for: 0,
        ...p,
    }));

    const body = {
        order_id,
        display_id,
        cod_store: cfg.codStore,
        created_at: new Date().toISOString(),
        notes,
        total_amount,
        total_discount,
        order_method: {
            mode: mode.toUpperCase(),
            scheduled,
            delivery_date_time,
            // SAIPOS exige delivery_by e delivery_fee para modo DELIVERY
            ...(mode.toUpperCase() === 'DELIVERY' && {
                delivery_by: req.body.delivery_by || 'RESTAURANT',
                delivery_fee: req.body.delivery_fee ?? 0,
            }),
        },
        ...(customer && { customer }),
        // SAIPOS usa delivery_address (não address) para pedidos DELIVERY
        ...(address && mode.toUpperCase() === 'DELIVERY' && { delivery_address: address }),
        ...(address && mode.toUpperCase() !== 'DELIVERY' && { address }),
        ...(items.length && { items }),
        ...(normalizedPayments.length && { payment_types: normalizedPayments }),
    };

    try {
        const data = await apiRequest(environment, 'POST', '/order', body);
        log('INFO', `Pedido ${mode.toUpperCase()} criado com sucesso`, { order_id });
        res.json({ success: true, order_id, data });
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * POST /api/orders/table
 * Cria pedido vinculado a uma mesa (TABLE)
 *
 * Body:
 * {
 *   "table_number": "10",                    // número da mesa (obrigatório)
 *   "order_id": "único",                     // opcional
 *   "display_id": "número visível",           // opcional
 *   "customer": { "id", "name", "phone" },   // opcional
 *   "notes": "",
 *   "total_amount": 0,
 *   "total_discount": 0,
 *   "items": [...],
 *   "payment_types": [...]
 * }
 */
app.post('/api/orders/table', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    const cfg = getEnvConfig(environment);

    const {
        table_number,
        order_id = `TABLE-${Date.now()}`,
        display_id = String(Date.now()).slice(-4),
        customer,
        notes = '',
        total_amount = 0,
        total_discount = 0,
        items = [],
        payment_types = [],
    } = req.body;

    if (!table_number) {
        return res.status(400).json({ success: false, error: 'Campo "table_number" é obrigatório' });
    }

    const normalizedPayments = payment_types.map(p => ({ change_for: 0, ...p }));

    const body = {
        order_id,
        display_id,
        cod_store: cfg.codStore,
        created_at: new Date().toISOString(),
        notes,
        total_amount,
        total_discount,
        order_method: {
            mode: 'TABLE',
            table_reference: String(table_number),
        },
        table: { desc_table: String(table_number) },
        ...(customer && { customer }),
        ...(items.length && { items }),
        ...(normalizedPayments.length && { payment_types: normalizedPayments }),
    };

    try {
        const data = await apiRequest(environment, 'POST', '/order', body);
        log('INFO', `Pedido TABLE criado para mesa ${table_number}`, { order_id });
        res.json({ success: true, order_id, table_number, data });
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * POST /api/orders/cancel
 * Cancela um pedido
 *
 * Body: { "order_id": "id do pedido" }
 */
app.post('/api/orders/cancel', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    const cfg = getEnvConfig(environment);
    const { order_id } = req.body;

    if (!order_id) {
        return res.status(400).json({ success: false, error: 'Campo "order_id" é obrigatório' });
    }

    try {
        const data = await apiRequest(environment, 'POST', '/cancel-order', {
            order_id,
            cod_store: cfg.codStore,
        });
        log('INFO', 'Pedido cancelado com sucesso', { order_id });
        res.json({ success: true, order_id, data });
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * PUT /api/orders/close
 * Solicita fechamento de mesa/comanda
 *
 * Body: { "order_id": "id do pedido" }
 * Obs: use o order_id retornado pelo /sale-status-by-table-or-pad (campo "order_id")
 *      pois o /close-sale da SAIPOS identifica pelo order_id original do pedido
 */
app.put('/api/orders/close', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    const cfg = getEnvConfig(environment);
    const { order_id } = req.body;

    if (!order_id) {
        return res.status(400).json({ success: false, error: 'Campo "order_id" é obrigatório' });
    }

    try {
        const data = await apiRequest(environment, 'PUT', '/close-sale', {
            order_id,
            cod_store: cfg.codStore,
        });
        log('INFO', 'Fechamento solicitado com sucesso', { order_id });
        res.json({ success: true, order_id, data });
    } catch (error) {
        handleError(res, error);
    }
});

// ─── Totem ────────────────────────────────────────────────────────────────────

// Cache de catálogo para o totem (5 minutos)
const totemCatalogCache = {};

const normalizeCatalogItems = (rawCatalog) => {
    const seen = new Set();
    const items = [];
    const rows = Array.isArray(rawCatalog) ? rawCatalog : (rawCatalog.items || rawCatalog.products || []);
    for (const row of rows) {
        // SAIPOS retorna codigo_saipos como integration_code
        const code = row.integration_code || row.codigo_saipos || row.cod_item || row.code;
        if (!code || seen.has(String(code))) continue;
        // Filtra itens desabilitados
        if (row.store_item_enabled === 'N') continue;
        seen.add(String(code));
        items.push({
            integration_code: String(code),
            name:             row.item || row.desc_item || row.name || row.description || '',
            description:      row.complemento || row.complement || row.obs || '',
            price:            Number(row.price || row.unit_price || 0),
            category:         row.categoria || row.category || row.desc_category || '',
        });
    }
    return items;
};

/**
 * GET /api/totem/catalog
 * Catálogo formatado para o totem (cache 5 min)
 */
app.get('/api/totem/catalog', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    const cfg = getEnvConfig(environment);

    const now = Date.now();
    const cached = totemCatalogCache[environment];
    if (cached && now < cached.expiresAt) {
        return res.json({ success: true, items: cached.items, cached: true });
    }

    try {
        const raw = await apiRequest(environment, 'GET', `/catalog?cod_store=${cfg.codStore}`);
        const items = normalizeCatalogItems(raw);
        totemCatalogCache[environment] = { items, expiresAt: now + 5 * 60 * 1000 };
        res.json({ success: true, items });
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * POST /api/totem/order
 * Recebe carrinho do totem e cria pedido na SAIPOS
 *
 * Body:
 * {
 *   "mode": "TABLE" | "TAKEOUT",
 *   "table_number": "10",          // obrigatório se mode=TABLE
 *   "customer": { "name" },        // opcional
 *   "items": [{ integration_code, name, quantity, unit_price }],
 *   "payment_method": "PIX" | "CARD"
 * }
 */
app.post('/api/totem/order', async (req, res) => {
    const { environment = 'homologation' } = req.query;
    const cfg = getEnvConfig(environment);

    const { mode, table_number, customer, items = [], payment_method = 'PIX' } = req.body;

    if (!mode || !['TABLE', 'TAKEOUT'].includes(mode.toUpperCase())) {
        return res.status(400).json({ success: false, error: 'Campo "mode" é obrigatório: TABLE ou TAKEOUT' });
    }
    if (mode.toUpperCase() === 'TABLE' && !table_number) {
        return res.status(400).json({ success: false, error: 'Campo "table_number" é obrigatório para mode=TABLE' });
    }
    if (!items.length) {
        return res.status(400).json({ success: false, error: 'Carrinho vazio' });
    }

    const total_amount = items.reduce((sum, i) => sum + (i.unit_price || 0) * (i.quantity || 1), 0);
    const order_id = `TOTEM-${Date.now()}`;
    const display_id = String(Date.now()).slice(-4);

    const paymentCode = payment_method === 'CARD' ? 'CRE' : 'PIX';
    const normalizedPayments = [{ code: paymentCode, amount: total_amount, change_for: 0 }];

    let body;
    if (mode.toUpperCase() === 'TABLE') {
        body = {
            order_id, display_id, cod_store: cfg.codStore,
            created_at: new Date().toISOString(),
            notes: 'Pedido via Totem', total_amount, total_discount: 0,
            order_method: { mode: 'TABLE', table_reference: String(table_number) },
            table: { desc_table: String(table_number) },
            ...(customer && { customer }),
            items,
            payment_types: normalizedPayments,
        };
    } else {
        body = {
            order_id, display_id, cod_store: cfg.codStore,
            created_at: new Date().toISOString(),
            notes: 'Pedido via Totem', total_amount, total_discount: 0,
            order_method: { mode: 'TAKEOUT', scheduled: false, delivery_date_time: new Date().toISOString() },
            ...(customer && { customer }),
            items,
            payment_types: normalizedPayments,
        };
    }

    try {
        const data = await apiRequest(environment, 'POST', '/order', body);
        log('INFO', `Pedido Totem criado (${mode})`, { order_id, total_amount });
        res.json({ success: true, order_id, total_amount, data });
    } catch (error) {
        handleError(res, error);
    }
});

// ─── PIX ──────────────────────────────────────────────────────────────────────

// Armazena pagamentos PIX pendentes { [payment_id]: { status, amount, order_id, createdAt } }
const pixPayments = {};

/**
 * POST /api/payment/pix
 * Gera QR Code PIX (stub ou Mercado Pago)
 *
 * Body: { "amount": 1000, "order_id": "TOTEM-123" }
 */
app.post('/api/payment/pix', async (req, res) => {
    const { amount, order_id } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Campo "amount" é obrigatório e deve ser positivo (centavos)' });
    }

    const payment_id = `PIX-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Mercado Pago real (quando token configurado)
    if (process.env.MERCADOPAGO_ACCESS_TOKEN) {
        try {
            const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
                    'X-Idempotency-Key': payment_id,
                },
                body: JSON.stringify({
                    transaction_amount: amount / 100,
                    payment_method_id: 'pix',
                    payer: { email: 'cliente@totem.com' },
                    description: `Pedido ${order_id || payment_id}`,
                    notification_url: `${req.protocol}://${req.get('host')}/webhook/pix`,
                }),
            });
            const mpData = await mpRes.json();
            if (!mpRes.ok) throw new Error(mpData.message || 'Erro Mercado Pago');

            const qr_code = mpData.point_of_interaction?.transaction_data?.qr_code;
            const qr_code_base64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64;
            pixPayments[mpData.id] = { status: 'pending', amount, order_id, createdAt: Date.now() };

            return res.json({ success: true, payment_id: String(mpData.id), qr_code, qr_code_base64 });
        } catch (err) {
            log('ERROR', 'Erro Mercado Pago, usando stub', err.message);
        }
    }

    // Stub para desenvolvimento/homologação
    const stub_qr = `00020126330014br.gov.bcb.pix0111${payment_id.slice(-11)}5204000053039865802BR5910TOTEM TEST6009SAO PAULO62070503***6304ABCD`;
    pixPayments[payment_id] = { status: 'pending', amount, order_id, createdAt: Date.now() };

    // Em modo stub, aprova automaticamente após 8 segundos (facilita testes)
    setTimeout(() => {
        if (pixPayments[payment_id]) pixPayments[payment_id].status = 'approved';
    }, 8000);

    log('INFO', `PIX stub gerado`, { payment_id, amount });
    res.json({ success: true, payment_id, qr_code: stub_qr, qr_code_base64: null, stub: true });
});

/**
 * GET /api/payment/pix/:id/status
 * Polling do status do pagamento PIX
 */
app.get('/api/payment/pix/:id/status', (req, res) => {
    const { id } = req.params;
    const pix = pixPayments[id];
    if (!pix) {
        return res.status(404).json({ success: false, error: 'Pagamento não encontrado' });
    }
    res.json({ success: true, payment_id: id, status: pix.status, order_id: pix.order_id });
});

/**
 * POST /webhook/pix
 * Webhook de confirmação do Mercado Pago
 */
app.post('/webhook/pix', (req, res) => {
    res.sendStatus(200);
    const { data, type } = req.body;
    if (type !== 'payment' || !data?.id) return;

    const paymentId = String(data.id);
    if (pixPayments[paymentId]) {
        pixPayments[paymentId].status = 'approved';
        log('INFO', `PIX aprovado via webhook`, { paymentId });
    }
});

// ─── WhatsApp / Ana ───────────────────────────────────────────────────────────

/**
 * POST /webhook/whatsapp
 * Webhook da Evolution API → processa mensagens com o agente Ana
 */
app.post('/webhook/whatsapp', async (req, res) => {
    // Responde 200 imediatamente (Evolution API exige resposta rapida)
    res.sendStatus(200);

    try {
        const { tenant, instanceName, hints } = getTenantFromRequest(req);
        const rawData = req.body?.data;
        const payload = Array.isArray(rawData) ? rawData[0] : (rawData || req.body);
        if (!payload) return;

        const key = payload.key || payload?.messages?.[0]?.key || {};
        const fromMe = Boolean(key.fromMe ?? payload.fromMe ?? payload?.messages?.[0]?.key?.fromMe);
        if (fromMe) return;

        const remoteJid = key.remoteJid
            || payload.remoteJid
            || payload.chatId
            || payload.sender
            || payload?.messages?.[0]?.key?.remoteJid
            || '';
        const participantJid = key.participant || payload.participant || payload?.messages?.[0]?.key?.participant || '';
        const sourceJid = String(remoteJid).endsWith('@g.us') && participantJid ? participantJid : remoteJid;
        const phone = String(sourceJid || '').split('@')[0].replace(/\D/g, '');
        if (!phone) {
            log('WARN', 'Webhook WhatsApp sem telefone valido', {
                event: req.body?.event || req.body?.type || null,
                remoteJid,
                participantJid,
                instanceName,
                hints,
            });
            return;
        }

        const msg = payload.message || payload?.messages?.[0]?.message || {};
        const unwrapMessage = (m) =>
            m?.ephemeralMessage?.message
            || m?.viewOnceMessage?.message
            || m?.viewOnceMessageV2?.message
            || m?.viewOnceMessageV2Extension?.message
            || m;

        const extractText = (m) => {
            const mm = unwrapMessage(m || {});
            return mm.conversation
                || mm.extendedTextMessage?.text
                || mm.imageMessage?.caption
                || mm.videoMessage?.caption
                || mm.documentMessage?.caption
                || mm.buttonsResponseMessage?.selectedDisplayText
                || mm.templateButtonReplyMessage?.selectedDisplayText
                || mm.listResponseMessage?.title
                || mm.listResponseMessage?.singleSelectReply?.selectedRowId
                || '';
        };
        const text = (extractText(msg) || payload.text || '').trim();
        const hasAudio = Boolean(msg?.audioMessage || msg?.pttMessage || msg?.voiceMessage);

        if (!text && !hasAudio) {
            log('WARN', 'Webhook WhatsApp sem texto processavel', {
                event: req.body?.event || req.body?.type || null,
                remoteJid,
                participantJid,
                instanceName,
                hints,
            });
            return;
        }

        const tenantId = tenant?.id || 'default';
        log('INFO', `WhatsApp recebido de ${phone}`, { tenantId, text: text.slice(0, 80), remoteJid, instanceName });

        const boundApiRequest = (environment, method, apiPath, body = null) =>
            apiRequest(environment, method, apiPath, body, tenant);
        const boundGetEnvConfig = (environment) => getEnvConfig(environment, tenant);

        const result = await handleWhatsAppMessage(phone, text, {
            apiRequest: boundApiRequest,
            getEnvConfig: boundGetEnvConfig,
            log,
            tenant,
            rawMessage: msg,
            instanceName,
        });
        if (result?.reply) {
            log('INFO', `Ana -> ${phone}`, { tenantId, reply: result.reply.slice(0, 200) });
        }
    } catch (err) {
        log('ERROR', 'Erro no webhook WhatsApp', err.message);
    }
});
// ─── Rota raiz (documentação rápida) ─────────────────────────────────────────

const apiOverview = () => ({
    name: 'SAIPOS API Integration',
    version: '3.0.0',
    endpoints: {
        auth:            'GET  /api/auth?environment=homologation',
        catalog:         'GET  /api/catalog?environment=homologation',
        totemCatalog:    'GET  /api/totem/catalog?environment=homologation',
        totemOrder:      'POST /api/totem/order?environment=homologation',
        orders:          'GET  /api/orders?environment=homologation&order_id=ID',
        ordersStatus:    'GET  /api/orders/status?environment=homologation&pad=1&table=5',
        waiters:         'GET  /api/waiters?environment=homologation',
        tenants:         'GET  /api/tenants',
        createTicket:    'POST /api/orders/ticket?environment=homologation',
        createDelivery:  'POST /api/orders/delivery?environment=homologation',
        createTable:     'POST /api/orders/table?environment=homologation',
        cancelOrder:     'POST /api/orders/cancel?environment=homologation',
        closeOrder:      'PUT  /api/orders/close?environment=homologation',
        pixGenerate:     'POST /api/payment/pix',
        pixStatus:       'GET  /api/payment/pix/:id/status',
        webhookPix:      'POST /webhook/pix',
        webhookWhatsApp: 'POST /webhook/whatsapp',
        totemUI:         'GET  /totem.html',
        lovableUI:       'GET  /lovable/',
    },
    environments: ['homologation', 'production'],
});

app.get('/api', (_req, res) => {
    res.json(apiOverview());
});

app.get('/api/frontend-build', (_req, res) => {
    const indexPath = path.join(__dirname, 'public', 'lovable', 'index.html');
    if (!fs.existsSync(indexPath)) {
        return res.status(404).json({
            success: false,
            error: 'Frontend index não encontrado',
        });
    }

    const html = fs.readFileSync(indexPath, 'utf8');
    const scriptMatch = html.match(/<script[^>]*src="([^"]+)"/i);
    const cssMatch = html.match(/<link[^>]*href="([^"]+\.css)"/i);

    return res.json({
        success: true,
        indexPath: 'public/lovable/index.html',
        jsEntry: scriptMatch ? scriptMatch[1] : null,
        cssEntry: cssMatch ? cssMatch[1] : null,
    });
});

app.get('/', (_req, res) => {
    const lovableIndex = path.join(__dirname, 'public', 'lovable', 'index.html');
    if (fs.existsSync(lovableIndex)) {
        return res.sendFile(lovableIndex);
    }
    return res.json(apiOverview());
});

// SPA fallback: allow direct access to frontend routes like /dashboard.
app.get(/^\/(?!api(?:\/|$)|webhook(?:\/|$)).*/, (req, res, next) => {
    if (path.extname(req.path)) return next();
    const lovableIndex = path.join(__dirname, 'public', 'lovable', 'index.html');
    if (fs.existsSync(lovableIndex)) {
        return res.sendFile(lovableIndex);
    }
    return next();
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    log('INFO', `Servidor SAIPOS API rodando em http://localhost:${PORT}`);
    log('INFO', 'Documentação rápida disponível em http://localhost:' + PORT + '/');
});

