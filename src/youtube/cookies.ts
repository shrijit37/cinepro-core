/**
 * Signed-in YouTube cookies for yt-dlp.
 *
 * YouTube refuses a flagged egress address whether or not the client family
 * looks convincing, and a WARP lane only moves the lottery to a different
 * address — measured: one id resolved in 3.2 s on a lane, the next burned
 * 61.5 s and answered 502. A session cookie set for a dedicated account is the
 * lever that actually removes the lottery: with it the deploy host's own
 * egress resolves the same ids in ~2.4 s, so `src/youtube/ytdlp.ts` tries the
 * direct path first and keeps the lanes as the fallback.
 *
 * The value is a Netscape `cookies.txt`, base64-encoded, in `YTDLP_COOKIES_B64`
 * (Doppler `CINEPRO_YTDLP_COOKIES_B64`, substituted into the app env by CI).
 * Base64 because a multi-line value survives `.env` files, Dokploy's env
 * handling and `docker run -e` only by luck — a plain value was silently
 * truncated to 907 bytes of a 2831-byte file when this was first tried, which
 * fails as a confusing "still bot-checked" rather than as a broken secret.
 *
 * The file is written once at boot, atomically, mode 0600, and only when the
 * decoded content differs — so a redeploy that carries fresh cookies replaces
 * it and a redeploy that carries the same cookies leaves it alone. Nothing here
 * ever logs, echoes or otherwise exposes the cookie content.
 */

import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Where the materialised cookie jar lives, null when no cookies are configured. */
let cookiePath: string | null = null;

function cookieTarget(): string {
    const override = process.env.YTDLP_COOKIES_FILE;
    if (override) {
        return override;
    }
    const dataDir = process.env.DATA_DIR ?? tmpdir();
    return path.join(dataDir, 'yt-cookies.txt');
}

/** Netscape files carry a few comment lines; count the real entries. */
function cookieCount(content: string): number {
    return content
        .split('\n')
        .filter((line) => line.trim().length > 0 && !line.startsWith('#'))
        .length;
}

/**
 * Materialise the cookie jar and return its path. Safe to call more than once.
 * A missing or undecodable secret is not fatal: the caller then resolves the
 * way it did before cookies existed.
 */
export function installCookies(): string | null {
    if (cookiePath) {
        return cookiePath;
    }
    const encoded = (process.env.YTDLP_COOKIES_B64 ?? '').trim();
    const target = cookieTarget();

    if (!encoded) {
        if (process.env.YTDLP_COOKIES_FILE && existsSync(target)) {
            cookiePath = target;
            console.log(
                `[YouTube] using the cookie jar at ${target} (${process.env.YTDLP_COOKIES_FILE})`
            );
        }
        return null;
    }

    let content: string;
    try {
        content = Buffer.from(encoded, 'base64').toString('utf8');
    } catch (error) {
        console.error(
            `[YouTube] YTDLP_COOKIES_B64 is not valid base64 (${error instanceof Error ? error.message : String(error)}); resolving without cookies`
        );
        return null;
    }
    if (!content.includes('\t')) {
        // A Netscape jar is tab-separated; anything else is a truncated or
        // wrongly encoded secret, and passing it to yt-dlp would make YouTube
        // answer "cookies are no longer valid" on every request.
        console.error(
            `[YouTube] YTDLP_COOKIES_B64 decoded to ${content.length} bytes with no tab-separated rows — not a Netscape cookie jar; resolving without cookies`
        );
        return null;
    }

    try {
        const current = existsSync(target)
            ? readFileSync(target, 'utf8')
            : null;
        if (current !== content) {
            mkdirSync(path.dirname(target), { recursive: true });
            const tmp = `${target}.${process.pid}.tmp`;
            writeFileSync(tmp, content, { mode: 0o600 });
            chmodSync(tmp, 0o600);
            renameSync(tmp, target);
            console.log(
                `[YouTube] wrote ${cookieCount(content)} cookies to ${target}`
            );
        } else {
            console.log(
                `[YouTube] cookie jar at ${target} is unchanged (${cookieCount(content)} cookies)`
            );
        }
        cookiePath = target;
        return cookiePath;
    } catch (error) {
        rmSync(`${target}.${process.pid}.tmp`, { force: true });
        console.error(
            `[YouTube] could not write the cookie jar to ${target} (${
                error instanceof Error ? error.message : String(error)
            }); resolving without cookies`
        );
        return null;
    }
}

/** The cookie jar yt-dlp should use, null when none is configured. */
export function cookieFile(): string | null {
    return cookiePath ?? installCookies();
}
