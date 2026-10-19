# Deployment — cinepro-core (Dokploy compose app)

The rule: **push to `main`**. Actions builds the image, GHCR stores it, the
Dokploy compose app pulls the SHA tag, and four gates refuse to go green unless
that exact SHA is what answers `cinepro-core.shrijit.tech`, anonymous callers
are refused, a real resolve still returns sources, those sources serve real
media, and every YouTube variant — including the audio ones — streams bytes.

```
git push main
  → Actions build-deploy: test (tsc) → buildx linux/amd64+arm64, APP_VERSION=<full sha>
      → ghcr.io/shrijit37/cinepro-core:<full sha> and :latest
  → Dokploy compose.update: pin <sha> in deploy/compose.prod.yml (env untouched)
  → Dokploy compose.saveEnvironment: re-assert deploy/app.env, TMDB key and
      LANE_TOKEN from Doppler
  → Dokploy domain.update: re-assert cinepro-core.shrijit.tech + cinepro-core-auth@file
  → Dokploy compose.deploy: pull + recreate the container
  → gate 1: GET /v1/health (basic auth) until version == <sha>            (600 s)
  → gate 2: anonymous /v1/health, /v1/movies/550, /v1/proxy → 401; then an
            authenticated /v1/movies/550 → ≥1 source
  → gate 3: that source's HLS chain serves a real MPEG-TS segment (0x47)
  → gate 4: the lane-egress control plane is reachable from inside Core, and
            ?audio=1 for all four ids (including dQw4w9WgXcQ) answers 206 at
            0-1048575, 0-1023, a mid-file range and bytes=0-0 (Content-Range
            `bytes 0-0/<total>`) with `ftyp` at byte 4, then 200 with the whole
            file for a plain GET; dQw4w9WgXcQ's video variant streams the same
            ranges. This is the gate that says "the egress works"
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
| third service | `lane-egress` — `ghcr.io/shrijit37/meshcode-lane-egress`, digest-pinned; WARP egress lanes on `:8001`–`:8004` that `YTDLP_PROXY` resolves YouTube through
(and that the media byte fetch leaves through), plus a token-protected control plane on `:9100`. No published ports. See "The egress this stack actually uses" |
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

## Upstream behaviours this fork works around

- **VidApi media headers** (`src/providers/vidapi/vidapi.ts`). The CDN serving
  `stream_urls` sits behind Cloudflare and answers `403 Attention Required` for
  any request carrying a `Referer` or `Origin` — including the iframe referer
  the provider itself needs for its API. Stream URLs therefore embed only
  `User-Agent` and `Accept`. Putting the iframe referer back on media keeps the
  playlists looking healthy (master and variant both 200) while every segment
  403s — that is exactly how three "1080p VidApi sources" came to be unplayable.
- **TMDB connection resets** (`src/fetchRetry.ts`, `src/tmdbResilience.ts`).
  From the Dokploy host the TMDB validation fetch intermittently dies
  mid-response (`read ECONNRESET`, errno -104) for *seconds* at a time.
  `installFetchRetry()` (called at the top of `src/server.ts`) retries
  idempotent `GET`/`HEAD` fetch failures on a growing backoff — 5 attempts
  inside ~5.5 s; the first version retried once after 250 ms, which the
  measured flap outlived.
- **500 on a resolve that had not started.** When TMDB's flap outlasts those
  retries, the framework's error handler answered `500 INTERNAL_ERROR` — before
  a single provider ran. Measured on production on 2026-10-19: `GET
  /v1/movies/603` → `500` in 1.0 s (traceId `7236668d-…`), the identical
  request → `200` in 8.7 s; same for `movies/1561726`
  (`9bfb3199-…`) and `tv/213375/seasons/1/episodes/1`. The TV showed "The
  resolver failed" for a title that played a moment later.
  `installTmdbResilience()` (same file list) wraps the five TMDB-backed methods
  the resolve path calls before the providers run and converts a surviving
  transport failure into `503 UPSTREAM_UNAVAILABLE` with
  `details.retryAfterSeconds: 5`. **Client contract decision:** no `202` +
  `responseId` polling. `/v1/refresh/{responseId}` is a *cache invalidation*,
  not a job poll (it answers `{status:"OK"}` synchronously), and the failure is
  a seconds-long flap, not a long job — a retry inside the request plus an
  honest retryable 503 is the whole fix. A launcher should therefore treat
  `503 UPSTREAM_UNAVAILABLE` as "retry in ~5 s" and may stop retrying
  `INTERNAL_ERROR`, which no longer covers this case.
- **Dead sources reaching the player** (`src/sourceLiveness.ts`). A response
  can carry a URL that is already gone: `/v1/movies/603` answered `200` while
  its own diagnostics said `CineSu: Stream URL is not accessible`. The wrapper
  probes each resolved source at its real upstream URL — `HEAD`, then a 1-byte
  ranged `GET` when `HEAD` is refused — and drops the ones that answer 4xx/5xx
  or do not answer at all, with a `PROVIDER_ERROR` diagnostic naming the URL.
  If that leaves nothing, the response is `404 NO_SOURCES_AVAILABLE` instead of
  a success with an empty player. `SOURCE_LIVENESS=0` disables it;
  `INTERNAL_DEBUG=true` also disables it (matching the framework's own
  validation). The wrapper sits on `SourceService.getMovieSources` /
  `getTVSources`, so a dead URL is dropped on every read — including one served
  from the 1-hour response cache. This is a deliberate prototype patch: the
  framework is a pinned dependency with no validation hook, and `SourceService`
  is exported with exactly these two entry points.

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

### When YouTube refuses the host and not the client

The four ids in gate 4 are also the diagnostic. On a host whose egress IP
YouTube has flagged, the answer is not "another client family" — it is the same
message for every family, and it is reproducible:

```
dQw4w9WgXcQ   -> 206 (resolved, then cached for an hour)
kJQP7kiw5Fk   -> 502  clients android_vr     "Sign in to confirm you're not a bot"
zAiIgYOH4Ys   -> 502  clients android        same
09R8_2nJtjg   -> 502  clients web            same
aqz-KE-bpKQ   -> 502  clients android_vr     same   (a Creative Commons video: not content policy)
```

The two levers that do **not** work, both measured on this host:

- **A PoToken.** The `bgutil-provider` service is up and reachable from the
  container (probe it with `/v1/proxy?data={"url":"http://bgutil-provider:4416/ping"}`),
  and yt-dlp's plugin is loaded (the container's `yt-dlp -v` prints
  `PO Token Providers: bgutil:http-2.0.2`). But the plugin only serves the
  webpo clients (`web`, `mweb`, `tv`, `web_embedded` …), never the `android`
  family, and on this host the webpo clients are also the ones YouTube answers
  with the SABR experiment (`Some web client https formats have been skipped as
  they are missing a URL`) — so there is no client that is both attested and
  downloadable.
- **A wider client list.** `android`, `android_vr`, `ios`, `web`, `mweb`, `tv`,
  `tv_simply`, `web_embedded` and `web_creator` were each tried on this host:
  all of them answer the bot check once the IP is flagged.

What works is a different egress. `YTDLP_PROXY` (any `http://`, `socks5://`,
`socks5h://` URL) is passed straight to yt-dlp, and the same request through a
residential connection resolves `android` → format 18 (muxed 360p MP4) and
`default` → format 140 (m4a) with no cookies. `YTDLP_VERBOSE=1` adds `-v`, and
every failed attempt logs yt-dlp's full stderr to the container log (the HTTP
error keeps the short tail — a launcher reads that one).

