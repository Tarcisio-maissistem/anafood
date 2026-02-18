const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

dotenv.config();

const { handleWhatsAppMessage, sessions: anaSessions } = require('./agents/ana');
const { resolveTenant, listTenants } = require('./lib/tenants');

const app = express();
const PORT = process.env.PORT || 3993;
const contactControls = new Map();
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

const logConversationEvent = ({ direction, source, tenantId, instance, phone, remoteJid, text }) => {
    const preview = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const side = direction === 'OUT' ? '->' : '<-';
    log('CHAT', `${side} ${source || 'unknown'} ${phone || '-'} ${preview}`, {
        tenantId: tenantId || 'default',
        instance: instance || null,
        phone: phone || null,
        remoteJid: remoteJid || null,
        chars: preview.length,
    });
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

const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const safeTrim = (value) => String(value || '').trim();
const isLikelyPhoneDigits = (value) => /^\d{10,15}$/.test(String(value || ''));

const findSessionByRemoteJid = (tenantId, remoteJid) => {
    const target = String(remoteJid || '').trim().toLowerCase();
    if (!target) return null;
    for (const session of anaSessions.values()) {
        if (String(session?.tenantId || 'default') !== String(tenantId || 'default')) continue;
        const current = String(session?.remoteJid || '').trim().toLowerCase();
        if (current && current === target) return session;
    }
    return null;
};

const resolveCanonicalPhone = ({ tenantId, phone, remoteJid }) => {
    const p = normalizePhone(phone || '');
    if (isLikelyPhoneDigits(p)) return p;

    const byJid = findSessionByRemoteJid(tenantId, remoteJid);
    if (byJid?.phone) return normalizePhone(byJid.phone);

    if (p) return p;
    const fromJid = normalizePhone(String(remoteJid || '').split('@')[0] || '');
    return fromJid;
};

const getContactKey = (tenantId, phone) => `${tenantId}:${normalizePhone(phone)}`;

const getContactControl = (tenantId, phone) => {
    const key = getContactKey(tenantId, phone);
    return contactControls.get(key) || { paused: false, blocked: false };
};

const setContactControl = (tenantId, phone, patch) => {
    const key = getContactKey(tenantId, phone);
    const current = contactControls.get(key) || { paused: false, blocked: false };
    const updated = {
        paused: Boolean(patch?.paused ?? current.paused),
        blocked: Boolean(patch?.blocked ?? current.blocked),
        updatedAt: new Date().toISOString(),
    };
    contactControls.set(key, updated);
    return updated;
};

const getEvolutionConfig = (tenant, instanceName = null) => ({
    apiUrl: tenant?.evolution?.apiUrl || process.env.EVOLUTION_API_URL || '',
    apiKey: tenant?.evolution?.apiKey || process.env.EVOLUTION_API_KEY || '',
    instance: instanceName || tenant?.evolution?.instance || process.env.EVOLUTION_INSTANCE || '',
});

const sendEvolutionText = async ({ apiUrl, apiKey, instance, phone, remoteJid, text }) => {
    const safeText = String(text || '').trim();
    if (!apiUrl || !apiKey || !instance || !safeText) return { ok: false, error: 'Parametros invalidos para envio' };

    const rawPhone = String(phone || '').trim();
    const digitsPhone = normalizePhone(rawPhone);
    const numbers = Array.from(new Set([
        safeTrim(remoteJid),
        rawPhone,
        digitsPhone,
        digitsPhone ? `${digitsPhone}@s.whatsapp.net` : '',
        digitsPhone ? `${digitsPhone}@lid` : '',
    ].filter(Boolean)));
    const endpoints = [
        `${apiUrl}/message/sendText/${instance}`,
        `${apiUrl}/message/sendText/${instance}?delay=600`,
    ];
    const payloads = [
        { number: null, text: safeText, delay: 600 },
        { number: null, textMessage: { text: safeText }, options: { delay: 600 } },
        { number: null, textMessage: { text: safeText } },
    ];

    let lastError = null;
    for (const number of numbers) {
        for (const endpoint of endpoints) {
            for (const payloadTemplate of payloads) {
                try {
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            apikey: apiKey,
                            Authorization: `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ ...payloadTemplate, number }),
                    });
                    if (response.ok) return { ok: true };
                    const bodyText = await response.text().catch(() => '');
                    lastError = `HTTP ${response.status} ${bodyText}`;
                } catch (err) {
                    lastError = err.message;
                }
            }
        }
    }
    return { ok: false, error: lastError || 'Falha desconhecida no envio de texto' };
};

const sendEvolutionMedia = async ({ apiUrl, apiKey, instance, phone, remoteJid, base64, mimeType, fileName, caption = '' }) => {
    if (!apiUrl || !apiKey || !instance || !base64) return { ok: false, error: 'Parametros invalidos para envio de midia' };

    const rawPhone = String(phone || '').trim();
    const digitsPhone = normalizePhone(rawPhone);
    const numbers = Array.from(new Set([
        safeTrim(remoteJid),
        rawPhone,
        digitsPhone,
        digitsPhone ? `${digitsPhone}@s.whatsapp.net` : '',
        digitsPhone ? `${digitsPhone}@lid` : '',
    ].filter(Boolean)));
    const endpoints = [
        `${apiUrl}/message/sendMedia/${instance}`,
        `${apiUrl}/message/sendFileFromBase64/${instance}`,
    ];
    const payloads = [
        {
            number: null,
            mediatype: 'document',
            mimetype: mimeType || 'application/octet-stream',
            fileName: fileName || 'arquivo.bin',
            caption,
            media: base64,
        },
        {
            number: null,
            options: { delay: 600 },
            mediaMessage: {
                mediatype: 'document',
                mimetype: mimeType || 'application/octet-stream',
                fileName: fileName || 'arquivo.bin',
                caption,
                media: base64,
            },
        },
    ];

    let lastError = null;
    for (const number of numbers) {
        for (const endpoint of endpoints) {
            for (const payloadTemplate of payloads) {
                try {
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            apikey: apiKey,
                            Authorization: `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ ...payloadTemplate, number }),
                    });
                    if (response.ok) return { ok: true };
                    const bodyText = await response.text().catch(() => '');
                    lastError = `HTTP ${response.status} ${bodyText}`;
                } catch (err) {
                    lastError = err.message;
                }
            }
        }
    }

    return { ok: false, error: lastError || 'Falha desconhecida no envio de midia' };
};

