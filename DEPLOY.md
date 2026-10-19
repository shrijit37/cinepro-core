# Deployment — cinepro-core (Dokploy compose app)

The rule: **push to `main`**. Actions builds the image, GHCR stores it, the
Dokploy compose app pulls the SHA tag, and two gates refuse to go green unless
that exact SHA is what answers `cinepro-core.shrijit.tech`, anonymous callers
are refused, and a real resolve still returns sources.

```
git push main
  → Actions build-deploy: test (tsc) → buildx linux/amd64+arm64, APP_VERSION=<full sha>
      → ghcr.io/shrijit37/cinepro-core:<full sha> and :latest
  → Dokploy compose.update: pin <sha> in deploy/compose.prod.yml (env untouched)
  → Dokploy compose.saveEnvironment: re-assert deploy/app.env, TMDB key from Doppler
  → Dokploy domain.update: re-assert cinepro-core.shrijit.tech + cinepro-core-auth@file
  → Dokploy compose.deploy: pull + recreate the container
  → gate 1: GET /v1/health (basic auth) until version == <sha>            (600 s)
  → gate 2: anonymous /v1/health, /v1/movies/550, /v1/proxy → 401; then an
            authenticated /v1/movies/550 → ≥1 source
```

Nothing is built on the server. This repo is a mirror of `cinepro-org/core`
(`98ba005`) with the deploy pipeline, a `deploy/` directory and the build-version
hook added; `src/` is otherwise upstream's.

## The deployed app

| what | value |
|---|---|
| Dokploy project / env | `cinepro` (`yqne_XlufpIm6V8dkYNoW`) / `production` (`wOk580n6nVZzNjCv_BTa3`) |
| Dokploy compose app | `cinepro-core`, `composeId mopcs_qIGlzM4iMd-s-M3`, appName `cinepro-rqornd` |
| container | `cinepro-rqornd-cinepro-core-1`, image = the pinned `ghcr.io/shrijit37/cinepro-core:<sha>` |
| compose file | owned by the API; `deploy/compose.prod.yml` in this repo is the source of truth, CI substitutes the image token into it |
| domain | `cinepro-core.shrijit.tech` → service `cinepro-core`, port 3210, Let's Encrypt |
| auth | Traefik middleware `cinepro-core-auth` (`basicAuth`, bcrypt) in the host's `/etc/dokploy/traefik/dynamic/middlewares.yml`, attached to the domain's routers |
| image visibility | GHCR package is public, so the pull needs no credentials and the image carries no secrets |

**Why a compose app and not a Dokploy application.** On this Dokploy build
(v0.30.8) an application created from a git source cannot be made to pull a CI
image: `application.saveDockerProvider` returns `true` while the deploy still
runs a source build, and `application.redeploy` recreates the container from
whatever local tag exists. A compose app's compose file is API-owned and its
deploys are plain image pulls. Same reasoning as `fastmcp-gateway-image`; see
`skill://dokploy-prebuilt-image-deploy`.

## Auth (non-negotiable)

CinePro Core has **no authentication of its own**, and `/v1/proxy` will proxy
for anyone who can reach it. The service must never be reachable anonymously, so
the only route in is through Traefik basic auth:

- middleware `cinepro-core-auth` → `http.middlewares.cinepro-core-auth.basicAuth`
  with `removeHeader: true` and one bcrypt user.
- attached to the domain by `domain.create {..., middlewares: ["cinepro-core-auth@file"]}`,
  which Dokploy writes into the router label
  `traefik.http.routers.<app>-<key>-websecure.middlewares` (compose apps carry
  Docker labels, not a file config). The `@file` suffix is **required**: the
  middleware is defined in the file provider, and Dokploy injects the list
  verbatim, so an unqualified name leaves Traefik unable to resolve the
  middleware — it then drops the router entirely and every request to the host
  answers `404 page not found`. The workflow re-asserts the domain and this
  middleware on every deploy.
