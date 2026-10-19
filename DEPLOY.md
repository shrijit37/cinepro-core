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
| second service | `bgutil-provider` — upstream `brainicism/bgutil-ytdlp-pot-provider:2.0.2`, mints the YouTube PoTokens `yt-dlp` needs; no published port, reachable only as `http://bgutil-provider:4416` on `dokploy-network` |
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
so liveness alone would prove nothing), gate 2's authenticated resolve, and gate
3's end-to-end fetch of a real media segment. There is no `checks` object to
poll.

## Two upstream behaviours this fork works around

- **VidApi media headers** (`src/providers/vidapi/vidapi.ts`). The CDN serving
  `stream_urls` sits behind Cloudflare and answers `403 Attention Required` for
  any request carrying a `Referer` or `Origin` — including the iframe referer
  the provider itself needs for its API. Stream URLs therefore embed only
  `User-Agent` and `Accept`. Putting the iframe referer back on media keeps the
  playlists looking healthy (master and variant both 200) while every segment
  403s — that is exactly how three "1080p VidApi sources" came to be unplayable.
- **TMDB connection resets** (`src/fetchRetry.ts`). From the Dokploy host the
  TMDB validation fetch intermittently dies mid-response (`read ECONNRESET`,
  errno -104), which the framework surfaced as a 500 before a single provider
  ran. `installFetchRetry()` (called at the top of `src/server.ts`) retries
  idempotent `GET`/`HEAD` fetch failures once after 250 ms; anything else
  propagates unchanged.

## YouTube media (`/v1/youtube/*`)

```
GET /v1/youtube/{videoId}            # muxed MP4, best ≤720p (usually 360p/720p)
GET /v1/youtube/{videoId}?audio=1    # audio only, m4a/AAC preferred
```

Both stream the bytes from Core and honour `Range` (`Accept-Ranges: bytes`,
real `Content-Range`, `206` for a satisfiable range, `416` past the end) and
never redirect — a redirect would hand the throttled googlevideo URL straight
back to the TV. Same Basic credential as everything else; anonymous is 401.
Failures are JSON (`{"error":{"code","message","details"},"traceId"}`) with a
matching status: `400 INVALID_VIDEO_ID`, `502 YTDLP_*` / `UPSTREAM_*`.

**Why the server does this at all.** Unattested clients get throttled URLs:
bounded ranges under ~1 MiB answer `206`, anything past that `403`, and an
open-ended `Range: bytes=0-` always `403`. The PoToken that lifts that gate
cannot be minted in the launcher's Kotlin, so it has to be yt-dlp on the
server. That is also the endpoint's fragility: YouTube breaks the extractor
monthly, so `yt-dlp` is **pinned** in the Dockerfile
(`ARG YTDLP_VERSION=2026.08.19`) and gate 4 streams real bytes before a deploy
is called green. Bump the pin only in a commit that re-runs that gate.

**Client families are per variant, and that is load-bearing.** Forcing one
`player_client` list for both variants is exactly how music videos ended up
answering `502` for a week: a list that satisfies `bestaudio[ext=m4a]` does not
advertise muxed progressive MP4, and yt-dlp then answers `ERROR: Requested
format is not available` instead of merging the two lists. Measured on this
network for `dQw4w9WgXcQ`:

```
default  -> video selector fails     (with and without a PoToken)
ios      -> video selector fails
android  -> format 18, mp4, 360p, video+audio, seekable
```

So video pins `android` (fallbacks `android` → `android_vr`), audio uses
yt-dlp's own `default` rotation (fallbacks `android` → `ios,web`), and
`tv_embedded` / `web_safari` are absent from both — those are the two clients
YouTube bot-checks hardest, and forcing them produced "Sign in to confirm
you're not a bot" for nearly every video. **No cookies are needed or wanted.**

Implementation notes for whoever touches this next:

- `src/youtube/ytdlp.ts` owns resolution: format
  `b[ext=mp4][height<=720]/b[height<=720]/b` for video (muxed, seekable — a
  plain HTTP player cannot mux split tracks, so a video-only "1080p" stream
  would play silently) and `bestaudio[ext=m4a]/bestaudio` for audio.
  `YTDLP_VIDEO_CLIENTS` / `YTDLP_AUDIO_CLIENTS` override the first client set
  without a code change.
- Resolutions are cached for `YOUTUBE_CACHE_TTL` seconds (default 3600) and
  in-flight resolves are shared. A `403`/`410` from the media host re-resolves
  once and retries with the same `Range`; if the body has already started
  flowing and the upstream dies, the connection is destroyed rather than
  closed as a complete 200.
- `HEAD` is answered from the raw socket: Fastify rewrites `Content-Length` to
  `0` for a handler that sends no payload, which would tell the player the
  media is empty.
- The routes are attached in `src/server.ts` through `server.app` — private on
  `OMSSServer`, with no registration hook, so that cast is deliberate.