const toArrayPayload = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.data?.data)) return payload.data.data;
    if (Array.isArray(payload?.result)) return payload.result;
    if (Array.isArray(payload?.results)) return payload.results;
    if (Array.isArray(payload?.response)) return payload.response;
    if (Array.isArray(payload?.chats)) return payload.chats;
    if (Array.isArray(payload?.data?.chats)) return payload.data.chats;
    if (Array.isArray(payload?.messages)) return payload.messages;
    if (Array.isArray(payload?.data?.messages)) return payload.data.messages;
    if (Array.isArray(payload?.records)) return payload.records;
    return [];
};

const extractRemoteJidFromChat = (chat) => {
    const id = chat?.id;
    if (typeof id === 'string') return id;
    if (typeof id?.id === 'string') return id.id;
    if (typeof id?._serialized === 'string') return id._serialized;
    return (
        chat?.remoteJid ||
        chat?.jid ||
        chat?.key?.remoteJid ||
        chat?.chatId ||
        chat?.conversationId ||
        ''
    );
};

const extractTextFromAnyMessage = (msg) => {
    const m = msg?.message || msg?.data?.message || msg || {};
    return (
        m?.conversation ||
        m?.extendedTextMessage?.text ||
        m?.imageMessage?.caption ||
        m?.videoMessage?.caption ||
        m?.documentMessage?.caption ||
        m?.buttonsResponseMessage?.selectedDisplayText ||
        m?.templateButtonReplyMessage?.selectedDisplayText ||
        m?.listResponseMessage?.title ||
        m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        msg?.text ||
        ''
    );
};

