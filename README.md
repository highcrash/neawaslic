# neawaslic — license server stack

Self-hosted license server, admin UI, and zero-dep TypeScript client
for the **Restora POS CodeCanyon edition** and any future products
sold on Envato or elsewhere.

Lives at **https://api.neawaslic.top** (license API) and
**https://admin.neawaslic.top** (admin dashboard). Single Ubuntu
droplet — Caddy + Nest + nginx + Postgres in four docker containers.

Split out of the [restora-pos](https://github.com/highcrash/eatro)
monorepo on 2026-04-19. History for the four moved paths is preserved.

## Workspaces

| Path | Package | Purpose |
| ---- | ------- | ------- |
| `apps/license-server`  | `@restora/license-server` | NestJS API on port 3002 — activate / verify / deactivate + admin endpoints |
| `apps/license-admin`   | `@restora/license-admin`  | Vite + React SPA — login, products, purchase codes, licenses, logs, settings |
| `packages/license-client` | `@restora/license-client` | Zero-dep client lib consumed by the CodeCanyon fork's API gate + POS Desktop |
| `packages/config`      | `@restora/config`         | Shared eslint / tsconfig / prettier base |
| `infra/license-droplet`| —                         | docker-compose + Caddy + provisioner + backup script |

Package names stay under `@restora/*` so the CodeCanyon fork can
consume `@restora/license-client` from npm / git+url without rewriting
imports.

## Local dev

```bash
pnpm install
docker compose -f infra/license-droplet/docker-compose.yml up -d postgres   # or use your own PG
cp apps/license-server/.env.example apps/license-server/.env
pnpm dev:server   # api on :3002
pnpm dev:admin    # ui on :5178 (proxies /api → :3002)
```

## Production

See [`infra/license-droplet/README.md`](infra/license-droplet/README.md)
for the full droplet runbook (provisioner, secrets, backups, updates).

## Why split

Three reasons:

1. **Failure-domain separation.** A product-app outage on `eatrobd.com`
   must not affect licensing, and vice versa.
2. **Independent release cadence.** Licensing changes ship by their
   own schedule, separate from POS feature work.
3. **Shipping the SDK.** The CodeCanyon zip needs `@restora/license-client`
   but absolutely must not ship the server. A separate repo makes the
   boundary impossible to violate by accident.

## License

Proprietary. © 2026 Restora.
