'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.TENANTS_CONFIG_PATH
    ? path.resolve(process.env.TENANTS_CONFIG_PATH)
    : path.join(__dirname, '..', 'config', 'tenants.json');

const interpolateEnv = (value) => {
    if (typeof value !== 'string') return value;
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, key) => process.env[key] || '');
};

const deepInterpolate = (obj) => {
    if (Array.isArray(obj)) return obj.map(deepInterpolate);
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = deepInterpolate(v);
        return out;
    }
    return interpolateEnv(obj);
};

function loadTenantsConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const config = deepInterpolate(parsed);

        const tenants = Array.isArray(config.tenants) ? config.tenants.filter(t => t && t.id) : [];
        const defaultTenantId = config.defaultTenantId || tenants[0]?.id || null;

        return { defaultTenantId, tenants };
    } catch (_) {
        return { defaultTenantId: null, tenants: [] };
    }
}

function resolveTenant({ tenantId, instanceName } = {}) {
    const cfg = loadTenantsConfig();

    let tenant = null;
    if (tenantId) {
        tenant = cfg.tenants.find(t => t.id === tenantId && t.active !== false) || null;
    }

    if (!tenant && instanceName) {
        tenant = cfg.tenants.find(t =>
            t.active !== false && String(t?.evolution?.instance || '').toLowerCase() === String(instanceName).toLowerCase()
        ) || null;
    }

    if (!tenant && cfg.defaultTenantId) {
        tenant = cfg.tenants.find(t => t.id === cfg.defaultTenantId && t.active !== false) || null;
    }

    if (!tenant && cfg.tenants.length > 0) {
        tenant = cfg.tenants.find(t => t.active !== false) || cfg.tenants[0];
    }

    return tenant;
}

function listTenants() {
    return loadTenantsConfig().tenants;
}

module.exports = {
    CONFIG_PATH,
    loadTenantsConfig,
    resolveTenant,
    listTenants,
};
