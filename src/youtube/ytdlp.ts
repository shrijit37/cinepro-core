/**
 * yt-dlp based resolution for the YouTube endpoints.
 *
 * The TV cannot fetch googlevideo itself: unattested InnerTube clients get
 * throttled (bounded ranges under ~1 MiB, 403 past that, 403 on an open-ended
 * range), and the PoToken that lifts the throttle cannot be minted in Kotlin.
 * yt-dlp on this server hands back URLs that serve the whole file, so the bytes
 * come from here.
 *
 * Format choice: only the `android` client still advertises muxed progressive
 * MP4 (format 18 = 360p, 22 = 720p) — a single, seekable, video+audio stream.
 * The default client set (visionos) only offers split video-only / audio-only
 * tracks, which a plain HTTP player cannot mux, so `android` is pinned in.
 * Audio-only requests prefer the m4a/AAC track (`bestaudio[ext=m4a]`) because
 * WebM/Opus is second class on the TV's player.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const YTDLP_BIN = process.env.YTDLP_PATH ?? 'yt-dlp';
/**
 * Client families, best first. `android` is the only one that still advertises
 * **muxed** progressive MP4 (format 18/22), which is what a plain HTTP player
 * can play; `ios`/`android_vr`/`mweb` are the families that pass YouTube's
 * player request without cookies from a datacenter IP. `tv_embedded` and
 * `web_safari` are deliberately *not* here — they are the two clients YouTube
 * bot-checks hardest ("Sign in to confirm you're not a bot", which is what made
 * /v1/youtube/* answer 502 for every music video).
 */
const PLAYER_CLIENTS =
    process.env.YTDLP_PLAYER_CLIENT ?? 'android,ios,android_vr,mweb';
/**
 * Tried in order when the preferred set yields no usable format: a resolve that
 * fails on one family today may pass on another, and the endpoint must not
 * answer 502 because a single client family went dark.
 */
const CLIENT_FALLBACKS = [PLAYER_CLIENTS, 'android', 'ios,mweb', 'default'];
/**
 * The `bgutil` PoToken provider (a second compose service, see
 * deploy/compose.prod.yml). From a datacenter IP YouTube answers the player
 * request with "Sign in to confirm you're not a bot" and hands out throttled
 * URLs; a PoToken minted by that service is what lifts both. Empty value
 * disables it (local runs without the provider).
 */
const POT_PROVIDER_URL =
    process.env.YTDLP_POT_URL ?? 'http://bgutil-provider:4416';
const VIDEO_FORMAT = 'b[ext=mp4][height<=720]/b[height<=720]/b';
const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio';

/** yt-dlp can be slow on a cold cache; the resolve itself rarely takes >10 s. */
const RESOLVE_TIMEOUT_MS = Number(
    process.env.YOUTUBE_RESOLVE_TIMEOUT_MS ?? 30000
);
/** Resolved URLs stay valid for hours; the player only needs minutes. */
const CACHE_TTL_MS = Number(process.env.YOUTUBE_CACHE_TTL ?? 3600) * 1000;
/** yt-dlp -J on a long video is a few hundred KB of JSON. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface ResolvedMedia {
    url: string;
    /** Headers yt-dlp wants sent with the media request (User-Agent, Accept, …). */
    headers: Record<string, string>;
    contentType: string;
    size: number | null;
}

interface YtDlpFormat {
    url: string;
    ext?: string;
    filesize?: number;
    filesize_approx?: number;
    http_headers?: Record<string, string>;
}

export class YouTubeError extends Error {
    readonly code: string;
    readonly statusCode: number;

    constructor(code: string, message: string, statusCode: number) {
        super(message);
        this.name = 'YouTubeError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function isYtDlpFormat(value: unknown): value is YtDlpFormat {
    return (
        typeof value === 'object' &&
        value !== null &&
        'url' in value &&
        typeof value.url === 'string' &&
        value.url.length > 0
    );
}

/**
 * yt-dlp reports the chosen format in `requested_downloads` when it had to
 * select (and would have had to merge) anything, in `requested_formats` for
 * merged selections, and in `format` (object) for a plain single format.
 */
function pickFormat(payload: unknown): YtDlpFormat | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const candidates: unknown[] = [];
    if ('requested_downloads' in payload) {
        const downloads = payload.requested_downloads;
        if (Array.isArray(downloads)) {
            candidates.push(...downloads);
        }
    }
    if ('requested_formats' in payload) {
        const formats = payload.requested_formats;
        if (Array.isArray(formats)) {
            candidates.push(...formats);
        }
    }
    if ('format' in payload && typeof payload.format === 'object') {
        candidates.push(payload.format);
    }
    for (const candidate of candidates) {
        if (isYtDlpFormat(candidate)) {
            return candidate;
        }
    }
    return null;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
    mp4: 'video/mp4',
    m4a: 'audio/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    '3gp': 'video/3gpp'
};

