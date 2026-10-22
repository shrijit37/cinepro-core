/**
 * `GET /v1/tmdb/<tmdb path>` — metadata passthrough with the server's TMDB key.
 *
 * Why this exists: `/v1/movies/:id` answers *sources*, and nothing else. Everything the launcher
 * draws before it resolves a stream — the trending rails, the hero copy, a season list, a cast
 * strip, a search box — is TMDB metadata, so until this route the panel had to hold its own TMDB v3
 * API key and talk to `api.themoviedb.org` directly. That is a key baked into an APK on a television,
 * a second origin to reach from the LAN, and a rate limit per panel.
 *
 * Here the key is a container secret and the panel needs only the Core credential it already carries
 * for streams. Three properties make it a passthrough rather than an open proxy:
 *
 * 1. **Allowlisted shapes.** Only the paths a launcher needs are forwarded; anything else is a 404
 *    with the same envelope shape the framework uses, so the app cannot tell a typo from a policy.
 * 2. **Allowlisted parameters.** `api_key`, `session_id` and `guest_session_id` never leave this
 *    process: they are credentials. `append_to_response` is rewritten to the two sub-resources the
 *    panel's DTOs actually consume (`release_dates` on a movie, `content_ratings` on a show) and
 *    anything else in it is dropped. That matters because an unfiltered value is an arbitrary
 *    fan-out against the account's rate budget, while these two are exactly the fields the details
 *    screen renders and there is no second round trip on a 1.4 GHz A53 to pay for them.
 * 3. **TTL'd cache.** Trending changes on the hour, a title's details on the day, a search string
 *    whenever — each class gets its own TTL, so a panel that walks its rails costs TMDB almost
 *    nothing and a second panel costs nothing at all.
 *
 * The response is TMDB's body verbatim (the panel's DTOs are already written against it), plus
 * `x-cinepro-cache: hit|miss` so a slow rail can be attributed to TMDB or to this cache without
 * guessing.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { retryTransient } from '../fetchRetry.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';

/** A path segment we are willing to forward: ids, `season/3`, `episode/7`, known sub-resources. */
const SEGMENT = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * The shapes the launcher asks for. Every entry is anchored, so `movie/603/../../account` is not a
 * forwardable path even before the segment check.
 */
const ALLOWED_PATHS: readonly RegExp[] = [
    /^configuration$/,
    /^genre\/(movie|tv)\/list$/,
    /^trending\/(movie|tv|all)\/(day|week)$/,
    /^discover\/(movie|tv)$/,
    // The catalogue lists a Cinema surface can pick from. `movie/popular` is what the launcher
    // already reads for its "Popular" row; the rest are the same family, so an allowlist entry
    // costs nothing and stops the next screen from silently falling back to a per-panel direct key.
    /^(movie|tv)\/(popular|top_rated|now_playing|upcoming|airing_today|on_the_air)$/,
    /^search\/(multi|movie|tv|person|keyword|company|collection)$/,
    /^movie\/\d+(\/(credits|recommendations|similar|videos|release_dates|images|reviews|keywords|external_ids|watch\/providers))?$/,
    /^tv\/\d+(\/(credits|recommendations|similar|videos|content_ratings|images|reviews|keywords|external_ids|watch\/providers|season\/\d+(\/episode\/\d+)?))?$/,
    /^person\/\d+(\/(combined_credits|movie_credits|tv_credits))?$/
];

/**
 * Parameters that are either credentials or a way to multiply one request into many. Everything
 * else is forwarded untouched: the panel is the only client and TMDB ignores what it does not know.
 */
const DROPPED_PARAMS = new Set([
    'api_key',
    'session_id',
    'guest_session_id',
    'callback'
]);

/**
 * The only appends this deployment will carry. TMDB's own endpoint accepts a comma-separated list
 * of sub-resources and turns one small request into several upstream ones; the panel only reads
 * these two (the age certificate on a details screen), so the request is narrowed to them instead
 * of accepting whatever the caller asks for.
 */
const APPENDABLE = new Set(['release_dates', 'content_ratings']);

/** Filters a raw `append_to_response` value to the allowlist, or null when nothing survives. */
function filterAppend(raw: unknown): string | null {
    if (typeof raw !== 'string') {
        return null;
    }
    const names = raw
        .split(',')
        .map((name) => name.trim())
        .filter((name) => APPENDABLE.has(name));
    const unique = [...new Set(names)];
    return unique.length > 0 ? unique.join(',') : null;
}

interface CacheEntry {
    body: string;
    expiresAt: number;
    ttl: number;
}

/** ~2 MB of JSON: a few hundred rails and details, evicted oldest-first. */
const CACHE_MAX_ENTRIES = 600;
const CACHE_MAX_BYTES = 2 * 1024 * 1024;

const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function ttlMsFor(path: string): number {
    if (path.startsWith('configuration') || path.startsWith('genre/')) {
        return 24 * 60 * 60 * 1000;
    }
    if (path.startsWith('search/')) {
        return 5 * 60 * 1000;
    }
    if (path.startsWith('trending/') || path.startsWith('discover/')) {
        return 10 * 60 * 1000;
    }
    return 6 * 60 * 60 * 1000;
}

function cacheGet(key: string): CacheEntry | null {
    const hit = cache.get(key);
    if (!hit) {
        return null;
    }
    if (hit.expiresAt <= Date.now()) {
        cache.delete(key);
        cachedBytes -= hit.body.length;
        return null;
    }
    // Refresh insertion order: Map iteration is oldest-first, which is the eviction order.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
}