const fetchEvolutionChats = async ({ apiUrl, apiKey, instance, limit = 50 }) => {
    if (!apiUrl || !apiKey || !instance) return [];
    const calls = [
        { method: 'POST', url: `${apiUrl}/chat/findChats/${instance}`, body: { limit, page: 1 } },
        { method: 'POST', url: `${apiUrl}/chat/findChats/${instance}`, body: { where: {}, limit } },
        { method: 'POST', url: `${apiUrl}/chat/findChats/${instance}`, body: {} },
        { method: 'GET', url: `${apiUrl}/chat/findChats/${instance}?page=1&limit=${limit}` },
        { method: 'GET', url: `${apiUrl}/chat/findChats/${instance}?limit=${limit}` },
        { method: 'GET', url: `${apiUrl}/chat/findChats/${instance}` },
        { method: 'GET', url: `${apiUrl}/chat/fetchChats/${instance}?page=1&limit=${limit}` },
        { method: 'GET', url: `${apiUrl}/chat/fetchChats/${instance}` },
    ];

    for (const call of calls) {
        try {
            const response = await fetch(call.url, {
                method: call.method,
                headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                ...(call.method !== 'GET' ? { body: JSON.stringify(call.body || {}) } : {}),
            });
            if (!response.ok) continue;
            const payload = await response.json().catch(() => ({}));
            const chats = toArrayPayload(payload);
            if (!chats.length) continue;

            return chats.slice(0, limit).map((chat) => {
                const remoteJid = extractRemoteJidFromChat(chat);
                const phone = String(remoteJid).split('@')[0].replace(/\D/g, '');
                const lastMessageText = extractTextFromAnyMessage(chat?.lastMessage || chat?.message || chat);
                const ts = chat?.conversationTimestamp || chat?.timestamp || chat?.t || chat?.lastMessageTimestamp || null;
                const at = ts ? new Date(Number(ts) > 9999999999 ? Number(ts) : Number(ts) * 1000).toISOString() : null;
                const name =
                    chat?.pushName ||
                    chat?.name ||
                    chat?.notify ||
                    chat?.contactName ||
                    chat?.contact?.name ||
                    chat?.contact?.pushName ||
                    chat?.verifiedName ||
                    '';
                const avatarUrl =
                    chat?.profilePicUrl ||
                    chat?.profilePictureUrl ||
                    chat?.picture ||
                    chat?.avatar ||
                    chat?.imgUrl ||
                    chat?.contact?.profilePicUrl ||
                    chat?.contact?.profilePictureUrl ||
                    '';
                return {
                    phone,
                    remoteJid: remoteJid || (phone ? `${phone}@s.whatsapp.net` : ''),
                    name: String(name || '').trim(),
                    avatarUrl: String(avatarUrl || '').trim(),
                    lastMessage: { role: 'user', content: String(lastMessageText || '').slice(0, 280), at },
                    lastActivityAt: at,
                };
            }).filter((c) => c.phone);
        } catch (_) {
            // try next endpoint
        }
    }
    return [];
};

const fetchEvolutionMessages = async ({ apiUrl, apiKey, instance, remoteJid, limit = 80 }) => {
    if (!apiUrl || !apiKey || !instance || !remoteJid) return [];
    const encodedJid = encodeURIComponent(remoteJid);
    const calls = [
        { method: 'POST', url: `${apiUrl}/chat/findMessages/${instance}`, body: { where: { remoteJid }, limit } },
        { method: 'POST', url: `${apiUrl}/chat/findMessages/${instance}`, body: { where: { key: { remoteJid } }, limit } },
        { method: 'POST', url: `${apiUrl}/chat/findMessages/${instance}`, body: { remoteJid, limit } },
        { method: 'POST', url: `${apiUrl}/chat/findMessages/${instance}/${encodedJid}`, body: { limit } },
        { method: 'GET', url: `${apiUrl}/chat/findMessages/${instance}/${encodedJid}?page=1&limit=${limit}` },
        { method: 'GET', url: `${apiUrl}/chat/findMessages/${instance}/${encodedJid}` },
        { method: 'GET', url: `${apiUrl}/chat/findMessages/${instance}?remoteJid=${encodedJid}&page=1&limit=${limit}` },
        { method: 'GET', url: `${apiUrl}/chat/findMessages/${instance}?remoteJid=${encodedJid}` },
    ];

    for (const call of calls) {
        try {
            const response = await fetch(call.url, {
                method: call.method,
                headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                ...(call.method !== 'GET' ? { body: JSON.stringify(call.body || {}) } : {}),
            });
            if (!response.ok) continue;
            const payload = await response.json().catch(() => ({}));
            const rows = toArrayPayload(payload);
            if (!rows.length) continue;

            const mapped = rows.map((row) => {
                const key = row?.key || row?.data?.key || {};
                const fromMe = Boolean(key?.fromMe ?? row?.fromMe ?? false);
                const text = extractTextFromAnyMessage(row);
                const ts = row?.messageTimestamp || row?.timestamp || row?.data?.messageTimestamp || null;
                const at = ts ? new Date(Number(ts) > 9999999999 ? Number(ts) : Number(ts) * 1000).toISOString() : null;
                return {
                    role: fromMe ? 'assistant' : 'user',
                    content: String(text || '').slice(0, 2000),
                    at,
                };
            }).filter((m) => m.content);

            return mapped.slice(-limit);
        } catch (_) {
            // try next endpoint
        }
    }

    return [];
};

