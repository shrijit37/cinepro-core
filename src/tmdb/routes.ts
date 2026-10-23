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
 *    process: they are credentials. `append_to_response` is rewritten to a fixed set of
 *    sub-resources the panel draws (credits, videos, recommendations, certificates, external ids,
 *    …) and anything else is dropped, capped at eight names. Unfiltered, it is arbitrary fan-out
 *    against the account's rate budget; filtered, one details read carries the cast, trailer and
 *    recommendations too, so the panel does not spend four round trips on a 1.4 GHz A53.
 * 3. **TTL'd cache with stale-while-revalidate.** Trending changes on the hour, a title's details on
 *    the day, a search string whenever — each class gets its own TTL. An entry that has aged out is
 *    still served (marked `x-cinepro-cache: stale`) while one background refresh runs, because a
 *    six-hour-old title is not worth a second of skeleton.
 * 4. **A warmer.** `GET|POST /v1/tmdb/_warm?paths=…` fills that cache from the allowlist before the
 *    panel asks, which is how a screen paints without waiting for TMDB at all.
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
    /^trending\/(movie|tv|all|person)\/(day|week)$/,
    /^discover\/(movie|tv)$/,
    // The catalogue lists a Cinema surface can pick from. `movie/popular` is what the launcher
    // already reads for its "Popular" row; the rest are the same family, so an allowlist entry
    // costs nothing and stops the next screen from silently falling back to a per-panel direct key.
    /^(movie|tv)\/(popular|top_rated|now_playing|upcoming|airing_today|on_the_air|latest)$/,
    /^search\/(multi|movie|tv|person|keyword|company|collection)$/,
    /^(movie|tv)\/\d+(\/(credits|aggregate_credits|recommendations|similar|videos|release_dates|content_ratings|images|reviews|keywords|external_ids|alternative_titles|translations|watch\/providers))?$/,
    // A season's own cast is not the show's: anime in particular lists its voice cast per season,
    // and `/tv/{id}/credits` answered 0 people for two of the four shows measured on 2026-10-23.
    /^tv\/\d+\/season\/\d+(\/(credits|aggregate_credits|videos|images))?$/,
    /^tv\/\d+\/season\/\d+\/episode\/\d+(\/(credits|images|videos|external_ids))?$/,
    /^collection\/\d+(\/(images|translations))?$/,
    /^find\/[A-Za-z0-9]+$/,
    /^keyword\/\d+(\/movies)?$/,
    /^company\/\d+(\/(movies|images))?$/,
    /^network\/\d+(\/(alternative_names|images))?$/,
    /^person\/\d+(\/(combined_credits|movie_credits|tv_credits|images|tagged_images|translations))?$/
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
const APPENDABLE = new Set([
    'release_dates',
    'content_ratings',
    'credits',
    'aggregate_credits',
    'videos',
    'recommendations',
    'similar',
    'external_ids',
    'images',
    'alternative_titles',
    'translations',
    'keywords',
    'watch/providers'
]);

/**
 * How many sub-resources one request may fan out to. TMDB accepts the whole list in one call, but
 * the details screen reads four of them and an unbounded list is a way to make one panel request
 * cost twenty upstream ones.
 */
const APPEND_LIMIT = 8;

/** Filters a raw `append_to_response` value to the allowlist, or null when nothing survives. */
function filterAppend(raw: unknown): string | null {
    if (typeof raw !== 'string') {
        return null;
    }
    const names = raw
        .split(',')
        .map((name) => name.trim())
        .filter((name) => APPENDABLE.has(name));
    const unique = [...new Set(names)].slice(0, APPEND_LIMIT);
    return unique.length > 0 ? unique.join(',') : null;
}

