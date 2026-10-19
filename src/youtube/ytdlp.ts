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
 * Client families are per variant, because the two selectors need different
 * things and forcing a list changes what yt-dlp offers:
 *
 * - Video needs **muxed** progressive MP4 (format 18/22) — a single video+audio
 *   stream, since a plain HTTP player cannot mux split tracks. Only the
 *   `android` family still advertises those: `-f "b[ext=mp4][height<=720]"` on
 *   `default`/`ios`/`mweb` answers "Requested format is not available".
 * - Audio only needs an m4a track, and yt-dlp's own `default` rotation finds it
 *   without forcing anything (measured on the owner's failing track:
 *   `bestaudio[ext=m4a]` downloaded 4.16 MiB complete with no extractor args).
 *
 * `tv_embedded` and `web_safari` are deliberately absent: they are the two
 * clients YouTube bot-checks hardest, and forcing them is what made
 * /v1/youtube/* answer 502 for every music video.
 */
const VIDEO_CLIENTS =
    process.env.YTDLP_VIDEO_CLIENTS ?? 'android;web_embedded;mweb;android_vr';
const AUDIO_CLIENTS =
    process.env.YTDLP_AUDIO_CLIENTS ??
    'default;web_embedded;mweb;android;ios+web';
/**
 * Candidate client sets, tried in order until one yields a usable format. `;`
 * separates candidates so a candidate may still contain yt-dlp's own `,` list
 * (`ios+web` is spelled with `+` because a comma there would split it wrong).
 * The list is env-overridable on purpose: when YouTube moves the goalposts the
 * fix is a new candidate order, and that must not need a rebuild to find out.
 *
 * Every candidate is tried (they are cheap, ~2-4 s each) because the failing
 * axis differs per video: an unattested `android` request is fine from a
 * residential IP and bot-checked from a datacenter one, and only a PoToken
 * capable client (`web_embedded`, `mweb`) clears the latter.
 */
function clientCandidates(raw: string): string[] {
    return raw
        .split(';')
        .map((entry) => entry.trim().replace(/\+/g, ','))
        .filter((entry) => entry.length > 0);
}
const VIDEO_CLIENT_FALLBACKS = clientCandidates(VIDEO_CLIENTS);
const AUDIO_CLIENT_FALLBACKS = clientCandidates(AUDIO_CLIENTS);
/**
 * The `bgutil` PoToken provider (a second compose service, see
 * deploy/compose.prod.yml). From a datacenter IP YouTube answers the player
 * request with "Sign in to confirm you're not a bot" and hands out throttled
 * URLs; a PoToken minted by that service is what lifts both. Empty value
 * disables it (local runs without the provider).
 */
const POT_PROVIDER_URL =
    process.env.YTDLP_POT_URL ?? 'http://bgutil-provider:4416';
/**
 * Optional egress proxies for yt-dlp (`http://`, `socks5://`, `socks5h://`),
 * `;`-separated and tried in order — the fleet's WARP lane pool is a list of
 * HTTP CONNECT proxies, one egress IP per lane, and a lane that has been
 * flagged has to be rotated past rather than retried.
 *
 * This exists because YouTube bot-checks unattested requests from a flagged IP
 * regardless of client or PoToken, which is a property of the host, not of this
 * code: the same request from a residential connection resolves. An egress
 * change is the only lever short of cookies.
 */