const fetchEvolutionContacts = async ({ apiUrl, apiKey, instance, limit = 50 }) => {
    if (!apiUrl || !apiKey || !instance) return [];
    const calls = [
        { method: 'POST', url: `${apiUrl}/chat/findContacts/${instance}`, body: { where: {}, limit } },
        { method: 'POST', url: `${apiUrl}/chat/findContacts/${instance}`, body: {} },
        { method: 'GET', url: `${apiUrl}/chat/findContacts/${instance}?limit=${limit}` },
        { method: 'GET', url: `${apiUrl}/chat/findContacts/${instance}` },
    ];

    for (const call of calls) {
        try {
            const response = await fetch(call.url, {
                method: call.method,
                headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                ...(call.method !== 'GET' ? { body: JSON.stringify(call.body || {}) } : {}),
            });
            if (!response.ok) continue;
            const payload = await response.json().catch(() => ({}));
            const rows = toArrayPayload(payload);
            if (!rows.length) continue;

            return rows.slice(0, limit).map((row) => {
                const remoteJid =
                    row?.remoteJid ||
                    row?.id ||
                    row?.jid ||
                    row?.key?.remoteJid ||
                    '';
                const phone = String(remoteJid).split('@')[0].replace(/\D/g, '');
                const name =
                    row?.pushName ||
                    row?.name ||
                    row?.notify ||
                    row?.contactName ||
                    row?.verifiedName ||
                    row?.contact?.name ||
                    row?.contact?.pushName ||
                    '';
                const avatarUrl =
                    row?.profilePicUrl ||
                    row?.profilePictureUrl ||
                    row?.picture ||
                    row?.avatar ||
                    row?.imgUrl ||
                    row?.contact?.profilePicUrl ||
                    row?.contact?.profilePictureUrl ||
                    '';
                return {
                    phone,
                    remoteJid: remoteJid || (phone ? `${phone}@s.whatsapp.net` : ''),
                    name: String(name || '').trim(),
                    avatarUrl: String(avatarUrl || '').trim(),
                    lastMessage: null,
                    lastActivityAt: null,
                };
            }).filter((c) => c.phone);
        } catch (_) {
            // try next endpoint
        }
    }
    return [];
};

const fetchEvolutionInstances = async ({ apiUrl, apiKey }) => {
    if (!apiUrl || !apiKey) return [];
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
                headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            });
            if (!response.ok) continue;
            const payload = await response.json().catch(() => ({}));
            const rows = toArrayPayload(payload);
            if (!rows.length) continue;

            const instances = rows.map((row) => {
                const name =
                    row?.instance?.instanceName ||
                    row?.instanceName ||
                    row?.name ||
                    row?.instance ||
                    '';
                const state =
                    row?.instance?.state ||
                    row?.state ||
                    row?.status ||
                    '';
                return { name: String(name), state: String(state).toLowerCase() };
            }).filter((r) => r.name);

            if (instances.length) return instances;
        } catch (_) {
            // try next endpoint
        }
    }
    return [];
};

const pickBestEvolutionInstance = (configuredInstance, availableInstances = []) => {
    const byName = new Map(availableInstances.map((i) => [i.name, i]));
    const configured = configuredInstance ? byName.get(configuredInstance) : null;
    const open = availableInstances.find((i) => ['open', 'connected'].includes(i.state));
    const connecting = availableInstances.find((i) => i.state === 'connecting');

    if (configured && ['open', 'connected'].includes(configured.state)) return configured.name;
    if (open?.name) return open.name;
    if (configured && configured.state === 'connecting') return configured.name;
    if (connecting?.name) return connecting.name;
    if (configured?.name) return configured.name;
    if (availableInstances[0]?.name) return availableInstances[0].name;
    return configuredInstance || '';
};

