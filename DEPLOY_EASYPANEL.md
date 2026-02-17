# Deploy na VPS com EasyPanel

Este projeto e um backend Node/Express. Supabase e Cloudflare continuam externos.

## 1) Preparar repositorio GitHub

No seu computador:

```bash
git init
git add .
git commit -m "chore: prepare easypanel deploy"
git branch -M main
git remote add origin git@github.com:SEU_USUARIO/SEU_REPO.git
git push -u origin main
```

Se usar HTTPS:

```bash
git remote add origin https://github.com/SEU_USUARIO/SEU_REPO.git
```

## 2) Criar app no EasyPanel

1. EasyPanel -> New Project (ou use um existente).
2. Add Service -> App.
3. Source: GitHub repo deste projeto.
4. Build Type: Dockerfile.
5. Port interno: `3993`.
6. Start command: deixe padrao do Dockerfile (`npm start`).

## 3) Variaveis de ambiente

No EasyPanel -> Service -> Environment, copie os valores do `.env` (nao comitar `.env`).

Minimo recomendado:

- `PORT=3993`
- `OPENAI_API_KEY`
- `HOMOLOG_*` e/ou `PRODUCTION_*`
- `EVOLUTION_API_URL`
- `EVOLUTION_API_KEY`
- `TENANTS_CONFIG_PATH=/app/config/tenants.json`
- `ANA_STATE_FILE=/app/data/ana_state.json`

Para nicho delivery com Ana Food:

- `ANAFOOD_API_URL`
- `ANAFOOD_AUTH_MODE`
- `ANAFOOD_COMPANY_KEY` (ou token/header conforme tenant)

## 4) Volume persistente

Crie volume e monte em `/app/data` para manter estado conversacional (`ana_state.json`) entre reinicios.

## 5) Dominio e SSL

1. EasyPanel -> Domains.
2. Configure subdominio, exemplo: `api.seudominio.com`.
3. Aponte DNS (A/CNAME) para VPS conforme instrucoes do painel.
4. Ative SSL (Let's Encrypt no EasyPanel).

## 6) Ajustar webhook da Evolution

Atualize no Evolution API:

- URL: `https://api.seudominio.com/webhook/whatsapp`
- Metodo: `POST`
- Eventos: mensagens recebidas

## 7) Smoke test

```bash
curl https://api.seudominio.com/
curl https://api.seudominio.com/api/tenants
```

Depois envie mensagem real no WhatsApp conectado e valide logs.

## 8) Operacao continua (GitHub -> VPS)

Fluxo recomendado:

1. Desenvolve local
2. `git add . && git commit -m "..."`
3. `git push`
4. EasyPanel faz pull/build/deploy automatico (se auto deploy habilitado)

## Observacoes importantes

- Rotacione chaves expostas anteriormente (`service_role` Supabase, tokens etc).
- Mantenha `config/tenants.json` com placeholders `${ENV_VAR}` para multi-tenant seguro.
