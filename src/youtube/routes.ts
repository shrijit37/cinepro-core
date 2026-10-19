/**
 * `GET /v1/youtube/{videoId}` and `GET /v1/youtube/{videoId}?audio=1`.
 *
 * The bytes are streamed from here, never redirected: handing the googlevideo
 * URL back to the TV would hand back exactly the throttled URL the TV cannot
 * use. Range requests are honoured (the player seeks, and it opens with
 * `Range: bytes=<pos>-`), so every response advertises `Accept-Ranges: bytes`
 * and carries a real `Content-Range`.
 */

import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { retryTransient } from '../fetchRetry.js';
import { cookieFile } from './cookies.js';
import {
    noteDirectRefusal,
    noteDirectSuccess,
    resolveMedia,
    YouTubeError,
    type ResolvedMedia
} from './ytdlp.js';

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;
/** googlevideo answers 403/410 once a signed URL has outlived its signature. */
const EXPIRED_STATUSES = new Set([403, 410]);

interface ByteRange {
    start: number;
    end: number | null;
}

function parseRange(header: string | undefined): ByteRange | null {
    if (!header) {
        return null;
    }
    const match = RANGE_PATTERN.exec(header.trim());
    if (!match) {
        return null;
    }
    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') {
        return null;
    }
    // `bytes=-N` asks for the last N bytes; the player does not use it, and
    // guessing a total for it is worse than serving the whole thing.
    if (rawStart === '') {
        return null;
    }
    const start = Number(rawStart);
    const end = rawEnd === '' ? null : Number(rawEnd);
    if (!Number.isSafeInteger(start) || start < 0) {
        return null;
    }
    if (end !== null && (!Number.isSafeInteger(end) || end < start)) {
        return null;
    }
    return { start, end };
}

/**
 * Cuts a stream down to the requested window and ends it there — the response
 * carries a `Content-Length`, so trailing bytes must not be written.
 */
class RangeSlice extends Transform {
    private position = 0;

    constructor(
        private readonly origin: Readable,
        private readonly rangeStart: number,
        private readonly rangeEnd: number
    ) {
        super();
    }

