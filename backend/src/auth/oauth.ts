import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index.js';
import { users } from '../db/schema.js';

/**
 * Hand-rolled OAuth2 authorization-code flow for Google + GitHub (docs/SPEC.md §5).
 *
 * The spec is explicit: "Exchange the authorization code via `fetch` to the
 * provider's token endpoint, then fetch the userinfo endpoint to get the user's
 * profile. Do not use Passport.js — it adds complexity without benefit for this
 * flow. Must use the same strategy consistently for both Google and GitHub."
 *
 * Both providers are driven by one small `Provider` description and a single
 * shared `run*` path (start → callback → token exchange → userinfo →
 * find-or-create → set session). The only provider-specific bits are the
 * authorization/token/userinfo URLs, the userinfo→profile mapping, and
 * GitHub's email fallback.
 */

/** Minimal logger surface used for non-fatal warnings. */
export type AuthLogger = { warn: (msg: string) => void };

/** The subset of the provider profile the app consumes (structural). */
export interface SsoProfile {
  id: string;
  displayName?: string | undefined;
  username?: string | undefined;
  emails?: Array<{ value?: string }> | undefined;
  photos?: Array<{ value?: string }> | undefined;
}

type ProviderName = 'google' | 'github';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
}

interface Provider {
  name: ProviderName;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  extraAuthQuery?: Record<string, string>;
  /** Map a parsed userinfo JSON object to an app profile. */
  mapUserinfo: (info: unknown) => SsoProfile;
  /** Resolve an email from userinfo, optionally with a network fallback. */
  resolveEmail: (info: unknown, accessToken: string, log: AuthLogger) => Promise<string | null>;
}

const backendUrl = () => process.env.BACKEND_URL || 'http://localhost:3000';

/**
 * OAuth CSRF `state` — a random value bound to the session and echoed back in
 * the callback (docs/SPEC.md §14: "callback without valid state parameter is
 * rejected"). The session (already loaded by `@fastify/session` on the
 * authorization route) carries the value; the callback compares and clears it.
 */
const SSO_STATE_KEY = 'oauthState';

function randomState(): string {
  return crypto.randomUUID();
}

const PROVIDERS: Record<ProviderName, Provider> = {
  google: {
    name: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    extraAuthQuery: {
      // v2 endpoint accepts `state` + standard params; `access_type`/`prompt`
      // are not required for a minimal login.
      response_type: 'code',
    },
    mapUserinfo: (info) => {
      const u = (info ?? {}) as Record<string, unknown>;
      const sub = typeof u.sub === 'string' ? u.sub : '';
      return {
        id: sub,
        displayName: typeof u.name === 'string' ? u.name : undefined,
        photos: typeof u.picture === 'string' ? [{ value: u.picture }] : undefined,
      };
    },
    // Google's userinfo endpoint returns the email directly.
    resolveEmail: async (info) => {
      const u = (info ?? {}) as Record<string, unknown>;
      return typeof u.email === 'string' ? u.email : null;
    },
  },
  github: {
    name: 'github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    extraAuthQuery: {
      response_type: 'code',
      // GitHub's userinfo is `GET /user`; the profile id is the numeric `id`.
    },
    mapUserinfo: (info) => {
      const u = (info ?? {}) as Record<string, unknown>;
      const id = typeof u.id === 'number' ? String(u.id) : typeof u.id === 'string' ? u.id : '';
      return {
        id,
        displayName: typeof u.name === 'string' ? u.name : undefined,
        username: typeof u.login === 'string' ? u.login : undefined,
        photos: typeof u.avatar_url === 'string' ? [{ value: u.avatar_url }] : undefined,
      };
    },
    // GitHub's /user profile only includes `email` when it's public. Fall back
    // to `GET /user/emails` and pick the primary (or first) address
    // (docs/SPEC.md §5).
    resolveEmail: (info, accessToken, log) => {
      const u = (info ?? {}) as Record<string, unknown>;
      if (typeof u.email === 'string' && u.email.length > 0) {
        return Promise.resolve(u.email);
      }
      return fetchGithubEmail(accessToken, log);
    },
  },
};

/**
 * Fetches the user's primary (or first) email from GitHub when the OAuth
 * profile does not expose a public email (docs/SPEC.md §5).
 */
async function fetchGithubEmail(accessToken: string, log: AuthLogger): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'habit-tracker',
      },
    });
    if (!res.ok) {
      log.warn(`GitHub /user/emails fallback failed with status ${res.status}`);
      return null;
    }
    const data = (await res.json()) as Array<{ email: string; primary?: boolean }>;
    const primary = data.find((entry) => entry.primary && entry.email);
    const first = data.find((entry) => entry.email);
    return (primary ?? first)?.email ?? null;
  } catch (err) {
    log.warn(`GitHub /user/emails fallback failed: ${String(err)}`);
    return null;
  }
}

