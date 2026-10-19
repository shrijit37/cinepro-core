/**
 * Server-side retry for transient upstream connection failures.
 *
 * The framework resolves a title by validating it against TMDB first. From the
 * deployed host that TCP/TLS connection is occasionally reset mid-response
 * (`TypeError: fetch failed` / cause `Error: read ECONNRESET`, errno -104); the
 * error escapes `TMDBService.validateMovie` and the API answered 500
 * `INTERNAL_ERROR` before a single provider ran, even though the same request
 * succeeded seconds later (measured on the Dokploy host: 2026-10-19T18:33:14Z
 * and 18:33:29Z both `fetch failed`, then 18:33:33Z resolved normally).
 *
 * So wrap the global fetch: idempotent requests (GET/HEAD) that fail with a
 * transport-level reset are retried on a short growing backoff. A single
 * 250 ms retry was not enough — the resets persist for seconds, so the request
 * died where a 4 s budget carries it through. Everything else, and
 * non-transient errors, propagate unchanged (see `errorMapping.ts`, which
 * turns a surviving transport error into an honest 503 instead of a 500).
 */

import { setTimeout as delay } from 'node:timers/promises';

const RETRYABLE_CODES: Record<string, true> = {
    ECONNRESET: true,
    ECONNREFUSED: true,
    ECONNABORTED: true,
    EPIPE: true,
    ETIMEDOUT: true,
    EAI_AGAIN: true,
    UND_ERR_SOCKET: true,
    UND_ERR_CONNECT_TIMEOUT: true,
    UND_ERR_HEADERS_TIMEOUT: true,
    UND_ERR_BODY_TIMEOUT: true
};

/** Waits before attempt 2, 3, 4, 5 — 5 attempts inside ~5.5 s. */
export const RETRY_DELAYS_MS = [250, 750, 1500, 3000];

/**
 * True when the error is a transport-level failure of the connection itself
 * rather than an answer from the server. undici nests the socket error under
 * `cause`, sometimes two levels deep, and reports the wrapper as a bare
 * `TypeError: fetch failed` — hence the walk and the message fallback.
 */
export function isTransient(error: unknown): boolean {
    let current: unknown = error;
    // undici nests the socket error under `cause`, sometimes two levels deep.
    for (let depth = 0; depth < 4; depth++) {
        if (typeof current !== 'object' || current === null) {
            return false;
        }
        if (
            'code' in current &&
            typeof current.code === 'string' &&
            RETRYABLE_CODES[current.code]
        ) {
            return true;
        }
        if (!('cause' in current)) {
            return false;
        }
        current = current.cause;
    }
    return false;
}

export function installFetchRetry(
    retryDelaysMs: readonly number[] = RETRY_DELAYS_MS
): void {
    const original = globalThis.fetch;

    globalThis.fetch = async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
        const method = (
            init?.method ?? (input instanceof Request ? input.method : 'GET')
        ).toUpperCase();
        const retryableMethod = method === 'GET' || method === 'HEAD';

        for (let attempt = 0; ; attempt++) {
            try {
                return await original(input, init);
            } catch (error) {
                const nextDelay = retryDelaysMs[attempt];
                if (
                    !retryableMethod ||
                    nextDelay === undefined ||
                    !isTransient(error)
                ) {
                    throw error;
                }
                console.warn(
                    `[FetchRetry] transient ${method} failure (${
                        error instanceof Error ? error.message : String(error)
                    }) — retrying in ${nextDelay}ms`
                );
                await delay(nextDelay);
            }
        }
    };
}
