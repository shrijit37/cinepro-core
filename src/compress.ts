import { gzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Gzip for JSON answers, installed as a plain `onSend` hook.
 *
 * `@fastify/compress` cannot do this job here: it works by hooking `onRoute`, and the framework
 * registers every route inside its constructor, before we can get hold of the instance — so
 * `global: true` silently covers nothing (measured: a 101 KB details body still left the process
 * uncompressed). An `onSend` hook added after the fact does run for those routes.
 *
 * Why it matters on this box: a details read carrying cast, trailer and recommendations is ~100 KB
 * of JSON and the panel fetches it over Wi-Fi. Gzip takes it to ~11 KB, and the panel's measured
 * cost for that body drops with it. Below the threshold the CPU is not worth the two bytes saved.
 */
const THRESHOLD = 1024;

/** Types worth gzipping. Media (the proxy route) and images are already compressed or streamed. */
const COMPRESSIBLE = /^(application\/(json|javascript|xml)|text\/)/i;

function acceptsGzip(header: string | undefined): boolean {
    if (!header) {
        return false;
    }
    return header.split(',').some((part) => {
        const [name, ...params] = part.trim().split(';');
        if (name.trim().toLowerCase() !== 'gzip') {
            return false;
        }
        // `gzip;q=0` is an explicit refusal.
        const q = params.find((p) => p.trim().startsWith('q='));
        return !q || Number(q.trim().slice(2)) > 0;
    });
}

export function installCompression(app: FastifyInstance): void {
    app.addHook('onSend', async (request, reply: FastifyReply, payload) => {
        if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
            // A stream (proxy, YouTube byte pipe) is already flowing; do not buffer it.
            return payload;
        }
        if (reply.getHeader('content-encoding')) {
            return payload;
        }
        const type = String(reply.getHeader('content-type') ?? '');
        if (!COMPRESSIBLE.test(type)) {
            return payload;
        }
        if (
            !acceptsGzip(
                request.headers['accept-encoding'] as string | undefined
            )
        ) {
            return payload;
        }
        const body = Buffer.isBuffer(payload)
            ? payload
            : Buffer.from(payload, 'utf8');
        if (body.length < THRESHOLD) {
            return payload;
        }
        const compressed = gzipSync(body);
        reply
            .header('content-encoding', 'gzip')
            .header('content-length', compressed.length)
            // Downstream caches must key on the encoding, or a gzip body is served to a client
            // that never asked for one.
            .header('vary', 'accept-encoding');
        return compressed;
    });
}