### The egress this stack actually uses: `lane-egress` (WARP)

`deploy/compose.prod.yml` runs a third service, `lane-egress`, and
`YTDLP_PROXY` points at it:

```
lane-egress   ghcr.io/shrijit37/meshcode-lane-egress@sha256:37c6dbd7…   (digest-pinned)
  LANE_MODE=warp, LANES=8001,8002,8003,8004, WARP_POOL_SIZE=8,
  PROBE_SURFACES=chat
  one HTTP CONNECT proxy per lane on :8001–:8004, control plane on :9100
  no published ports; reachable only on dokploy-network, as `lane-egress`

cinepro-core  YTDLP_PROXY=http://lane-egress:8001;http://lane-egress:8002;http://lane-egress:8003;http://lane-egress:8004
              (the `;` list yt-dlp rotates per client-per-egress)
```

Four lanes rather than two because YouTube's bot check is **per egress
address, not per client family**: measured with two lanes, `zAiIgYOH4Ys`
`?audio=1` resolved through `:8002` at 19:35Z after `:8001` refused it for every
client, while `kJQP7kiw5Fk` and `BmRX2g6-iQI` were refused by both. Extra
accounts are the only lever that costs nothing but memory, so the sidecar runs
four (pool of eight, `max(pool, lanes*2)` at boot).