interface CacheEntry {
    body: string;
    expiresAt: number;
    ttl: number;
    /** True when served past its TTL and a refresh is due. */
    stale?: boolean;
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

/**
 * How long an expired entry may still be served *while* it is being refreshed. The panel opens a
 * detail screen and expects it painted; making it wait for TMDB because the entry aged out turns a
 * six-hour-old title into a one-second stare at a skeleton, for no fresher data in return.
 */
const STALE_GRACE_MS = 60 * 60 * 1000;

/** Keys with a background refresh in flight, so a burst of readers starts one upstream call. */
const refreshing = new Set<string>();

function cacheGet(key: string): CacheEntry | null {
    const hit = cache.get(key);
    if (!hit) {
        return null;
    }
    if (hit.expiresAt <= Date.now()) {
        if (Date.now() - hit.expiresAt < STALE_GRACE_MS) {
            // Serve it, marked stale; the caller schedules the refresh.
            return { ...hit, stale: true } as CacheEntry;
        }
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

interface UpstreamResult {
    status: number;
    body: string;
}

/** One TMDB read, unwrapped: callers decide how to answer and whether to cache it. */
async function fetchUpstream(
    apiKey: string,
    path: string,
    suffix: string
): Promise<UpstreamResult> {
    const url = `${TMDB_BASE}/${path}?api_key=${encodeURIComponent(apiKey)}${suffix ? `&${suffix}` : ''}`;
    const response = await retryTransient(
        () => fetch(url, { headers: { accept: 'application/json' } }),
        true,
        undefined,
        `TMDB ${path}`
    );
    const body = await response.text().catch(() => '');
    return { status: response.status, body };
}

/** Fetch and cache. Readers call it on a miss, the warmer calls it ahead of one. */
async function loadAndCache(
    apiKey: string,
    path: string,
    suffix: string,
    ttl: number,
    key: string
): Promise<UpstreamResult> {
    const result = await fetchUpstream(apiKey, path, suffix);
    if (result.status >= 200 && result.status < 300) {
        cachePut(key, result.body, ttl);
    }
    return result;
}

/**
 * Revalidate an entry that has aged out while the reader is answered from the stale copy. One call
 * per key: a rail of twenty cards that all read the same detail starts one refresh, not twenty.
 */
function refreshInBackground(
    apiKey: string,
    path: string,
    suffix: string,
    ttl: number,
    key: string
): void {
    if (refreshing.has(key)) {
        return;
    }
    refreshing.add(key);
    void loadAndCache(apiKey, path, suffix, ttl, key)
        .catch(() => undefined)
        .finally(() => refreshing.delete(key));
}

/** Parses `append_to_response`, language default and query into the cache key's suffix. */
function normaliseQuery(raw: Record<string, unknown>): string {
    const query: Record<string, unknown> = { ...raw };
    if (!query.language) {
        query.language = 'en-US';
    }
    const append = filterAppend(query.append_to_response);
    if (append) {
        query.append_to_response = append;
    } else {
        delete query.append_to_response;
    }
    return queryString(query);
}

/** Validates a path against the allowlist and returns its cache key, or null. */
function warmKeyFor(
    rawPath: string
): { path: string; suffix: string; ttl: number; key: string } | null {
    const parsed = new URL(rawPath, 'http://warm.invalid');
    const segments = splitPath(parsed.pathname);
    if (!segments) {
        return null;
    }
    const path = segments.join('/');
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
        return null;
    }
    const suffix = normaliseQuery(
        Object.fromEntries(parsed.searchParams.entries())
    );
    return {
        path,
        suffix,
        ttl: ttlMsFor(path),
        key: suffix ? `${path}?${suffix}` : path
    };
}

export function registerTmdbRoutes(app: FastifyInstance): void {
    /**
     * `GET|POST /v1/tmdb/_warm` — fill the cache ahead of the reader.
     *
     * The launcher knows what it is about to draw (rails at boot, a title's detail when a card
     * gains focus) one or two seconds before it needs it. Warming turns that head start into a
     * cache hit, which is the whole difference between a skeleton and a painted screen. It answers
     * 202 immediately; the reads happen off the request path, and a path outside the allowlist is
     * simply not accepted.
     */
    const warm = async (
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<FastifyReply> => {
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
        const source =
            request.method === 'POST'
                ? (request.body as { paths?: unknown })?.paths
                : (request.query as { paths?: unknown })?.paths;
        const list = Array.isArray(source)
            ? source.map(String)
            : typeof source === 'string'
              ? source.split(',')
              : [];
        const accepted: string[] = [];
        for (const item of list.slice(0, 64)) {
            const target = warmKeyFor(item.trim());
            if (!target) {
                continue;
            }
            accepted.push(target.key);
            if (!cacheGet(target.key)) {
                refreshInBackground(
                    apiKey,
                    target.path,
                    target.suffix,
                    target.ttl,
                    target.key
                );
            }
        }
        return reply.code(202).send({ accepted, count: accepted.length });
    };
    app.get('/v1/tmdb/_warm', warm);
    app.post('/v1/tmdb/_warm', warm);

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
        // The append list is rewritten before it reaches the cache key or TMDB: an unfiltered value
        // is unbounded fan-out, and a dropped one would make two different responses share a key.
        const suffix = normaliseQuery(request.query as Record<string, unknown>);
        const key = suffix ? `${path}?${suffix}` : path;
        const ttl = ttlMsFor(path);

        const hit = cacheGet(key);
        if (hit) {
            if (hit.stale) {
                refreshInBackground(apiKey, path, suffix, ttl, key);
            }
            return reply
                .code(200)
                .type('application/json')
                .headers({
                    'cache-control': `public, max-age=${Math.floor(hit.ttl / 1000)}`,
                    'x-cinepro-cache': hit.stale ? 'stale' : 'hit'
                })
                .send(hit.body);
        }

        const startedAt = Date.now();
        let result: UpstreamResult;
        try {
            result = await fetchUpstream(apiKey, path, suffix);
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

        const body = result.body;
        if (result.status < 200 || result.status >= 300) {
            // 401/403 here is always this deployment's key, never the caller's problem — say so
            // rather than echoing TMDB's body, which can name the key state.
            const code =
                result.status === 404
                    ? 'TMDB_NOT_FOUND'
                    : result.status === 401 || result.status === 403
                      ? 'TMDB_UNAUTHORIZED'
                      : 'TMDB_UPSTREAM_ERROR';
            console.warn(`[TMDB] ${path} -> ${result.status} (${code})`);
            return sendError(
                reply,
                request,
                result.status === 404 ? 404 : 502,
                code,
                body.slice(0, 200) || 'TMDB rejected the request',
                {
                    path,
                    status: result.status
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