const ensureEvolutionWebhook = async ({ apiUrl, apiKey, instance, webhookUrl }) => {
    if (!apiUrl || !apiKey || !instance || !webhookUrl) return { ok: false, skipped: true };

    const cleanUrl = String(webhookUrl || '').trim();
    const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const payloads = [
        { enabled: true, url: cleanUrl, webhook: cleanUrl, events: ['MESSAGES_UPSERT'] },
        { webhook: { enabled: true, url: cleanUrl, events: ['MESSAGES_UPSERT'] } },
        { webhook: cleanUrl, enabled: true },
    ];
    const calls = [
        { method: 'POST', url: `${apiUrl}/webhook/set/${instance}` },
        { method: 'PUT', url: `${apiUrl}/webhook/set/${instance}` },
        { method: 'POST', url: `${apiUrl}/webhook/update/${instance}` },
        { method: 'PUT', url: `${apiUrl}/webhook/update/${instance}` },
    ];

    for (const call of calls) {
        for (const body of payloads) {
            try {
                const response = await fetch(call.url, {
                    method: call.method,
                    headers,
                    body: JSON.stringify(body),
                });
                if (response.ok) return { ok: true };
            } catch (_) {
                // keep trying alternative endpoint/payload
            }
        }
    }
    return { ok: false };
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
        req.body?.instance?.instanceName ||
        req.body?.instance?.name ||
        payload.instance ||
        payload?.instance?.instanceName ||
        payload?.instance?.name ||
        payload.instanceName ||
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
        const simulatedRemoteJid = req.body?.remoteJid || (phone ? `${phone}@s.whatsapp.net` : null);
        logConversationEvent({
            direction: 'IN',
            source: 'simulate',
            tenantId,
            instance: req.body?.instance || req.body?.instanceName || null,
            phone,
            remoteJid: simulatedRemoteJid,
            text,
        });

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
            remoteJid: req.body?.remoteJid || null,
            contactName: req.body?.contactName || '',
            onSend: ({ phone: sentPhone, text: sentText, remoteJid: sentRemoteJid, instance: sentInstance }) => {
                logConversationEvent({
                    direction: 'OUT',
                    source: 'agent',
                    tenantId,
                    instance: sentInstance,
                    phone: sentPhone,
                    remoteJid: sentRemoteJid,
                    text: sentText,
                });
            },
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
 * GET /api/ana/default-instance
 * Resolve a melhor instancia Evolution disponivel para o tenant.
 */
app.get('/api/ana/default-instance', async (req, res) => {
    try {
        const tenant = resolveTenant({
            tenantId: req.query?.tenant_id || req.query?.tenant || null,
            instanceName: req.query?.instance || null,
        });
        const tenantId = tenant?.id || 'default';
        const evo = getEvolutionConfig(tenant, req.query?.instance || null);
        const availableInstances = await fetchEvolutionInstances({ apiUrl: evo.apiUrl, apiKey: evo.apiKey });
        const instance = pickBestEvolutionInstance(evo.instance, availableInstances);
        const webhookUrl = process.env.WEBHOOK_PUBLIC_URL || `${req.protocol}://${req.get('host')}/webhook/whatsapp`;
        const webhook = await ensureEvolutionWebhook({ apiUrl: evo.apiUrl, apiKey: evo.apiKey, instance, webhookUrl });
        return res.json({
            success: true,
            tenantId,
            instance,
            configuredInstance: evo.instance,
            availableInstances,
            webhook,
        });
    } catch (error) {
        handleError(res, error);
    }
});

/**
 * GET /api/ana/conversations
 * Lista conversas conhecidas para inbox operacional.
 * Query: tenant_id (opcional), instance (opcional), search (opcional)
 */
app.get('/api/ana/conversations', (req, res) => {
    const tenant = resolveTenant({
        tenantId: req.query?.tenant_id || req.query?.tenant || null,
        instanceName: req.query?.instance || null,
    });
    const tenantId = tenant?.id || 'default';
    const search = String(req.query?.search || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));
    const evo = getEvolutionConfig(tenant, req.query?.instance || null);

    const inMemoryRows = Array.from(anaSessions.entries())
        .map(([key, session]) => ({ key, session }))
        .filter(({ session }) => String(session?.tenantId || 'default') === tenantId)
        .map(({ session }) => {
            const phone = resolveCanonicalPhone({
                tenantId,
                phone: session?.phone || '',
                remoteJid: session?.remoteJid || '',
            });
            const messages = Array.isArray(session?.messages) ? session.messages : [];
            const lastMessage = messages.length ? messages[messages.length - 1] : null;
            const control = getContactControl(tenantId, phone);
            return {
                phone,
                name: safeTrim(session?.contactName || session?.name || ''),
                avatarUrl: safeTrim(session?.avatarUrl || ''),
                remoteJid: safeTrim(session?.remoteJid || ''),
                state: session?.state || 'INIT',
                lastActivityAt: session?.lastActivityAt || session?.createdAt || null,
                messageCount: session?.messageCount || 0,
                lastMessage: lastMessage ? {
                    role: lastMessage.role || 'user',
                    content: String(lastMessage.content || '').slice(0, 280),
                    at: lastMessage.at || null,
                } : null,
                paused: control.paused,
                blocked: control.blocked,
            };
        });

    const buildResponse = async () => {
        const availableInstances = await fetchEvolutionInstances({ apiUrl: evo.apiUrl, apiKey: evo.apiKey });
        const resolvedInstance = pickBestEvolutionInstance(evo.instance, availableInstances);
        const webhookUrl = process.env.WEBHOOK_PUBLIC_URL || `${req.protocol}://${req.get('host')}/webhook/whatsapp`;
        await ensureEvolutionWebhook({ apiUrl: evo.apiUrl, apiKey: evo.apiKey, instance: resolvedInstance, webhookUrl });
        let evolutionRows = await fetchEvolutionChats({
            apiUrl: evo.apiUrl,
            apiKey: evo.apiKey,
            instance: resolvedInstance,
            limit,
        });
        if (!evolutionRows.length) {
            evolutionRows = await fetchEvolutionContacts({
                apiUrl: evo.apiUrl,
                apiKey: evo.apiKey,
                instance: resolvedInstance,
                limit,
            });
        }

        const merged = new Map();
        const mergeKey = (row) => {
            const phone = normalizePhone(row?.phone || '');
            if (isLikelyPhoneDigits(phone)) return `p:${phone}`;
            const jid = safeTrim(row?.remoteJid || '').toLowerCase();
            if (jid) return `r:${jid}`;
            return `p:${phone || '-'}`;
        };
        for (const row of evolutionRows) {
            if (!row?.phone && !row?.remoteJid) continue;
            const canonicalPhone = resolveCanonicalPhone({
                tenantId,
                phone: row.phone,
                remoteJid: row.remoteJid,
            });
            const control = getContactControl(tenantId, canonicalPhone);
            const normalizedRow = {
                ...row,
                phone: canonicalPhone || normalizePhone(row.phone || ''),
            };
            merged.set(mergeKey(normalizedRow), {
                phone: normalizedRow.phone,
                remoteJid: row.remoteJid || `${row.phone}@s.whatsapp.net`,
                name: safeTrim(row.name || ''),
                avatarUrl: safeTrim(row.avatarUrl || ''),
                state: 'INIT',
                messageCount: 0,
                lastActivityAt: row.lastActivityAt || null,
                lastMessage: row.lastMessage || null,
                paused: control.paused,
                blocked: control.blocked,
            });
        }

        for (const row of inMemoryRows) {
            if (!row?.phone && !row?.remoteJid) continue;
            const key = mergeKey(row);
            const current = merged.get(key) || {};
            merged.set(key, {
                ...current,
                ...row,
                remoteJid: current.remoteJid || `${row.phone}@s.whatsapp.net`,
                name: row.name || current.name || '',
                avatarUrl: row.avatarUrl || current.avatarUrl || '',
                lastActivityAt: row.lastActivityAt || current.lastActivityAt || null,
                lastMessage: row.lastMessage || current.lastMessage || null,
            });
        }

        const rows = Array.from(merged.values())
            .filter((c) => !search
                || c.phone.includes(search)
                || String(c?.name || '').toLowerCase().includes(search)
                || String(c?.lastMessage?.content || '').toLowerCase().includes(search))
            .sort((a, b) => new Date(b.lastActivityAt || 0).getTime() - new Date(a.lastActivityAt || 0).getTime())
            .slice(0, limit);

        return res.json({
            success: true,
            tenantId,
            instance: resolvedInstance,
            configuredInstance: evo.instance,
            availableInstances,
            count: rows.length,
            conversations: rows,
        });
    };

    buildResponse().catch((error) => handleError(res, error));
});