- PoTokens come from the `bgutil-provider` service in
  `deploy/compose.prod.yml` (upstream image, pinned by tag, no published port);
  Core reaches it at `YTDLP_POT_URL` (default `http://bgutil-provider:4416`).
  If that service is down yt-dlp degrades to cookie-less clients, which this
  host gets bot-checked for — gate 4 catches that, so a dead provider is a red
  deploy, not a silent one.

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
`CACHE_TYPE=memory`, `YTDLP_POT_URL=http://bgutil-provider:4416`, `CORS_ORIGIN=*`,
`STREMIO_ADDON=false`, `MCP_ENABLED=false`, `INTERNAL_DEBUG=false`,
`TMDB_CACHE_TTL=86400`, `TMDB_API_KEY=<from Doppler>`.

`CACHE_TYPE=memory` is deliberate: the compose stack has no Redis, and
`CACHE_TYPE=redis` without a reachable `REDIS_HOST` is a service that boots and
then fails every cache read. `PUBLIC_URL` matters because the resolver rewrites
proxy URLs against it — it must match the public hostname and carry no trailing
slash.

The `/v1/youtube/*` endpoint also reads optional overrides; the defaults are the
tested ones and none of them is set in `deploy/app.env`: `YTDLP_PATH`
(`yt-dlp`), `YTDLP_VIDEO_CLIENTS` (`android`), `YTDLP_AUDIO_CLIENTS`
(`default`), `YOUTUBE_CACHE_TTL` seconds (3600), `YOUTUBE_RESOLVE_TIMEOUT_MS`
(30000). Empty `YTDLP_POT_URL` disables PoTokens (local runs without the
provider service).

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
| gate 3: first segment `403`, body `Attention Required \| Cloudflare` | the media fetch is carrying a `Referer`/`Origin`: the CDN's hotlink rule rejects both. The provider must embed media headers without them (see "Two upstream behaviours") |
| gate 3: first segment returns HTML (first byte not `0x47`) or is tiny | the playlist advertises pages instead of media — provider rot. Gate 3 exists so this never ships as "working" again |
| gate 3: master 200 with no variants, or media playlist with no segments | the provider returned a stub playlist; check the resolve diagnostics for the provider's own error |
| gate 4: `502` for music videos only, message names "Sign in to confirm you're not a bot" | either the client list includes `tv_embedded`/`web_safari` (the hardest bot-checked families) or `bgutil-provider` is not up, so `yt-dlp` has no PoToken. Check the service is running and `YTDLP_POT_URL` points at it |
| gate 4: `502 YTDLP_NO_FORMAT` "Requested format is not available" on video but audio is fine | the video client list lost its muxed client — video must resolve through `android` (or `android_vr`), never through `default`/`ios`/`mweb` alone |
| gate 4: `502 YTDLP_FAILED` / `YTDLP_NO_FORMAT` | yt-dlp's YouTube extractor is broken or every client family is blocked for this video/IP. Bump the `YTDLP_VERSION` pin in the Dockerfile to a release that works, then re-run the deploy |
| gate 4: range request answered 200 with the whole file, or 403 | the endpoint is not honouring `Range` — check it is not redirecting to googlevideo, and that the upstream fetch forwards the client's `Range` header |
| gate 4: audio variant has no `ftyp` at byte 4 | `bestaudio[ext=m4a]` fell through to WebM/Opus; the TV plays that badly — check the extractor still offers the m4a track |
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

Resolving is not playback — walk the playlist chain, because a healthy-looking
master can still advertise pages:

```
BASE=https://cinepro-core.shrijit.tech; AUTH=…
MASTER=$(curl -s -u "$AUTH" $BASE/v1/movies/550 | jq -r '.sources[0].url')
VAR=$(curl -s -u "$AUTH" "$MASTER" | grep -v '^#' | head -1)
SEG=$(curl -s -u "$AUTH" "$BASE$VAR" | grep -v '^#' | head -1)
curl -s -u "$AUTH" "$BASE$SEG" -o /tmp/seg.bin          # want 200 + ~750 KB
head -c 1 /tmp/seg.bin | od -An -tx1                    # want 47 (MPEG-TS sync)
```

segments the player walks: a range request has to come back `206` with real
bytes, and the audio variant has to be an MP4 container.

```
BASE=https://cinepro-core.shrijit.tech; AUTH=…
curl -s -D - -o /dev/null -u "$AUTH" -H 'Range: bytes=0-1048575' \
  "$BASE/v1/youtube/dQw4w9WgXcQ"        # 206, content-range: bytes 0-1048575/<total>
curl -s -o /tmp/au.bin -u "$AUTH" -H 'Range: bytes=0-1023' \
  "$BASE/v1/youtube/dQw4w9WgXcQ?audio=1"                     # 206
dd if=/tmp/au.bin bs=1 skip=4 count=4 2>/dev/null; echo     # ftyp
```

## What goes in git and what never does

In git: `Dockerfile`, `deploy/compose.prod.yml` (with the image placeholder),
`deploy/app.env` (with the TMDB placeholder), the workflow, and this file.

Never in git: `.env` (gitignored — the local dev file with a real TMDB key), any
secret value, the basic-auth password or its hash, `TMDB_API_KEY`, Dokploy API
keys, Doppler tokens. The middleware hash is not in this repo either, so a
leaked repo does not leak the credential — but it is still only as strong as the
password in Doppler, so rotate both together.
