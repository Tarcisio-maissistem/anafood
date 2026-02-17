# SAIPOS API

Backend Node/Express com suporte a multi-tenant, webhook WhatsApp (Evolution) e roteamento de pedidos para SAIPOS ou Ana Food por tenant.

## Rodar local

```bash
npm install
cp .env.example .env
npm start
```

Aplicacao em `http://localhost:3993`.

## Frontend Lovable no mesmo repo

O build publicado da Lovable foi importado para `public/lovable`.

- Acesso local: `http://localhost:3993/lovable/`
- Sincronizar novamente do deploy Lovable:

```bash
npm run sync:lovable
```

## Deploy na VPS (EasyPanel)

Veja `DEPLOY_EASYPANEL.md`.
