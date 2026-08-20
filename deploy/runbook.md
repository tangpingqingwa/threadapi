# ThreadAPI — one-VPS runbook

Single Docker host. SQLite on a volume. The adapter stays on fixtures until you set `THREADAPI_LIVE=1` or `THREADAPI_ADAPTER=live`.

## Env

Copy [`.env.example`](../.env.example) to `/etc/threadapi.env` (mode `600`). Set:

| Variable | Production |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | listen port (default `3000`) |
| `THREADAPI_DATABASE` | required; must sit on the volume, e.g. `/app/data/threadapi.sqlite` |
| `THREADAPI_BOOTSTRAP_KEY` | optional first `xk_live_...` when the keys table is empty |
| `THREADAPI_LIVE` | leave unset (or `0`) until soak. `1` / `true` / `yes` / `on` selects live |
| `THREADAPI_ADAPTER` | leave unset. `live` also selects the syndication adapter |
| `THREADAPI_FIXTURE_ONLY` | leave unset on the VPS. `1` wins over live flags (CI) |

Do not bake secrets into the image. Do not commit `.env`. A bind-mount over `/app/data` must be writable by uid `1000` (`node`).

## Build and run

```bash
docker build -t threadapi:local .
docker run -d --name threadapi --restart unless-stopped --init \
  --env-file /etc/threadapi.env \
  -p 127.0.0.1:3000:3000 \
  -v threadapi-data:/app/data \
  threadapi:local
```

The process listens on `0.0.0.0:$PORT` as the non-root `node` user (uid 1000). Keep the published port on loopback and terminate TLS on Caddy or nginx.

## Health

`GET /healthz` → `200 {"ok":true}`. No auth.

```bash
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz"
```

After bootstrap:

```bash
curl -fsS -H "Authorization: Bearer $THREADAPI_BOOTSTRAP_KEY" \
  "http://127.0.0.1:${PORT:-3000}/v1/me"
```

Unroller HTML is the same process (`/` paste box, `/status/:id`).

## Enable live X

1. Confirm `/healthz` is green with live off (fixture adapter).
2. Set `THREADAPI_LIVE=1` (or `THREADAPI_ADAPTER=live`). `THREADAPI_FIXTURE_ONLY=1` keeps fixtures.
3. Recreate the container. Live uses versioned syndication JSON only — not official `api.x.com` / `api.twitter.com`.
4. HTML, captchas, and unknown JSON are `upstream_blocked` (503, 0 credits). Holes stay in `missingIds`. Tweet text is never invented. Live search has no versioned shape yet → `upstream_blocked`.
5. Leave live flags unset in CI. `scripts/test.sh` sets `THREADAPI_FIXTURE_ONLY=1` and unsets `THREADAPI_LIVE` / `THREADAPI_ADAPTER`.

Roll back: unset `THREADAPI_LIVE` / `THREADAPI_ADAPTER` (or set `THREADAPI_FIXTURE_ONLY=1`) and recreate. Do not run live X from CI.