- the credential lives in Doppler `platform`/`prd` as `CINEPRO_CORE_BASIC_AUTH`
  (`user:password`). The launcher sends it as `Authorization: Basic <base64>`.
- rotating it means: hash the new password (`bcrypt`, cost 12), rewrite the
  `users` entry in the middleware config, then confirm anonymous `401` and
  authenticated `200`.

A middleware name is host-global, so `cinepro-core-auth` must not be reused by
another app.

## Health

`GET /v1/health` (authenticated) →
`{"name":"CinePro","version":"<build>","status":"operational","endpoints":{...},"spec":"omss","note":"Running with N provider(s). ..."}`.

The route comes from `@omss/framework`'s `OMSSServer`, configured in
`src/server.ts`.

**Deviation from the fleet contract:** the response has no `status/service/version/checks`
shape and no dependency probes — `status` is the framework's literal
`"operational"`, and it stays `operational` even if every provider is down. It is
a liveness signal only. What actually proves the service works is: the `version`
field (which this fork sets from the `APP_VERSION` build arg, so it carries the
running commit's SHA — the previous container answers while the new one starts,
so liveness alone would prove nothing) and gate 2's authenticated resolve. There
is no `checks` object to poll.

## Secrets

App secrets, in Doppler **project `platform`, config `prd`**:

| key | what it is |
|---|---|
| `CINEPRO_TMDB_API_KEY` | TMDB v3 key the resolver needs; empty key = a Core that resolves nothing |
| `CINEPRO_CORE_URL` | `https://cinepro-core.shrijit.tech` — for clients (the TV launcher) |
| `CINEPRO_CORE_BASIC_AUTH` | `cinepro:<password>` — the Traefik basic-auth credential |

How they reach the container: the deploy job reads Doppler with the read-only
config-scoped service token in the repo secret `DOPPLER_TOKEN`
(`doppler secrets download --no-file --format json`), then writes
`deploy/app.env` — with `TMDB_API_KEY=__TMDB_API_KEY__` substituted — through
`compose.saveEnvironment` on every deploy, so the container's `.env` is
rebuilt from Doppler each time and a cleared env block cannot survive a deploy.
The job fails if `CINEPRO_TMDB_API_KEY` or `CINEPRO_CORE_BASIC_AUTH` is empty
(an empty secret is a service that looks alive and does nothing).

**Deviation:** the app env holds literal values written by CI, not
`{{vault.doppler-prod.<KEY>}}` refs. Doppler is still the single source of truth
(CI reads it every deploy); the literal delivery is used because the vault
resolver has a recorded failure mode on this fleet where the deployment dies with
`Unresolved vault reference` before any container exists.

Pipeline secrets (`DOKPLOY_API_KEY`, `DOPPLER_TOKEN`) are **not** app
secrets: they exist in Doppler and in the repo's GitHub secrets only so CI can
write the app env and roll the app.

Runtime env written to the app (from `deploy/app.env`): `PORT=3210`,
`HOST=0.0.0.0`, `NODE_ENV=production`, `PUBLIC_URL=https://cinepro-core.shrijit.tech`,
`CACHE_TYPE=memory`, `CORS_ORIGIN=*`, `STREMIO_ADDON=false`, `MCP_ENABLED=false`,
`INTERNAL_DEBUG=false`, `TMDB_CACHE_TTL=86400`, `TMDB_API_KEY=<from Doppler>`.

`CACHE_TYPE=memory` is deliberate: the compose stack has no Redis, and
`CACHE_TYPE=redis` without a reachable `REDIS_HOST` is a service that boots and
then fails every cache read. `PUBLIC_URL` matters because the resolver rewrites
proxy URLs against it — it must match the public hostname and carry no trailing
slash.

## Repo configuration

