/**
 * Supabase HTTP gateway clients for the fleet project.
 *
 * Raw Postgres is not reachable from Coolify containers, so everything here
 * talks to the public PostgREST/GoTrue gateway over HTTPS. The URL and the
 * publishable (anon) key are public and safe to bake in as fallbacks; the
 * service-role secret is a credential and is only ever read from the
 * environment (injected at deploy time via the encrypted dotenvx file).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import 'dotenv/config';

/** Public fleet gateway URL. Empty env values deliberately fall back too. */
export const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    'https://supabase.shrijit.tech/rjrynmjugsxuytpotfma';

/** Publishable (anon RLS) key — public by design, safe as a fallback. */
export const SUPABASE_PUBLISHABLE_KEY =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    'sb_publishable_gB-4dti01NmMggaCj-o2cY-YsmWkw2_SxAiBHKaIoYQ_CyNbUZzt';

/**
 * Service-role secret. Never hardcoded: an unset value yields an empty string
 * and the readiness probe reports the database as down rather than shipping a
 * credential in the image.
 */
export const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

const noSession = {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
    }
} as const;

/**
 * Service-role client — bypasses RLS. Server-side use only.
 *
 * `null` when no secret was injected: supabase-js throws on an empty key, and a
 * missing credential must degrade to "database down", not crash the boot.
 */
export const supabaseAdmin: SupabaseClient | null = SUPABASE_SECRET_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, noSession)
    : null;

/** Anon client — subject to the project's row-level security policies. */
export const supabaseAnon: SupabaseClient = createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    noSession
);

/**
 * Readiness probe for the Supabase gateway.
 *
 * The PostgREST root (`/rest/v1/`) is reachable without a table query and
 * answers 200 only when the caller presents a service-role key — the anon key
 * is rejected there. That makes it a cheap, unambiguous "is the database up
 * and is our credential valid" signal for `GET /health`.
 *
 * @returns `true` only on a 2xx answer from the gateway.
 */
export async function probeSupabase(): Promise<boolean> {
    if (!SUPABASE_SECRET_KEY) {
        return false;
    }
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
            headers: { apikey: SUPABASE_SECRET_KEY },
            signal: AbortSignal.timeout(5000)
        });
        // Cancel the body: a readiness check only needs the status line and
        // must not leave a socket draining behind every healthcheck.
        await response.body?.cancel().catch(() => undefined);
        return response.ok;
    } catch {
        return false;
    }
}