/**
 * Find-or-create the user row for an SSO sign-in (docs/SPEC.md §5: "on first
 * sign-in via any provider, auto-create a `users` row"). The existing row is
 * refreshed with the freshest profile data on each sign-in.
 *
 * Uses `and(eq(...), eq(...))` for the two-part lookup per CLAUDE.md hard rule 2.
 */
export async function findOrCreateUser(
  db: AppDatabase,
  provider: ProviderName,
  providerUserId: string,
  profile: SsoProfile,
  email: string | null,
): Promise<{ id: string }> {
  const displayName = profile.displayName ?? profile.username ?? providerUserId;
  const avatarUrl = profile.photos?.[0]?.value ?? null;
  const nowSec = Math.floor(Date.now() / 1000);

  const existing = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.provider, provider), eq(users.providerUserId, providerUserId)))
    .get();

  if (existing) {
    db.update(users)
      .set({ displayName, email, avatarUrl })
      .where(and(eq(users.provider, provider), eq(users.providerUserId, providerUserId)))
      .run();
    return { id: existing.id };
  }

  const inserted = db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      provider,
      providerUserId,
      email,
      displayName,
      avatarUrl,
      createdAt: nowSec,
    })
    .returning({ id: users.id })
    .get();
  return { id: inserted.id };
}

/** Returns true when the provider's OAuth client id is configured at boot. */
export function isProviderConfigured(name: ProviderName): boolean {
  const id = process.env[`${name.toUpperCase()}_CLIENT_ID`];
  const secret = process.env[`${name.toUpperCase()}_CLIENT_SECRET`];
  return Boolean(id && secret);
}

/**
 * Builds the provider's authorization URL, storing a random CSRF `state` in the
 * session so the callback can verify it. Returns `null` when the provider is
 * not configured (the route then redirects to the frontend error page).
 */
export function buildAuthorizeUrl(name: ProviderName, session: { oauthState?: string }): string | null {
  if (!isProviderConfigured(name)) return null;
  const provider = PROVIDERS[name];
  const clientId = process.env[`${name.toUpperCase()}_CLIENT_ID`] as string;
  const state = randomState();
  session.oauthState = state;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${backendUrl()}/api/auth/${name}/callback`,
    scope: provider.scope,
    state,
    ...(provider.extraAuthQuery ?? {}),
  });
  return `${provider.authorizeUrl}?${params.toString()}`;
}

/**
 * Completes the OAuth callback: verifies `state`, exchanges the code for an
 * access token, fetches userinfo, find-or-creates the user, and returns the
 * user id (the route then sets the session). Throws on any failure — the route
 * catches it and redirects to the frontend error page.
 */
export async function completeOAuth(
  name: ProviderName,
  session: { oauthState?: string },
  code: unknown,
  state: unknown,
  db: AppDatabase,
  log: AuthLogger,
): Promise<string> {
  const provider = PROVIDERS[name];

  // 1. CSRF state check (docs/SPEC.md §14). Must match and be present.
  const expectedState = typeof session.oauthState === 'string' ? session.oauthState : null;
  delete session.oauthState; // single-use — clear regardless of outcome.
  if (!expectedState || typeof state !== 'string' || state !== expectedState) {
    throw new Error('OAuth state mismatch');
  }
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error('OAuth callback missing code');
  }

  // 2. Token exchange (authorization code → access token) via fetch.
  const clientId = process.env[`${name.toUpperCase()}_CLIENT_ID`] as string;
  const clientSecret = process.env[`${name.toUpperCase()}_CLIENT_SECRET`] as string;
  const tokenForm = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `${backendUrl()}/api/auth/${name}/callback`,
  });
  // GitHub requires `Accept: application/json`; Google accepts form-encoded.
  const tokenRes = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: tokenForm.toString(),
  });
  if (!tokenRes.ok) {
    log.warn(`${name} token exchange failed with status ${tokenRes.status}`);
    throw new Error('OAuth token exchange failed');
  }
  const token = (await tokenRes.json()) as TokenResponse;
  if (!token.access_token) {
    throw new Error('OAuth token exchange returned no access_token');
  }

  // 3. Userinfo: Google `GET /oauth2/v2/userinfo`, GitHub `GET /user`.
  const userinfoUrl =
    name === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://api.github.com/user';
  const userRes = await fetch(userinfoUrl, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/json',
      'User-Agent': 'habit-tracker',
    },
  });
  if (!userRes.ok) {
    log.warn(`${name} userinfo fetch failed with status ${userRes.status}`);
    throw new Error('OAuth userinfo fetch failed');
  }
  const info = (await userRes.json()) as unknown;
  const profile = provider.mapUserinfo(info);
  if (!profile.id) {
    throw new Error('OAuth userinfo returned no user id');
  }

  // 4. Email (GitHub falls back to /user/emails when the profile has none).
  const email = await provider.resolveEmail(info, token.access_token, log);

  // 5. Find-or-create the user row.
  const user = await findOrCreateUser(db, name, profile.id, profile, email);
  return user.id;
}
