/**
 * Drop sources that are provably dead before the player ever sees them.
 *
 * Measured on production: `GET /v1/movies/603` answered 200 while one of its
 * diagnostics said `CineSu: Stream URL is not accessible` — a provider can
 * report failure and still leave a stale/expired link reachable through
 * another one, and the framework's own source validation (a full `GET` of the
 * *proxied* URL with a 3 s budget) is neither cheap enough nor pointed at the
 * upstream host. The launcher then hands the TV a URL that 403s.
 *
 * So wrap the two resolve entry points on `SourceService` and probe each
 * resolved source against its real upstream URL — `HEAD` first, then a
 * 1-byte ranged `GET` when the host refuses `HEAD` — and drop the ones that
 * answer with an HTTP error or do not answer at all. Resolve responses are the
 * only place a source URL enters the product, and this wrapper sits around
 * them, so a dead URL cannot be served from the 1-hour response cache either.
 *
 * The prototype patch is deliberate: `@omss/framework` is consumed as a
 * pinned dependency and exposes no validation hook, and forking it to insert
 * one check would put a whole extractor framework under this repo's
 * maintenance. `SourceService` is an exported class and these are its two
 * public entry points — the narrowest seam that exists.
 */

import { OMSSErrors, ProxyService, SourceService } from '@omss/framework';

/**
 * The framework publishes only its package root (`exports` has no subpaths), so
 * the response types from `dist/core/types` cannot be imported. These are the
 * fields this module reads — the framework passes its own, richer objects
 * through untouched, so a structural subset is all that is needed.
 */
interface Diagnostic {
    code: string;
    message: string;
    field: string;
    severity: 'info' | 'warning' | 'error';
}

interface Source {
    url: string;
    provider?: { id?: string; name?: string };
}

interface ResolveResponse {
    sources: Source[];
    diagnostics: Diagnostic[];
}

/**
 * The two `SourceService` entry points this module wraps. The class cannot be
 * re-declared (its response type is not importable), so the patch target is
 * named once here and checked against this shape.
 */
interface ResolveEntryPoints {
    getMovieSources(
        this: SourceService,
        tmdbId: string
    ): Promise<ResolveResponse>;
    getTVSources(
        this: SourceService,
        tmdbId: string,
        season: number,
        episode: number
    ): Promise<ResolveResponse>;
}

/** A source that has not answered by now is not playable on a TV. */
const PROBE_TIMEOUT_MS = 6000;

interface ProbeOutcome {
    alive: boolean;
    detail: string;
}

interface UpstreamTarget {
    url: string;
    headers: Record<string, string>;
}

function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.name === 'AbortError' ? 'timed out' : error.message;
    }
    return String(error);
}

/**
 * Probe one resolved source URL. `HEAD` is the cheap path; hosts that refuse
 * it (405/501, or a CDN that only signs `GET`) get a single ranged byte
 * instead, so a working source is never dropped for a protocol detail.
 */
async function probeSourceUrl(target: UpstreamTarget): Promise<ProbeOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const reachable = (status: number) => status >= 200 && status < 400;

    try {
        const head = await fetch(target.url, {
            method: 'HEAD',
            headers: target.headers,
            redirect: 'follow',
            signal: controller.signal
        });
        const headStatus = head.status;
        await head.body?.cancel().catch(() => undefined);
        if (reachable(headStatus)) {
            return { alive: true, detail: `HEAD ${headStatus}` };
        }

        const ranged = await fetch(target.url, {
            method: 'GET',
            headers: { ...target.headers, Range: 'bytes=0-0' },
            redirect: 'follow',
            signal: controller.signal
        });
        const rangedStatus = ranged.status;
        await ranged.body?.cancel().catch(() => undefined);
        return {
            alive: reachable(rangedStatus),
            detail: `HEAD ${headStatus}, ranged GET ${rangedStatus}`
        };
    } catch (error) {
        return { alive: false, detail: describeError(error) };
    } finally {
        clearTimeout(timer);
    }
}

/** The upstream URL and headers a provider embedded in its proxy URL. */
function upstreamOf(source: Source): UpstreamTarget {
    try {
        const data = new URL(source.url).searchParams.get('data');
        if (data) {
            const decoded = ProxyService.decodeProxyData(data);
            return { url: decoded.url, headers: decoded.headers ?? {} };
        }
    } catch {
        // A provider that returns a direct URL is still worth probing.
    }
    return { url: source.url, headers: {} };
}

async function dropDeadSources(
    response: ResolveResponse,
    identify: string
): Promise<ResolveResponse> {
    if (
        response.sources.length === 0 ||
        process.env.SOURCE_LIVENESS === '0' ||
        process.env.INTERNAL_DEBUG === 'true'
    ) {
        return response;
    }

    const verdicts = await Promise.all(
        response.sources.map(async (source) => {
            const target = upstreamOf(source);
            return { source, target, outcome: await probeSourceUrl(target) };
        })
    );

    const kept: Source[] = [];
    const dropped: Diagnostic[] = [];
    for (const { source, target, outcome } of verdicts) {
        if (outcome.alive) {
            kept.push(source);
            continue;
        }
        dropped.push({
            code: 'PROVIDER_ERROR',
            message: `Dead source dropped (${
                source.provider?.name ?? source.provider?.id ?? '?'
            }) for ${identify}: ${outcome.detail} — ${target.url.slice(0, 200)}`,
            field: '',
            severity: 'warning'
        });
    }

    if (dropped.length === 0) {
        return response;
    }

    console.warn(
        `[SourceLiveness] dropped ${dropped.length}/${response.sources.length} dead source(s) for ${identify}: ${dropped
            .map((diagnostic) => diagnostic.message)
            .join(' | ')}`
    );

    if (kept.length === 0) {
        throw OMSSErrors.noSourcesAvailable(identify, 0);
    }

    return {
        ...response,
        sources: kept,
        diagnostics: [...response.diagnostics, ...dropped]
    };
}

let installed = false;

export function installSourceLiveness(): void {
    if (installed) {
        return;
    }
    installed = true;

    // The class's own declarations are not assignable to from here (their
    // response type is not importable), so the patch target is typed once.
    const service = SourceService.prototype as unknown as ResolveEntryPoints;

    const movieSources = service.getMovieSources;
    service.getMovieSources = async function (
        this: SourceService,
        tmdbId: string
    ): Promise<ResolveResponse> {
        const response = await movieSources.call(this, tmdbId);
        return dropDeadSources(response, `movie:${tmdbId}`);
    };

    const tvSources = service.getTVSources;
    service.getTVSources = async function (
        this: SourceService,
        tmdbId: string,
        season: number,
        episode: number
    ): Promise<ResolveResponse> {
        const response = await tvSources.call(this, tmdbId, season, episode);
        return dropDeadSources(response, `tv:${tmdbId}:s${season}:e${episode}`);
    };
}
