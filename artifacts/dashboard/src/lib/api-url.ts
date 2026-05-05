/**
 * API_BASE_URL — the base URL prefix for all API calls.
 *
 * On Replit (dev and production): uses Vite's BASE_URL (same-origin relative path).
 * On Fly.io: VITE_API_BASE_URL is injected at build time pointing to the API server's
 * Fly.io hostname (e.g. https://mizi-api.fly.dev). In that case every API fetch
 * must be cross-origin so we prepend the API origin.
 *
 * Note the trailing slash is always present so callers can write
 *   `${API_BASE_URL}api/...`
 * without worrying about double-slashes.
 */
const rawApiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;

export const API_BASE_URL: string = rawApiBase
  ? rawApiBase.replace(/\/+$/, "") + "/"
  : (import.meta.env.BASE_URL ?? "/");
