/**
 * Server-side retry for transient upstream connection failures.
 *
 * The framework resolves a title by validating it against TMDB first. From the
 * deployed host that TCP/TLS connection is occasionally reset mid-response
 * (`TypeError: fetch failed` / cause `Error: read ECONNRESET`, errno -104); the
 * error escapes `TMDBService.validateMovie` and the API answers 500 before a
 * single provider runs. A cold-cache miss is not a 500 — the same request
 * succeeds on the next attempt.
 *
 * So wrap the global fetch: idempotent requests (GET/HEAD) that fail with a
 * transport-level reset are retried once after a short delay. Everything else,
 * and non-transient errors, propagate unchanged.
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

function isTransient(error: unknown): boolean {
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

export function installFetchRetry(retryDelayMs = 250): void {
    const original = globalThis.fetch;

    globalThis.fetch = async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => {
        const method = (
            init?.method ?? (input instanceof Request ? input.method : 'GET')
        ).toUpperCase();

        try {
            return await original(input, init);
        } catch (error) {
            if ((method !== 'GET' && method !== 'HEAD') || !isTransient(error)) {
                throw error;
            }
            await delay(retryDelayMs);
            return await original(input, init);
        }
    };
}