/**
 * GET /api/ana/messages
 * Query: phone (obrigatorio), tenant_id?, instance?, limit?
 */
app.get('/api/ana/messages', (req, res) => {
    const tenant = resolveTenant({
        tenantId: req.query?.tenant_id || req.query?.tenant || null,
        instanceName: req.query?.instance || null,
    });
    const tenantId = tenant?.id || 'default';
    const requestedPhone = normalizePhone(req.query?.phone || '');
    const requestedRemoteJid = String(req.query?.remoteJid || '').trim();
    const phone = resolveCanonicalPhone({
        tenantId,
        phone: requestedPhone,
        remoteJid: requestedRemoteJid,
    });
    if (!phone && !requestedRemoteJid) {
        return res.status(400).json({ success: false, error: 'Parametro "phone" ou "remoteJid" e obrigatorio' });
    }
    const limit = Math.max(1, Math.min(300, Number(req.query?.limit || 80)));
    const evo = getEvolutionConfig(tenant, req.query?.instance || null);
    const remoteJid = requestedRemoteJid || `${phone}@s.whatsapp.net`;

    const run = async () => {
        const availableInstances = await fetchEvolutionInstances({ apiUrl: evo.apiUrl, apiKey: evo.apiKey });
        const resolvedInstance = pickBestEvolutionInstance(evo.instance, availableInstances);
        const evolutionMessages = await fetchEvolutionMessages({
            apiUrl: evo.apiUrl,
            apiKey: evo.apiKey,
            instance: resolvedInstance,
            remoteJid,
            limit,
        });

        const key = `${tenantId}:${phone}`;
        const session = anaSessions.get(key);
        const localMessages = Array.isArray(session?.messages)
            ? session.messages.map((m) => ({
                role: m.role || 'user',
                content: String(m.content || ''),
                at: m.at || null,
            }))
            : [];

        const messages = (evolutionMessages.length ? evolutionMessages : localMessages).slice(-limit);
        return res.json({
            success: true,
            tenantId,
            instance: resolvedInstance,
            phone,
            remoteJid,
            count: messages.length,
            messages,
        });
    };
    run().catch((error) => handleError(res, error));
});

