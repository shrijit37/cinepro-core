/**
 * Honest status codes for a TMDB outage.
 *
 * The framework validates a title against TMDB before a single provider runs,
 * and from the Dokploy host that connection is reset mid-response for seconds
 * at a time (`TypeError: fetch failed`, cause `Error: read ECONNRESET`).
 * `fetchRetry` now carries a request through a short flap, but when the flap
 * outlasts it the error escapes as a non-`OMSSError`, which the framework's
 * error handler answers as `500 INTERNAL_ERROR` ("An unexpected error
 * occurred"). Measured on production: `GET /v1/movies/603` → 500 in 1.0 s
 * (traceId 7236668d-…), the identical request → 200 in 8.7 s; same for
 * movies/1561726 and tv/213375/seasons/1/episodes/1. The TV shows "The
 * resolver failed" for a title that plays a moment later.
 *
 * A 5xx *is* the honest answer — the failure is upstream, not internal — but a
 * `503` with a machine-readable code and `details.retryAfterSeconds` tells the
 * client that retrying is the right move, and it stops a transient TMDB flap
 * from looking like a Core bug. `OMSSError` already carries a status code and
 * a JSON body, so this converts the transport failure into one instead of
 * rewriting the framework's error handler (which the package does not export:
 * `@omss/framework` publishes only its package root).
 *
 * The wrapper is installed on the *instance* the server built, not on the
 * prototype, so nothing else in the process inherits it.
 */

import { OMSSError } from '@omss/framework';
import { isTransient } from './fetchRetry.js';

/** Every TMDB-backed call the resolve path makes before a provider runs. */
const GUARDED_METHODS = [
    'validateMovie',
    'validateTV',
    'validateTVEpisode',
    'getMediaObject',
    'getImdbId'
] as const;

type AnyMethod = (...args: never[]) => Promise<unknown>;

/**
 * The framework's `ErrorCode` union has no member for "an upstream was
 * unreachable", and answering `INTERNAL_ERROR` for a TMDB flap is the bug this
 * module exists to fix. `/v1/youtube/*` already publishes codes outside that
 * union (`YTDLP_FAILED`, `UPSTREAM_REJECTED`), so this is an extension of the
 * same kind: the status carries the meaning (503 = retryable, upstream), the
 * code names it, and `details.retryAfterSeconds` says when.
 */
const UPSTREAM_UNAVAILABLE_CODE = 'UPSTREAM_UNAVAILABLE' as never;

/**
 * Convert a surviving transport failure into a 503, or return the count of
 * wrapped methods so the startup log can say whether the framework still has
 * the shape this expects (a silent zero would mean the guard is inert).
 */
export function installTmdbResilience(service: object): number {
    const target = service as unknown as Record<string, unknown>;
    let patched = 0;

    for (const name of GUARDED_METHODS) {
        const original = target[name];
        if (typeof original !== 'function') {
            continue;
        }
        target[name] = async (...args: never[]): Promise<unknown> => {
            try {
                return await (original as AnyMethod).apply(service, args);
            } catch (error) {
                if (!isTransient(error)) {
                    throw error;
                }
                const cause =
                    error instanceof Error ? error.message : String(error);
                console.error(
                    `[TmdbResilience] TMDB transport failure in ${name} after retries: ${cause}`
                );
                throw new OMSSError(
                    UPSTREAM_UNAVAILABLE_CODE,
                    'TMDB was unreachable; retry in a few seconds',
                    503,
                    {
                        dependency: 'tmdb',
                        retryAfterSeconds: 5,
                        cause
                    }
                );
            }
        };
        patched += 1;
    }

    return patched;
}