function contentTypeFor(format: YtDlpFormat, audio: boolean): string {
    const ext = format.ext?.toLowerCase() ?? '';
    if (audio && ext === 'webm') {
        return 'audio/webm';
    }
    return CONTENT_TYPE_BY_EXT[ext] ?? (audio ? 'audio/mp4' : 'video/mp4');
}

function stderrTail(error: unknown): string {
    if (typeof error !== 'object' || error === null) {
        return String(error);
    }
    const parts: string[] = [];
    if ('stderr' in error && typeof error.stderr === 'string') {
        parts.push(error.stderr);
    }
    if ('message' in error && typeof error.message === 'string') {
        parts.push(error.message);
    }
    return parts
        .join(' | ')
        .trim()
        .split('\n')
        .slice(-3)
        .join(' / ')
        .slice(0, 500);
}

interface CacheEntry {
    media: ResolvedMedia;
    expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ResolvedMedia>>();

async function attemptResolve(
    videoId: string,
    audio: boolean,
    clients: string
): Promise<ResolvedMedia> {
    const args = [
        '--no-warnings',
        '--no-playlist',
        '--no-progress',
        '--no-cache-dir',
        '--extractor-args',
        `youtube:player_client=${clients}`,
        ...(POT_PROVIDER_URL
            ? [
                  '--extractor-args',
                  `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`
              ]
            : []),
        '-f',
        audio ? AUDIO_FORMAT : VIDEO_FORMAT,
        '-J',
        `https://www.youtube.com/watch?v=${videoId}`
    ];

    let stdout: string;
    try {
        const result = await execFileAsync(YTDLP_BIN, args, {
            timeout: RESOLVE_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES
        });
        stdout = result.stdout;
    } catch (error) {
        throw new YouTubeError(
            'YTDLP_FAILED',
            `yt-dlp could not resolve ${videoId} (clients ${clients}): ${stderrTail(
                error
            )}`,
            502
        );
    }

    let payload: unknown;
    try {
        payload = JSON.parse(stdout);
    } catch {
        throw new YouTubeError(
            'YTDLP_BAD_OUTPUT',
            `yt-dlp returned unparsable output for ${videoId}`,
            502
        );
    }

    const format = pickFormat(payload);
    if (!format) {
        throw new YouTubeError(
            'YTDLP_NO_FORMAT',
            `yt-dlp found no ${
                audio ? 'audio' : 'video'
            } format for ${videoId} (clients ${clients})`,
            502
        );
    }

    return {
        url: format.url,
        headers: format.http_headers ?? {},
        contentType: contentTypeFor(format, audio),
        size: format.filesize ?? format.filesize_approx ?? null
    };
}

async function resolveUncached(
    videoId: string,
    audio: boolean
): Promise<ResolvedMedia> {
    let lastError: unknown = new YouTubeError(
        'YTDLP_FAILED',
        `yt-dlp could not resolve ${videoId}`,
        502
    );
    for (const clients of CLIENT_FALLBACKS) {
        try {
            return await attemptResolve(videoId, audio, clients);
        } catch (error) {
            lastError = error;
            console.warn(
                `[YouTube] resolve failed for ${videoId} with clients ${clients}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }
    throw lastError;
}

/**
 * Resolve (videoId, audio) to a direct media URL, cached for an hour. `force`
 * skips the cache and refreshes it — used when the cached URL 403s, which
 * happens when a URL outlives its signature.
 */
export async function resolveMedia(
    videoId: string,
    audio: boolean,
    options: { force?: boolean } = {}
): Promise<ResolvedMedia> {
    const key = `${videoId}:${audio ? 'audio' : 'video'}`;

    if (!options.force) {
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.media;
        }
        const pending = inFlight.get(key);
        if (pending) {
            return pending;
        }
    }

    const pending = resolveUncached(videoId, audio).then(
        (media) => {
            cache.set(key, { media, expiresAt: Date.now() + CACHE_TTL_MS });
            inFlight.delete(key);
            return media;
        },
        (error: unknown) => {
            inFlight.delete(key);
            throw error;
        }
    );
    inFlight.set(key, pending);
    return pending;
}
