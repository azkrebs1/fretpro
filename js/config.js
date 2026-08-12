/* Supabase connection.
 *
 * Paste the two values from your Supabase project below:
 *   Project Settings → API → Project URL, and the `anon` / publishable key.
 *
 * The anon key is designed to sit in client code — it identifies the project,
 * it does not grant access on its own. What actually guards the data is the
 * SQL in supabase/schema.sql, which keeps the table itself unreadable and
 * exposes only two functions that need an exact username.
 *
 * Leave these blank and the app runs exactly as before, entirely on this
 * device, with the account panel showing that cloud saves are switched off.
 */

export const SUPABASE_URL = 'https://qsyxckyodnzoyrqayusd.supabase.co/rest/v1/';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzeXhja3lvZG56b3lycWF5dXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NzE4NTEsImV4cCI6MjEwMjE0Nzg1MX0.H0tYZmJ7QflZWvKuXHE6YLRzcuiDRIWTWcOCJL3wJlA';

/** Lets you try a project without editing this file — Setup → Account. */
const OVERRIDE_KEY = 'fretpro.supabase';

export function readOverride() {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(OVERRIDE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

export function writeOverride(url, key) {
  try {
    if (!url || !key) localStorage.removeItem(OVERRIDE_KEY);
    else localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ url: url.trim(), key: key.trim() }));
  } catch (err) {
    /* private browsing — the constants above still work */
  }
}

/**
 * Reduce whatever was pasted to the project root.
 *
 * The Supabase dashboard shows the REST endpoint as
 * `https://<project>.supabase.co/rest/v1/`, and that is the natural thing to
 * copy — but this app builds the `/rest/v1/...` path itself, so keeping it
 * would request `/rest/v1/rest/v1/...` and 404. Accept either form.
 */
export function normalizeProjectUrl(raw) {
  let url = String(raw == null ? '' : raw).trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const restAt = url.toLowerCase().indexOf('/rest/v1');
  if (restAt > -1) url = url.slice(0, restAt);
  return url.replace(/\/+$/, '');
}

/** The connection actually in use: the override if set, otherwise the constants. */
export function supabaseConfig() {
  const override = readOverride();
  const url = (override && override.url) || SUPABASE_URL;
  const key = (override && override.key) || SUPABASE_ANON_KEY;
  return {
    url: normalizeProjectUrl(url),
    key: (key || '').trim(),
    fromOverride: Boolean(override && override.url && override.key),
  };
}

export function isCloudConfigured() {
  const { url, key } = supabaseConfig();
  return Boolean(url && key);
}