Each lane is one Cloudflare WARP WireGuard exit (AS13335, `hosting: false`),
dialed by xray userspace — no `cap_add`, no `/dev/net/tun`, no `ip_forward`.
That is the whole point: this host's own egress is `130.210.29.215` (OCI
ap-mumbai-1, AS31898, `hosting: true`) and YouTube bot-checks it for every
client family, while the same clients resolve the same ids through WARP. The
container image is the ccMesh lane sidecar, pinned by digest because a tag
would let an upstream rebuild swap the sidecar under a Core-only deploy; both
the digest used here and the ccMesh stack's digest were confirmed to exist in
GHCR by an anonymous `manifests/` fetch before pinning. Rebuild it deliberately
(`gh workflow run lane-egress-image.yml` in `shrijit37/meshcode`) and update
this digest.

**Those lane probes are NOT YouTube health.** `lane-ctl`'s boot and rotation
probes are opencode *zen* surfaces (`PROBE_SURFACES`, `ZEN_PROBE_TIMEOUT` —
zen's free models: `big-pickle` on `/inference/v1/chat/completions`). A lane can
therefore read `degraded`/`quarantined`/`unavailable` while serving YouTube
perfectly, and a lane that passes its zen probe can still be refused by
YouTube. Never read `lane-ctl status` (or the container's health) as "YouTube
works". The authoritative test is a real resolve through the lane — gate 4 is
that test, in CI, against production.

`LANE_TOKEN` is the bearer token for that control plane (`status`, `rotate`,
`run_cmd` — `run_cmd` is root execution inside the sidecar). The compose file
interpolates it from the app env, and CI substitutes the value from Doppler
`platform/prd` `CINEPRO_LANE_TOKEN` (a random 48-hex value) exactly the way it
substitutes the TMDB key, so no value is stored in git — this repo is public.
It is a control-plane credential for this stack only: the sidecar publishes no
ports, and nothing outside `dokploy-network` can reach `:9100`. Rotating it
means updating the Doppler value and redeploying (both services read it from the
same app env).

Measured behaviour of this axis, for the next person:

- Egress reputation is the axis, and it is split finer than "WARP or not": on a
  workstation a `wgcf`+`wireproxy` WARP exit (IPv4 `104.28.192.188`) resolved
  `zAiIgYOH4Ys`, `kJQP7kiw5Fk` and `BmRX2g6-iQI` with no bot check, but the
  *Dokploy host's* lanes egress IPv6 (`2a09:bac5:…::243:*`, the sidecar pins
  `UseIPv6` because v4 is a shared world pool). Through those lanes on
  2026-10-19: `zAiIgYOH4Ys ?audio=1` resolved via client `default` through
  `:8002`, while `kJQP7kiw5Fk` and `BmRX2g6-iQI` were bot-checked on all five
  audio client families on both lanes. Hence four lanes: the check follows the
  address.
- The media byte fetch must leave through **the lane that minted the URL**.
  `ResolvedMedia.proxy` records it and `src/youtube/routes.ts` sends the GET
  through a `ProxyAgent` for that lane. Measured before that was wired: the
  `:8002`-resolved `zAiIgYOH4Ys` URL then died `fetch failed` from Core's own
  egress — googlevideo scopes such URLs to the resolving egress. That proxied
  path uses undici's own `fetch`, not the global one: the global fetch is
  Node's bundled undici and, handed a dispatcher from the `undici` package,
  returns the right status and body with **every response header missing**
  (206, headers empty), which loses `Content-Range` and `Content-Type`.
- From the same host through its own egress, all four ids answer `502` with
  `"Sign in to confirm you're not a bot"` on every client family
  (`android`, `android_vr`, `ios`, `web`, `mweb`, `tv`, `web_embedded`,
  `default`). The failing axis is egress reputation, not the client list and
  not the PoToken provider — bgutil is up and reachable and makes no difference.
- A lane that dies leaves `Errno 111`/`Unable to connect to proxy` in yt-dlp's
  stderr; `src/youtube/ytdlp.ts` answers `503 YTDLP_PROXY_UNREACHABLE` when
  *every* configured egress is dead, versus `502` when YouTube refuses a live
  one, so the two failures are distinguishable from the status code alone.
- Gate 4 asserts the audio variant (`?audio=1`) for the music ids — that is the
  shape the TV's music screen plays — and both the video variant and the audio
  variant for `dQw4w9WgXcQ`. The music ids' *video* variant is not a product
  path and is bot-checked independently, so it is not gated.

## Secrets

App secrets, in Doppler **project `platform`, config `prd`**:

| key | what it is |
|---|---|
| `CINEPRO_TMDB_API_KEY` | TMDB v3 key the resolver needs; empty key = a Core that resolves nothing |
| `CINEPRO_CORE_URL` | `https://cinepro-core.shrijit.tech` — for clients (the TV launcher) |
| `CINEPRO_CORE_BASIC_AUTH` | `cinepro:<password>` — the Traefik basic-auth credential |
| `CINEPRO_LANE_TOKEN` | bearer token for the `lane-egress` sidecar's control plane (`:9100`, `status`/`rotate`/`run_cmd`). A control-plane token inside this stack, not a credential for anything outside it — but `run_cmd` is root execution in that container, so it is delivered like a secret rather than committed |

How they reach the container: the deploy job reads Doppler with the read-only
config-scoped service token in the repo secret `DOPPLER_TOKEN`
(`doppler secrets download --no-file --format json`), then writes
`deploy/app.env` — with `TMDB_API_KEY=__TMDB_API_KEY__` and
`LANE_TOKEN=__LANE_TOKEN__` substituted — through
`compose.saveEnvironment` on every deploy, so the container's `.env` is
rebuilt from Doppler each time and a cleared env block cannot survive a deploy.
That `.env` is also the compose env, so `lane-egress`'s
`LANE_TOKEN: ${LANE_TOKEN:?…}` interpolation resolves from it too.
The job fails if `CINEPRO_TMDB_API_KEY`, `CINEPRO_CORE_BASIC_AUTH` or
`CINEPRO_LANE_TOKEN` is empty (an empty secret is a service that looks alive and
does nothing — or, for the lane token, a sidecar that refuses to boot).

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
`CACHE_TYPE=memory`, `YTDLP_POT_URL=http://bgutil-provider:4416`,
`LANE_TOKEN=<from Doppler>`, `CORS_ORIGIN=*`,
`STREMIO_ADDON=false`, `MCP_ENABLED=false`, `INTERNAL_DEBUG=false`,
`TMDB_CACHE_TTL=86400`, `TMDB_API_KEY=<from Doppler>`.

`CACHE_TYPE=memory` is deliberate: the compose stack has no Redis, and
`CACHE_TYPE=redis` without a reachable `REDIS_HOST` is a service that boots and
then fails every cache read. `PUBLIC_URL` matters because the resolver rewrites
proxy URLs against it — it must match the public hostname and carry no trailing
slash.

The `/v1/youtube/*` endpoint also reads optional overrides. Set in
`deploy/app.env`: `YTDLP_PROXY` (`http://lane-egress:8001;http://lane-egress:8002`
— the WARP lanes above; an empty value means yt-dlp dials from this host's own
bot-checked egress, which is the broken state this replaced). Not set, so the
tested defaults apply: `YTDLP_PATH` (`yt-dlp`), `YTDLP_VIDEO_CLIENTS`
(`android;web_embedded;mweb;android_vr`), `YTDLP_AUDIO_CLIENTS`
(`default;web_embedded;mweb;android;ios+web`), `YTDLP_VERBOSE` (`0`),
`YOUTUBE_CACHE_TTL` seconds (3600), `YOUTUBE_RESOLVE_TIMEOUT_MS` (30000).
`SOURCE_LIVENESS=0` disables the dead-source probe described above. Empty
`YTDLP_POT_URL` disables PoTokens (local runs without the provider service); a
candidate list is `;`-separated, candidates are tried in order, and `+` stands
for a `,` inside a candidate (`ios+web`).

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
| gate 2 sees a resolve with 0 sources, or a `500` whose log says `[TMDBService] Error validating movie: TypeError: fetch failed` (`read ECONNRESET`) | TMDB unreachable from the container at that moment (transient, and worse straight after a container recreate) or the key is empty/rotated; the providers are third-party scrapers and are the flakiest part of the service, which is why gate 2 retries for 420 s. A `500` here now means the TMDB guard did not install (`[TmdbResilience] no TMDB methods were guarded` in the log): a surviving flap is a `503 UPSTREAM_UNAVAILABLE` |
| any resolve answers `503 UPSTREAM_UNAVAILABLE` (`details.retryAfterSeconds: 5`) | TMDB was unreachable for longer than the fetch retries' ~5.5 s budget. This is the honest, retryable answer — the client should retry, not treat it as a Core bug (`src/tmdbResilience.ts`) |
| a resolve is `404 NO_SOURCES_AVAILABLE` whose diagnostics mention `Dead source dropped` | every source the providers returned failed the liveness probe. Read the dropped URLs in the diagnostic; if a provider's URLs are consistently dead, that provider is broken. `SOURCE_LIVENESS=0` disables the probe if it turns out to be too strict |
| a resolve's diagnostics mention `Dead source dropped` but a good source remains | working as intended: the dead URL was dropped before it reached the player (`src/sourceLiveness.ts`) |
| gate 4: `502` with the bot check for **every** id and every client family, including one that resolved minutes earlier on the same deploy | the egress IP is bot-checked, which is a property of the IP and not of this code. Confirm with `curl -s -u "$AUTH" "$APP_URL/v1/proxy?data=%7B%22url%22%3A%22https%3A%2F%2Fwww.youtube.com%2Frobots.txt%22%7D"` (the container reaches YouTube fine — it is the InnerTube *player* request that is refused). The fix is an egress change, **not** another client list; this stack's answer is the `lane-egress` WARP sidecar behind `YTDLP_PROXY` |
| gate 3: first segment `403`, body `Attention Required \| Cloudflare` | the media fetch is carrying a `Referer`/`Origin`: the CDN's hotlink rule rejects both. The provider must embed media headers without them (see "Upstream behaviours this fork works around") |
| gate 3: first segment returns HTML (first byte not `0x47`) or is tiny | the playlist advertises pages instead of media — provider rot. Gate 3 exists so this never ships as "working" again |
| gate 3: master 200 with no variants, or media playlist with no segments | the provider returned a stub playlist; check the resolve diagnostics for the provider's own error |
| yt-dlp stderr says `Signature solving failed … / n challenge solving failed … Ensure you have a supported JavaScript runtime and challenge solver script distribution installed` | the image lost `yt-dlp-ejs` (the `yt-dlp[default]` extra in the Dockerfile) or the `--js-runtimes node` flag (`YTDLP_JS_RUNTIMES`). Without them yt-dlp cannot solve YouTube's `n` challenge, the player response loses formats, and the failure surfaces as the bot check. Check `docker logs` for `JS runtimes: node-…` at `YTDLP_VERBOSE=1` |
| gate 4: `502` for music videos only, message names "Sign in to confirm you're not a bot" | the egress is bot-checked. Check the lane sidecar first (`deploy/compose.prod.yml`, section "The egress this stack actually uses"): the gate's first line prints the lane control plane's state through `/v1/proxy`, and a 502 on **every** id and every client family despite a healthy sidecar means every WARP lane is flagged on that day. `bgutil-provider` being down is *not* this failure — it was measured not to change it. The next lever after that is signed-in cookies, which the owner supplies; do not add them unilaterally |
| gate 4: audio answers `502 UPSTREAM_UNREACHABLE` "fetch failed" although the log shows `[YouTube] resolved <id> (audio) … through egress <lane>` | the URL was minted by a lane and fetched from somewhere else — googlevideo scopes those URLs to the resolving egress. `ResolvedMedia.proxy` records the lane and `fetchUpstream` sends the GET through that lane's `ProxyAgent`; if this recurs, confirm both are still wired and that the media path still uses undici's own `fetch` (see the note on the global fetch dropping headers under a dispatcher) |
| gate 4: the lane control plane line prints a non-200 | `lane-egress` is not up or not reachable from Core: check that service's log in Dokploy (`LANE_TOKEN must be set` means the app env lost the token; a first boot takes ~4 min for WARP pool registration). A lane reading `degraded`/`quarantined` there is still perfectly usable — those probes are zen, not YouTube |
| gate 4: `503 YTDLP_PROXY_UNREACHABLE` | every `YTDLP_PROXY` entry refused the connection: the sidecar's lane ports are not listening (boot still running, or xray failed to start — see its container log). Distinct from a 502, which means the lane answered and YouTube refused |
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

The music ids are the ones that break, so check them too — and read the lane
state first, because a 502 there is an egress answer, not a resolver bug:

```
for id in zAiIgYOH4Ys kJQP7kiw5Fk BmRX2g6-iQI; do                      # music
  printf '%s video=%s audio=%s brand=%s\n' "$id" \
    "$(curl -s -o /tmp/v.bin -w '%{http_code}' -u "$AUTH" -H 'Range: bytes=0-1023' "$BASE/v1/youtube/$id")" \
    "$(curl -s -o /tmp/a.bin -w '%{http_code}' -u "$AUTH" -H 'Range: bytes=0-1023' "$BASE/v1/youtube/$id?audio=1")" \
    "$(dd if=/tmp/a.bin bs=1 skip=4 count=4 2>/dev/null)"
done
# lane state (zen probes — not YouTube health, but it proves the sidecar is up):
DATA=$(jq -rn --arg u 'http://lane-egress:9100/v1/status?port=all' \
  --arg t "Bearer $(doppler secrets get CINEPRO_LANE_TOKEN -p platform -c prd --plain --silent)" \
  '{url:$u,headers:{Authorization:$t}}|@uri')
curl -s -u "$AUTH" "$BASE/v1/proxy?data=$DATA" | jq -r '.lanes[] | "\(.port) \(.state) \(.curr_ip)"'
```

## What goes in git and what never does

In git: `Dockerfile`, `deploy/compose.prod.yml` (with the image placeholder),
`deploy/app.env` (with the TMDB and lane-token placeholders), the workflow, and
this file.

Never in git: `.env` (gitignored — the local dev file with a real TMDB key), any
secret value, the basic-auth password or its hash, `TMDB_API_KEY`, Dokploy API
keys, Doppler tokens, and `CINEPRO_LANE_TOKEN` — that last one is only a
control-plane token for a container that publishes no port, but it authenticates
`run_cmd` (root execution inside the sidecar), and this repo is public. The
middleware hash is not in this repo either, so a
leaked repo does not leak the credential — but it is still only as strong as the
password in Doppler, so rotate both together.