const PROXIES: string[] = (process.env.YTDLP_PROXY ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
const VIDEO_FORMAT = 'b[ext=mp4][height<=720]/b[height<=720]/b';
const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio';
/**
 * `YTDLP_VERBOSE=1` adds `-v`. It is the knob for the next person who has to
 * explain a 502: yt-dlp's PoToken plugin reports what it asked the provider for
 * and what came back on stderr, and that output is what turns "YouTube is being
 * YouTube" into a fixable diagnosis. Off by default (it is loud and slows the
 * resolve).
 */
const VERBOSE = process.env.YTDLP_VERBOSE === '1';

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
    /**
     * HTTP CONNECT proxy the resolve ran through, null when the resolve was
     * direct. The media URL can be bound to the resolving egress (googlevideo
     * hands out IPv6 or IP-scoped hosts when the resolve came from a tunnel),
     * so the byte fetch has to leave through the same lane or it fails
     * transport-level while the URL is still valid.
     */
    proxy: string | null;
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

/**
 * Full stderr for the container log, while the HTTP error keeps the short tail:
 * a 502 body is read by a launcher, a log line is read by a human debugging
 * YouTube, and only the second one can afford 4 KB of yt-dlp noise.
 */
function stderrForLog(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'stderr' in error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        if (typeof stderr === 'string') {
            return stderr.trim().slice(-4000);
        }
    }
    return '';
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
        .slice(-8)
        .join(' / ')
        .slice(0, 700);
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
    clients: string,
    proxy: string
): Promise<ResolvedMedia> {
    const args = [
        // Deliberately no `--no-warnings`: the PoToken plugin's warnings
        // ("failed to fetch a token") are the difference between a mystery 502
        // and a diagnosis, and they end up in the error body below.
        ...(VERBOSE ? ['-v'] : []),
        ...(proxy ? ['--proxy', proxy] : []),
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
        const stderr = stderrForLog(error);
        if (stderr) {
            console.warn(
                `[YouTube] yt-dlp stderr for ${videoId} (clients ${clients}):\n${stderr}`
            );
        }
        throw new YouTubeError(
            'YTDLP_FAILED',
            `yt-dlp could not resolve ${videoId} (clients ${clients}, pot ${
                POT_PROVIDER_URL || 'off'
            }${proxy ? `, egress ${proxy}` : ''}): ${stderrTail(error)}`,
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
            } format for ${videoId} (clients ${clients}${
                proxy ? `, egress ${proxy}` : ''
            })`,
            502
        );
    }

    return {
        url: format.url,
        headers: format.http_headers ?? {},
        contentType: contentTypeFor(format, audio),
        size: format.filesize ?? format.filesize_approx ?? null,
        proxy: proxy || null
    };
}

/**
 * A dead lane and a flagged lane must not look the same: the first is an
 * infrastructure fault on our side (503, fix the sidecar), the second is
 * YouTube refusing this egress (502, rotate). yt-dlp reports a proxy it cannot
 * reach as a refused TCP connection with no other "proxy" marker in the text.
 */
const PROXY_UNREACHABLE_RE =
    /\[Errno 111\] Connection refused|\[Errno 101\] Network is unreachable|Unable to connect to proxy|ProxyError|Tunnel connection failed/;

function isProxyFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return PROXY_UNREACHABLE_RE.test(message);
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
    const clientFallbacks = audio
        ? AUDIO_CLIENT_FALLBACKS
        : VIDEO_CLIENT_FALLBACKS;
    // `''` keeps the no-proxy path identical to the pre-lane behaviour.
    const egresses = PROXIES.length > 0 ? PROXIES : [''];
    let proxyFailures = 0;
    for (const proxy of egresses) {
        for (const clients of clientFallbacks) {
            try {
                const media = await attemptResolve(
                    videoId,
                    audio,
                    clients,
                    proxy
                );
                if (proxy) {
                    console.log(
                        `[YouTube] resolved ${videoId} (${
                            audio ? 'audio' : 'video'
                        }) via client ${clients} through egress ${proxy}`
                    );
                }
                return media;
            } catch (error) {
                lastError = error;
                if (proxy && isProxyFailure(error)) {
                    proxyFailures += 1;
                    console.warn(
                        `[YouTube] egress ${proxy} unreachable for ${videoId}: ${
                            error instanceof Error
                                ? error.message
                                : String(error)
                        }`
                    );
                    break; // this lane is down; rotating is the only move
                }
                console.warn(
                    `[YouTube] resolve failed for ${videoId} with clients ${clients}${
                        proxy ? ` via egress ${proxy}` : ''
                    }: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
    }
    if (PROXIES.length > 0 && proxyFailures === PROXIES.length) {
        throw new YouTubeError(
            'YTDLP_PROXY_UNREACHABLE',
            `every configured egress refused ${videoId}: ${PROXIES.join(', ')} (${
                lastError instanceof Error
                    ? lastError.message
                    : String(lastError)
            })`,
            503
        );
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