function cachePut(key: string, body: string, ttl: number): void {
    const previous = cache.get(key);
    if (previous) {
        cachedBytes -= previous.body.length;
        cache.delete(key);
    }
    if (body.length > CACHE_MAX_BYTES / 8) {
        // A single body that big is a poster list nobody asked for twice; do not let it evict the
        // rails that are drawn on every home render.
        return;
    }
    cache.set(key, { body, expiresAt: Date.now() + ttl, ttl });
    cachedBytes += body.length;
    while (cache.size > CACHE_MAX_ENTRIES || cachedBytes > CACHE_MAX_BYTES) {
        const oldest = cache.keys().next();
        if (oldest.done) {
            break;
        }
        const dropped = cache.get(oldest.value);
        cache.delete(oldest.value);
        if (dropped) {
            cachedBytes -= dropped.body.length;
        }
    }
}

function sendError(
    reply: FastifyReply,
    request: FastifyRequest,
    statusCode: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {}
): FastifyReply {
    return reply.code(statusCode).type('application/json').send({
        error: { code, message, details },
        traceId: request.id
    });
}

/** Splits `a/b/c` into its segments, rejecting anything the allowlist could not possibly match. */
function splitPath(raw: string): string[] | null {
    const cleaned = raw.replace(/^\/+|\/+$/g, '');
    if (!cleaned) {
        return null;
    }
    const segments = cleaned.split('/');
    if (
        segments.some(
            (segment) =>
                !SEGMENT.test(segment) || segment === '.' || segment === '..'
        )
    ) {
        return null;
    }
    return segments;
}

function queryString(query: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (DROPPED_PARAMS.has(key) || value === undefined || value === null) {
            continue;
        }
        const text = Array.isArray(value) ? value.join(',') : String(value);
        if (text.length > 200) {
            continue;
        }
        params.append(key, text);
    }
    return params.toString();
}

export function registerTmdbRoutes(app: FastifyInstance): void {
    app.get('/v1/tmdb/*', async (request, reply) => {
        const apiKey = process.env.TMDB_API_KEY;
        if (!apiKey) {
            return sendError(
                reply,
                request,
                503,
                'TMDB_KEY_MISSING',
                'This deployment has no TMDB_API_KEY, so metadata cannot be served'
            );
        }

        const wildcard = (request.params as { '*': string })['*'] ?? '';
        const segments = splitPath(wildcard);
        if (!segments) {
            return sendError(
                reply,
                request,
                404,
                'TMDB_PATH_NOT_ALLOWED',
                'No such metadata path'
            );
        }
        const path = segments.join('/');
        if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
            return sendError(
                reply,
                request,
                404,
                'TMDB_PATH_NOT_ALLOWED',
                'No such metadata path',
                {
                    path
                }
            );
        }

        // The panel's language/region ride through the query, and TMDB defaults to en-US otherwise.
        const query = { ...(request.query as Record<string, unknown>) };
        if (!query.language) {
            query.language = 'en-US';
        }
        // Rewrite the append list before it reaches the cache key or TMDB: an unfiltered value is
        // unbounded fan-out, and a dropped one would make two different responses share a key.
        const append = filterAppend(query.append_to_response);
        if (append) {
            query.append_to_response = append;
        } else {
            delete query.append_to_response;
        }
        const suffix = queryString(query);
        const key = suffix ? `${path}?${suffix}` : path;
        const ttl = ttlMsFor(path);

        const hit = cacheGet(key);
        if (hit) {
            return reply
                .code(200)
                .type('application/json')
                .headers({
                    'cache-control': `public, max-age=${Math.floor(hit.ttl / 1000)}`,
                    'x-cinepro-cache': 'hit'
                })
                .send(hit.body);
        }

        const url = `${TMDB_BASE}/${path}?api_key=${encodeURIComponent(apiKey)}${suffix ? `&${suffix}` : ''}`;
        const startedAt = Date.now();
        let response: Response;
        try {
            response = await retryTransient(
                () => fetch(url, { headers: { accept: 'application/json' } }),
                true,
                undefined,
                `TMDB ${path}`
            );
        } catch (error) {
            console.warn(
                `[TMDB] ${path} -> upstream unreachable in ${Date.now() - startedAt} ms: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
            return sendError(
                reply,
                request,
                503,
                'TMDB_UNREACHABLE',
                'TMDB could not be reached from the Core host',
                { path }
            );
        }

        const body = await response.text().catch(() => '');
        if (!response.ok) {
            // 401/403 here is always this deployment's key, never the caller's problem — say so
            // rather than echoing TMDB's body, which can name the key state.
            const code =
                response.status === 404
                    ? 'TMDB_NOT_FOUND'
                    : response.status === 401 || response.status === 403
                      ? 'TMDB_UNAUTHORIZED'
                      : 'TMDB_UPSTREAM_ERROR';
            console.warn(`[TMDB] ${path} -> ${response.status} (${code})`);
            return sendError(
                reply,
                request,
                response.status === 404 ? 404 : 502,
                code,
                body.slice(0, 200) || 'TMDB rejected the request',
                {
                    path,
                    status: response.status
                }
            );
        }

        cachePut(key, body, ttl);
        return reply
            .code(200)
            .type('application/json')
            .headers({
                'cache-control': `public, max-age=${Math.floor(ttl / 1000)}`,
                'x-cinepro-cache': 'miss'
            })
            .send(body);
    });
}