/**
 * GET /api/ana/contact-control
 * Query: phone (obrigatorio), tenant_id (opcional), instance (opcional)
 */
app.get('/api/ana/contact-control', (req, res) => {
    const phone = normalizePhone(req.query?.phone || '');
    if (!phone) return res.status(400).json({ success: false, error: 'Parametro "phone" e obrigatorio' });

    const tenant = resolveTenant({
        tenantId: req.query?.tenant_id || req.query?.tenant || null,
        instanceName: req.query?.instance || null,
    });
    const tenantId = tenant?.id || 'default';
    const control = getContactControl(tenantId, phone);
    return res.json({ success: true, tenantId, phone, control });
});

/**
 * POST /api/ana/contact-control
 * Body: { phone, paused?, blocked?, tenant_id?, instance? }
 */
app.post('/api/ana/contact-control', (req, res) => {
    const phone = normalizePhone(req.body?.phone || '');
    if (!phone) return res.status(400).json({ success: false, error: 'Campo "phone" e obrigatorio' });

    const tenant = resolveTenant({
        tenantId: req.body?.tenant_id || req.body?.tenant || null,
        instanceName: req.body?.instance || null,
    });
    const tenantId = tenant?.id || 'default';
    const control = setContactControl(tenantId, phone, {
        paused: req.body?.paused,
        blocked: req.body?.blocked,
    });
    return res.json({ success: true, tenantId, phone, control });
});

/**
 * POST /api/ana/send
 * Body: { phone, text?, mediaBase64?, mimeType?, fileName?, caption?, tenant_id?, instance? }
 */