| name | kind | value |
|---|---|---|
| `DOKPLOY_URL` | variable | `https://manage.shrijit.tech` |
| `DOKPLOY_COMPOSE_ID` | variable | `mopcs_qIGlzM4iMd-s-M3` |
| `DOKPLOY_DOMAIN_ID` | variable | `g8g2eBQGZ_FRvBf5m9MnH` (`cinepro-core.shrijit.tech`) |
| `DOKPLOY_API_KEY` | secret | Dokploy API key |
| `DOPPLER_TOKEN` | secret | read-only service token, project `platform`, config `prd` |
| `GITHUB_TOKEN` | automatic | builds and pushes to GHCR (`packages: write`) |

`.github/workflows/` holds one workflow, `build-deploy.yml` (push to `main` or
`workflow_dispatch`). Upstream's `ci.yml`, `release.yml` and `mirror.yml` were
removed: this repo's own `test` job replaces `ci.yml`, `build-deploy` publishes
the image `release.yml` used to, and the Codeberg mirror needs a
`CODEBERG_PASSWORD` secret this repo does not have.

## When the gate fails

| symptom | cause |
|---|---|
| gate 1 times out with `version=1.0.0` | the container is running an image built without `--build-arg APP_VERSION` (a hand-built local image), or Dokploy kept the previous container (check the image with `docker.getContainers`) |
| gate 1 never returns 200, `curl` gives 000/TLS error | the Let's Encrypt cert has not issued yet (first deploy), or DNS for the host does not point at the Dokploy host |
| every path answers `404 page not found` (Traefik's own body, not Core's) | the router is unusable: the domain's middleware list has an unqualified name (`cinepro-core-auth` instead of `cinepro-core-auth@file`), so Traefik cannot resolve it. Re-assert the domain (`domain.update`) and `compose.deploy` again — labels are only rendered at deploy time |
| gate 2 sees `200` on an anonymous path | the middleware is not attached: `domain.byComposeId` should list `cinepro-core-auth@file` under `middlewares`, and `/etc/dokploy/traefik/dynamic/middlewares.yml` should define `cinepro-core-auth` |
| gate 2 sees `401` on a *authenticated* path | the credential in Doppler `CINEPRO_CORE_BASIC_AUTH` no longer matches the bcrypt hash in the middleware config |
| gate 2 sees a resolve with 0 sources, or a `500` whose log says `[TMDBService] Error validating movie: TypeError: fetch failed` (`read ECONNRESET`) | TMDB unreachable from the container at that moment (seen once, transient, straight after a container recreate) or the key is empty/rotated; the providers are third-party scrapers and are the flakiest part of the service, which is why gate 2 retries for 180 s |
| `Unresolved vault reference` in Dokploy's deploy log | an env value was replaced with a `{{vault.*}}` ref by hand; this stack resolves no vault refs |
| deploy green but the domain serves the old build | `compose.deploy` must be called, not `application.redeploy`; and the gate must require this run's SHA (a one-shot liveness check passes against the previous container) |
| container running but the domain 404s | the domain's `serviceName` must equal the compose service key (`cinepro-core`) and its port must equal the app's `PORT` (3210) |

Verify a deploy by hand:

```
curl -s -o /dev/null -w '%{http_code}\n' https://cinepro-core.shrijit.tech/v1/health          # 401
curl -s -u "$(doppler secrets get CINEPRO_CORE_BASIC_AUTH -p platform -c prd --plain --silent)" \
  https://cinepro-core.shrijit.tech/v1/health | jq -r '.status, .version'                       # operational, <sha>
curl -s -u "$AUTH" https://cinepro-core.shrijit.tech/v1/movies/550 | jq -r '.sources[] | "\(.quality) \(.provider.name) \(.type)"'
```

## What goes in git and what never does

In git: `Dockerfile`, `deploy/compose.prod.yml` (with the image placeholder),
`deploy/app.env` (with the TMDB placeholder), the workflow, and this file.

Never in git: `.env` (gitignored — the local dev file with a real TMDB key), any
secret value, the basic-auth password or its hash, `TMDB_API_KEY`, Dokploy API
keys, Doppler tokens. The middleware hash is not in this repo either, so a
leaked repo does not leak the credential — but it is still only as strong as the
password in Doppler, so rotate both together.