    override _transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: TransformCallback
    ): void {
        const chunkStart = this.position;
        this.position += chunk.length;
        const from = Math.max(0, this.rangeStart - chunkStart);
        const to = Math.min(chunk.length, this.rangeEnd + 1 - chunkStart);
        if (to > from) {
            this.push(chunk.subarray(from, to));
        }
        if (this.position > this.rangeEnd) {
            this.origin.destroy();
            this.push(null);
        }
        callback();
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

/**
 * One agent per lane: each holds its own CONNECT pool, and a resolve records
 * which lane minted its URL. The byte fetch has to leave through that same
 * lane — measured in production, a music track resolved through
 * `http://lane-egress:8002` (now `cinepro-lane-egress`) and then died on `fetch failed` when the Core host
 * fetched it direct, because googlevideo scopes the URL to the resolving egress.
 */
const proxyAgents = new Map<string, ProxyAgent>();

function dispatcherFor(proxy: string | null): ProxyAgent | undefined {
    if (!proxy) {
        return undefined;
    }
    let agent = proxyAgents.get(proxy);
    if (!agent) {
        agent = new ProxyAgent(proxy);
        proxyAgents.set(proxy, agent);
    }
    return agent;
}

async function fetchUpstream(
    media: ResolvedMedia,
    range: string | undefined,
    signal: AbortSignal
): Promise<Response> {
    const headers: Record<string, string> = {
        ...media.headers,
        // Keep the byte stream identity-encoded so Content-Length stays true.
        'Accept-Encoding': 'identity'
    };
    if (range) {
        headers.Range = range;
    }
    const dispatcher = dispatcherFor(media.proxy);
    if (!dispatcher) {
        return await fetch(media.url, { headers, redirect: 'follow', signal });
    }
    // The proxied path must use undici's own fetch, not the global one: the
    // global fetch is Node's bundled undici, and handing it a dispatcher from
    // the undici package returns the right status and body with *every*
    // response header missing (measured: 206, headers empty) — which would
    // lose Content-Range and Content-Type downstream.
    return await retryTransient(
        async () =>
            (await undiciFetch(media.url, {
                headers,
                redirect: 'follow',
                signal,
                dispatcher
            })) as unknown as Response,
        true,
        undefined,
        'GET media'
    );
}

interface UpstreamFetch {
    response: Response;
    media: ResolvedMedia;
}

/**
 * Fetch the media URL, re-resolving once if the URL has expired. The media
 * fetch can start before headers are written, so a first-byte failure is
 * recoverable — a mid-body failure is not, and the caller closes the
 * connection instead of pretending the response completed.
 */
async function openUpstream(
    videoId: string,
    audio: boolean,
    media: ResolvedMedia,
    range: string | undefined,
    signal: AbortSignal
): Promise<UpstreamFetch> {
    const response = await fetchUpstream(media, range, signal);
    if (media.proxy === null) {
        if (EXPIRED_STATUSES.has(response.status)) {
            noteDirectRefusal();
        } else if (response.status < 400) {
            noteDirectSuccess();
        }
    }
    if (!EXPIRED_STATUSES.has(response.status)) {
        return { response, media };
    }
    await response.body?.cancel().catch(() => undefined);
    // A refused URL is re-resolved on the lanes, never on the signed-in direct
    // path: measured at cold start, a direct URL from this host answered 403
    // while the same id fetched through a lane streamed normally, and a lane URL
    // is attested because the same lane mints and fetches it.
    const refreshed = await resolveMedia(videoId, audio, {
        force: true,
        laned: true
    });
    return {
        response: await fetchUpstream(refreshed, range, signal),
        media: refreshed
    };
}

function totalFrom(response: Response, media: ResolvedMedia): number | null {
    const contentRange = response.headers.get('content-range');
    if (contentRange) {
        const total = Number(contentRange.split('/').at(-1));
        if (Number.isSafeInteger(total) && total > 0) {
            return total;
        }
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isSafeInteger(contentLength) && contentLength > 0) {
        // A 206 with a bounded range only describes that window, never the
        // whole file — only a 200's Content-Length is a total.
        if (response.status === 200) {
            return contentLength;
        }
    }
    return media.size;
}

/** `Content-Range: bytes <start>-<end>/<total>` parsed, null when absent. */
function contentRangeOf(
    response: Response
): { start: number; end: number; total: number } | null {
    const header = response.headers.get('content-range');
    if (!header) {
        return null;
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(header.trim());
    if (!match) {
        return null;
    }
    return {
        start: Number(match[1]),
        end: Number(match[2]),
        total: Number(match[3])
    };
}

function buildHeaders(
    media: ResolvedMedia,
    status: number,
    response: Response
): Record<string, string> {
    const headers: Record<string, string> = {
        'accept-ranges': 'bytes',
        'content-type': media.contentType,
        'cache-control': 'no-store'
    };
    for (const name of ['content-length', 'content-range']) {
        const value = response.headers.get(name);
        if (value) {
            headers[name] = value;
        }
    }
    if (status === 206 && !headers['content-range']) {
        delete headers['content-length'];
    }
    return headers;
}

async function handleYouTube(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<FastifyReply | undefined> {
    const params = request.params as { videoId?: string };
    const videoId = params.videoId ?? '';
    if (!VIDEO_ID_PATTERN.test(videoId)) {
        return sendError(
            reply,
            request,
            400,
            'INVALID_VIDEO_ID',
            'videoId must be an 11-character YouTube video id'
        );
    }

    const query = request.query as { audio?: string };
    const audio = query.audio === '1' || query.audio === 'true';
    const rangeHeader = request.headers.range;
    const range = parseRange(rangeHeader);

    const startedAt = Date.now();
    let media: ResolvedMedia;
    try {
        media = await resolveMedia(videoId, audio);
    } catch (error) {
        if (error instanceof YouTubeError) {
            return sendError(
                reply,
                request,
                error.statusCode,
                error.code,
                error.message
            );
        }
        throw error;
    }

    // The media fetch is aborted if the player goes away, so a seek or a stop
    // does not leave the upstream download running.
    const controller = new AbortController();
    reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) {
            controller.abort();
        }
    });

    let upstream: UpstreamFetch;
    try {
        upstream = await openUpstream(
            videoId,
            audio,
            media,
            // An unranged GET is throttled: googlevideo serves a music track at
            // ~250 kbit/s and closes it short of the length it advertised
            // (measured by this repo's gate: 2.9 MB of 3.4 MB after 93 s),
            // while `Range: bytes=0-` delivers the same file in ~3 s. Ask for
            // the open-ended range either way and answer 200 below.
            rangeHeader ?? 'bytes=0-',
            controller.signal
        );
    } catch (error) {
        console.warn(
            `[YouTube] ${videoId}${
                audio ? '?audio=1' : ''
            } -> 502 fetching media via ${
                media.proxy
                    ? `lane ${media.proxy.replace(/^https?:\/\//, '')}`
                    : 'direct'
            } in ${((Date.now() - startedAt) / 1000).toFixed(1)} s: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
        return sendError(
            reply,
            request,
            502,
            'UPSTREAM_UNREACHABLE',
            `Media host could not be reached: ${
                error instanceof Error ? error.message : 'unknown error'
            }`
        );
    }

    const { response } = upstream;
    const resolved = upstream.media;

    // One line per resolve, naming the path that answered: with cookies first
    // and the lanes behind them, "signed in and fast" and "the cookie died and
    // a lane quietly covered for us" are otherwise identical from outside.
    const via = resolved.proxy
        ? `lane ${resolved.proxy.replace(/^https?:\/\//, '')}`
        : cookieFile()
          ? 'cookies-direct'
          : 'direct';
    console.log(
        `[YouTube] ${videoId}${audio ? '?audio=1' : ''} -> ${response.status} via ${via} in ${(
            (Date.now() - startedAt) /
            1000
        ).toFixed(1)} s`
    );

    if (response.status >= 400) {
        // googlevideo explains itself in the body ("expired", "not available",
        // "sign in"). Keep a short, CRLF-flattened copy: it is the difference
        // between a guess and a diagnosis, and it carries no credential.
        const reason = (await response.text().catch(() => ''))
            .replace(/\s+/g, ' ')
            .slice(0, 200);
        return sendError(
            reply,
            request,
            502,
            'UPSTREAM_REJECTED',
            `Media host answered ${response.status} for ${videoId}${
                reason ? `: ${reason}` : ''
            }`,
            { status: response.status, via }
        );
    }

    const total = totalFrom(response, resolved);

    if (request.method === 'HEAD') {
        await response.body?.cancel().catch(() => undefined);
        const headers: Record<string, string> = {
            'accept-ranges': 'bytes',
            'content-type': resolved.contentType,
            'cache-control': 'no-store'
        };
        let status = 200;
        if (total) {
            const start = range?.start ?? 0;
            const end = Math.min(range?.end ?? total - 1, total - 1);
            headers['content-length'] = String(end - start + 1);
            if (range) {
                status = 206;
                headers['content-range'] = `bytes ${start}-${end}/${total}`;
            } else {
                headers['content-length'] = String(total);
            }
        }
        // Fastify rewrites Content-Length to 0 when a handler sends no payload,
        // which would tell the player the media is empty — so answer the HEAD on
        // the raw socket with the entity headers a GET would have sent.
        reply.hijack();
        reply.raw.writeHead(status, headers);
        reply.raw.end();
        return undefined;
    }

    if (!response.body) {
        return sendError(
            reply,
            request,
            502,
            'UPSTREAM_EMPTY',
            `Media host returned no body for ${videoId}`
        );
    }

    const source = Readable.fromWeb(response.body);
    source.on('error', () => {
        // The upstream died mid-body: kill the connection rather than let the
        // player believe it received a complete response.
        reply.raw.destroy();
    });

    if (!range && response.status === 206) {
        // The client asked for the whole file and the 206 is our own doing:
        // forward the body as a plain 200 with the true length.
        const span = contentRangeOf(response);
        if (span && span.start === 0 && span.end === span.total - 1) {
            return reply
                .code(200)
                .headers({
                    'accept-ranges': 'bytes',
                    'content-type': resolved.contentType,
                    'cache-control': 'no-store',
                    'content-length': String(span.total)
                })
                .send(source);
        }
    }

    if (response.status === 200 && range && total) {
        // Upstream ignored the range: slice locally so the player still gets a
        // real 206 with a truthful Content-Range.
        const start = range.start;
        const end = Math.min(range.end ?? total - 1, total - 1);
        if (start >= total) {
            source.destroy();
            return sendError(
                reply,
                request,
                416,
                'RANGE_NOT_SATISFIABLE',
                `Range start ${start} is past the end of the media`,
                { total }
            );
        }
        return reply
            .code(206)
            .headers({
                'accept-ranges': 'bytes',
                'content-type': resolved.contentType,
                'cache-control': 'no-store',
                'content-range': `bytes ${start}-${end}/${total}`,
                'content-length': String(end - start + 1)
            })
            .send(new RangeSlice(source, start, end));
    }

    return reply
        .code(response.status === 206 ? 206 : 200)
        .headers(buildHeaders(resolved, response.status, response))
        .send(source);
}

export function registerYouTubeRoutes(app: FastifyInstance): void {
    app.get('/v1/youtube/:videoId', handleYouTube);
}