app.post('/api/ana/send', async (req, res) => {
    try {
        const tenant = resolveTenant({
            tenantId: req.body?.tenant_id || req.body?.tenant || null,
            instanceName: req.body?.instance || null,
        });
        const tenantId = tenant?.id || 'default';
        const requestedPhone = normalizePhone(req.body?.phone || '');
        const remoteJid = String(req.body?.remoteJid || '').trim();
        const phone = resolveCanonicalPhone({
            tenantId,
            phone: requestedPhone,
            remoteJid,
        });
        if (!phone && !remoteJid) {
            return res.status(400).json({ success: false, error: 'Campo "phone" ou "remoteJid" e obrigatorio' });
        }
        const evo = getEvolutionConfig(tenant, req.body?.instance || null);
        const availableInstances = await fetchEvolutionInstances({ apiUrl: evo.apiUrl, apiKey: evo.apiKey });
        const resolvedInstance = pickBestEvolutionInstance(evo.instance, availableInstances);

        const text = String(req.body?.text || '').trim();
        const mediaBase64 = String(req.body?.mediaBase64 || '').trim();
        const mimeType = String(req.body?.mimeType || '').trim();
        const fileName = String(req.body?.fileName || '').trim();
        const caption = String(req.body?.caption || text || '').trim();

        let result;
        if (mediaBase64) {
            result = await sendEvolutionMedia({
                apiUrl: evo.apiUrl,
                apiKey: evo.apiKey,
                instance: resolvedInstance,
                phone,
                remoteJid,
                base64: mediaBase64,
                mimeType,
                fileName,
                caption,
            });
        } else if (text) {
            result = await sendEvolutionText({
                apiUrl: evo.apiUrl,
                apiKey: evo.apiKey,
                instance: resolvedInstance,
                phone,
                remoteJid,
                text,
            });
        } else {
            return res.status(400).json({ success: false, error: 'Informe "text" ou "mediaBase64"' });
        }

        if (!result?.ok) {
            return res.status(502).json({ success: false, error: result?.error || 'Falha ao enviar mensagem' });
        }

        const outboundText = mediaBase64
            ? `[midia] ${caption || fileName || mimeType || 'arquivo'}`
            : text;
        logConversationEvent({
            direction: 'OUT',
            source: 'manual',
            tenantId,
            instance: resolvedInstance,
            phone,
            remoteJid,
            text: outboundText,
        });

        const key = `${tenantId}:${phone}`;
        const session = anaSessions.get(key);
        if (session) {
            if (remoteJid) session.remoteJid = remoteJid;
            session.messages = Array.isArray(session.messages) ? session.messages : [];
            session.messages.push({
                role: 'assistant',
                content: mediaBase64 ? `[midia] ${caption || fileName || mimeType || 'arquivo'}` : text,
                at: new Date().toISOString(),
                metadata: { manual: true },
            });
            session.lastActivityAt = new Date().toISOString();
        }

        return res.json({ success: true, tenantId, phone, instance: resolvedInstance, configuredInstance: evo.instance });
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
        const tenantId = tenant?.id || 'default';
        const rawPhone = String(sourceJid || '').split('@')[0].replace(/\D/g, '');
        const phone = resolveCanonicalPhone({
            tenantId,
            phone: rawPhone,
            remoteJid: sourceJid,
        });
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

        const control = getContactControl(tenantId, phone);
        if (control.blocked) {
            log('INFO', 'Contato bloqueado: mensagem ignorada', { tenantId, phone, instanceName });
            return;
        }
        if (control.paused) {
            log('INFO', 'Agente pausado para contato: mensagem recebida sem resposta automatica', { tenantId, phone, instanceName });
            return;
        }

        const msg = payload.message || payload?.messages?.[0]?.message || {};
        const contactName =
            payload?.pushName ||
            payload?.notify ||
            payload?.contactName ||
            payload?.senderName ||
            payload?.profileName ||
            '';
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

        logConversationEvent({
            direction: 'IN',
            source: 'whatsapp',
            tenantId,
            instance: instanceName,
            phone,
            remoteJid,
            text: text || (hasAudio ? '[audio]' : ''),
        });

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
            remoteJid,
            contactName,
            onSend: ({ phone: sentPhone, text: sentText, remoteJid: sentRemoteJid, instance: sentInstance }) => {
                logConversationEvent({
                    direction: 'OUT',
                    source: 'agent',
                    tenantId,
                    instance: sentInstance || instanceName,
                    phone: sentPhone,
                    remoteJid: sentRemoteJid,
                    text: sentText,
                });
            },
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
        anaConversations:'GET  /api/ana/conversations',
        anaMessages:     'GET  /api/ana/messages',
        anaDefaultInst:  'GET  /api/ana/default-instance',
        anaContactCtrl:  'GET/POST /api/ana/contact-control',
        anaSend:         'POST /api/ana/send',
        conversasUI:     'GET  /conversas',
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

app.get('/conversas', (_req, res) => {
    const file = path.join(__dirname, 'public', 'conversas.html');
    if (!fs.existsSync(file)) return res.status(404).send('Pagina de conversas nao encontrada');
    return res.sendFile(file);
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

