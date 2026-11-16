/**
 * `GET /health` — deployment healthcheck endpoint.
 *
 * Distinct from the framework's OMSS `GET /v1/health` info endpoint: this one
 * is a readiness gate. It returns 503 when the Supabase gateway is unreachable
 * so Coolify pulls the container out of rotation, and reports the baked-in
 * APP_VERSION so the deploy workflow can prove which build is answering.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { probeSupabase } from './lib/supabase.js';

/**
 * Register the readiness endpoint on the framework's Fastify instance.
 *
 * The framework installs its 404 handler with `setNotFoundHandler` in the
 * OMSSServer constructor; Fastify only invokes that for *unmatched* routes, so
 * a concrete `/health` route registered before `server.start()` wins. This is
 * the same app-level registration path used by the YouTube routes.
 *
 * @param app - The framework's underlying Fastify instance.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
    app.get('/health', async (_request, reply: FastifyReply) => {
        const databaseUp = await probeSupabase();

        return reply.code(databaseUp ? 200 : 503).send({
            status: databaseUp ? 'ok' : 'degraded',
            service: 'cinepro-core',
            version: process.env.APP_VERSION || '1.0.0',
            checks: { database: databaseUp ? 'up' : 'down' }
        });
    });
}
