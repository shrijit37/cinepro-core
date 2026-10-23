import { OMSSServer } from '@omss/framework';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installFetchRetry } from './fetchRetry.js';
import { installCookies } from './youtube/cookies.js';
import { installSourceLiveness } from './sourceLiveness.js';
import { installTmdbResilience } from './tmdbResilience.js';
import { registerYouTubeRoutes } from './youtube/routes.js';
import { registerTmdbRoutes } from './tmdb/routes.js';
import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';
import { installCompression } from './compress.js';
import type { FastifyInstance } from 'fastify';

// Must be installed before the server issues its first upstream request.
installFetchRetry();
// The signed-in YouTube cookie jar is materialised once at boot: the app env
// only changes when the container is recreated, so there is nothing to watch.
// A missing secret leaves yt-dlp resolving through the WARP lanes as before.
installCookies();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const server = new OMSSServer({
        name: 'CinePro',
        // Baked in at image build time (Dockerfile ARG APP_VERSION) so the
        // deploy gate can prove which build is answering. Falls back to the
        // release version for a local `npm run dev`.
        version: process.env.APP_VERSION ?? '1.0.0',

        // Network
        host: process.env.HOST ?? 'localhost',
        port: Number(process.env.PORT ?? 3000),
        publicUrl: process.env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (process.env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 60 * 60,
                subtitles: 60 * 60 * 24
            },
            redis: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
                password: process.env.REDIS_PASSWORD
            }
        },

        // TMDB
        tmdb: {
            apiKey: process.env.TMDB_API_KEY!,
            cacheTTL: 24 * 60 * 60 // 24h
        },

        // Third Party Proxy removal
        proxyConfig: {
            knownThirdPartyProxies: knownThirdPartyProxies,
            streamPatterns
        },

        cors: {
            origin: process.env.CORS_ORIGIN ?? '*',
            methods: ['GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        },

        stremio: {
            // exposes a stremio addon on /stremio/manifest.json
            enableNativeAddon: process.env.STREMIO_ADDON === 'true',
            // you can your own custom stremio addons as sources into cinepro.
            stremioAddons: []
            /*
            stremioAddons: [
                {
                    id: 'some-unique-id',
                    url: 'https://example.com/manifest.json',
                    enabled: true
                }
            ]
            */
        },

        // MCP for AI agents
        mcp: {
            enabled: process.env.MCP_ENABLED === 'true'
        }
    });

    // Register providers
    const registry = server.getRegistry();
    await registry.discoverProviders(path.join(__dirname, './providers/'));

    // YouTube media endpoints. `app` is private on OMSSServer — there is no
    // hook to attach routes, so reach into it rather than re-implementing the
    // server; the framework field is stable and this is the only coupling.
    const { app } = server as unknown as { app: FastifyInstance };
    // A details read with the cast, trailer and recommendations appended is ~100 KB of JSON and
    // the panel pays for every byte over Wi-Fi. Gzip takes it to ~11 KB. Installed as an onSend
    // hook rather than a plugin, because the framework registered its routes before we could
    // touch the instance and an `onRoute`-based plugin covers none of them.
    installCompression(app);
    registerYouTubeRoutes(app);
    // The launcher's metadata half (rails, details, cast, search). Until this existed the panel
    // carried its own TMDB key and talked to api.themoviedb.org directly.
    registerTmdbRoutes(app);

    // Turns a TMDB transport failure that outlasted the fetch retries into a
    // 503 UPSTREAM_UNAVAILABLE instead of the framework's generic 500, so the
    // launcher retries a request that a moment later works. The service is
    // private on OMSSServer, hence the cast.
    const serverInternals = server as unknown as { tmdbService?: object };
    const guarded = installTmdbResilience(serverInternals.tmdbService ?? {});
    if (guarded === 0) {
        console.warn(
            '[TmdbResilience] no TMDB methods were guarded — the framework changed shape; the resolve path answers 500 on a TMDB flap again'
        );
    }

    // Wraps SourceService's two resolve entry points so a source whose URL is
    // already dead is dropped before the response (or the 1-hour cache) carries
    // it to the player.
    installSourceLiveness();

    await server.start();

    const publicUrl =
        process.env.PUBLIC_URL ??
        `http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 3000}`;

    const uiUrl = `https://ui.cinepro.cc/?omssurl=${encodeURIComponent(publicUrl)}`;

    const title = '🚀 CinePro/ui is in public testing';
    const contrib =
        '🤝 We are looking for contributors to improve and develop!';
    const repo = 'Contribute: https://github.com/cinepro-org/ui';
    const tryIt = `🌐 Try it out: ${uiUrl} !`;
    const note =
        'You will need to give the website "access to local applications" that it works.';

    const lines = [title, '', repo, '', contrib, '', tryIt, '', note];

    // compute box width based on longest line
    const width = Math.max(...lines.map((l) => l.length)) + 2;

    const borderTop = '╭' + '─'.repeat(width) + '╮';
    const borderBottom = '╰' + '─'.repeat(width) + '╯';

    const pad = (line: string) => '│ ' + line.padEnd(width - 2, ' ') + ' │';

    console.log(`
================== CINEPRO BETA ANNOUNCEMENT ==================

${borderTop}
${lines.map(pad).join('\n')}
${borderBottom}
`);
}

main().catch(() => {
    process.exit(1);
});
