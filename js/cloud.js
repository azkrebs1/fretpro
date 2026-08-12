/* Cloud saves via Supabase.
 *
 * Sign-in is a username and nothing else, so treat a profile as public: anyone
 * who knows the name can load and overwrite it. The schema keeps the table
 * itself unreachable and exposes only get_profile / save_profile, both of which
 * need an exact username, so at least nobody can list or dump every profile.
 *
 * localStorage stays the source of truth for the running app. Supabase is a
 * sync target, which keeps the whole thing working offline and means nothing
 * blocks on the network mid-session.
 */

import { supabaseConfig, isCloudConfigured } from './config.js';
import * as store from './store.js';

const USER_KEY = 'fretpro.user';
const PUSH_DEBOUNCE_MS = 2500;
const REQUEST_TIMEOUT_MS = 12000;

export { isCloudConfigured };

/* ---------- usernames -------------------------------------------------- */

export function normalizeUsername(name) {
  return String(name == null ? '' : name)
    .trim()
    .toLowerCase();
}

/** Mirrors the check in schema.sql so the message arrives before the round trip. */
export function validateUsername(name) {
  const clean = normalizeUsername(name);
  if (!clean) return { ok: false, reason: 'Pick a username first.' };
  if (clean.length < 2) return { ok: false, reason: 'That is too short — at least 2 characters.' };
  if (clean.length > 24) return { ok: false, reason: 'That is too long — 24 characters at most.' };
  if (!/^[a-z0-9_-]+$/.test(clean)) {
    return { ok: false, reason: 'Letters, numbers, hyphen and underscore only.' };
  }
  return { ok: true, username: clean };
}

/* ---------- session ---------------------------------------------------- */

let signedInAs = readStoredUser();
let status = { state: 'idle', at: null, message: null };
const statusListeners = new Set();

function readStoredUser() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(USER_KEY);
  } catch (err) {
    return null;
  }
}

function writeStoredUser(username) {
  try {
    if (username) localStorage.setItem(USER_KEY, username);
    else localStorage.removeItem(USER_KEY);
  } catch (err) {
    /* keeps working for this tab either way */
  }
}

export const currentUser = () => signedInAs;
export const syncStatus = () => status;

export function onStatus(fn) {
  statusListeners.add(fn);
  fn(status);
  return () => statusListeners.delete(fn);
}

/** @param {'idle'|'syncing'|'saved'|'error'|'offline'|'off'} next */
function setStatus(next, message = null) {
  status = { state: next, at: Date.now(), message };
  for (const fn of statusListeners) {
    try {
      fn(status);
    } catch (err) {
      console.warn('A sync status listener failed.', err);
    }
  }
}

/* ---------- transport -------------------------------------------------- */

async function rpc(fn, body) {
  const { url, key } = supabaseConfig();
  if (!url || !key) throw new Error('Cloud saves are not configured yet.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(describeError(response.status, text));
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The server took too long to answer.');
    if (err instanceof TypeError) throw new Error('Could not reach the server — check your connection.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function describeError(statusCode, body) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = parsed.message || parsed.hint || parsed.error || '';
  } catch (err) {
    detail = (body || '').slice(0, 160);
  }
  if (statusCode === 404) return 'The database is missing its setup — run supabase/schema.sql.';
  if (statusCode === 401 || statusCode === 403) return 'The Supabase key was rejected. Check the anon key in js/config.js.';
  if (detail) return detail;
  return `The server returned ${statusCode}.`;
}

/** @returns {Promise<{username:string, state:object, updated_at:string}|null>} */
export async function fetchProfile(username) {
  return rpc('get_profile', { p_username: username });
}

export async function saveProfile(username, payload) {
  return rpc('save_profile', { p_username: username, p_state: payload });
}

/* ---------- sync ------------------------------------------------------- */

let pushTimer = null;
let pushing = false;
let pushAgain = false;

/**
 * Sign in and reconcile. A username that has never been used adopts whatever is
 * already on this device, so nothing is lost by signing in late.
 * @returns {Promise<{username:string, outcome:'created'|'merged'|'pulled'}>}
 */
export async function signIn(rawName) {
  const check = validateUsername(rawName);
  if (!check.ok) throw new Error(check.reason);
  if (!isCloudConfigured()) throw new Error('Cloud saves are not configured yet.');

  setStatus('syncing');
  try {
    const remote = await fetchProfile(check.username);
    const local = store.getState();
    let outcome;

    if (!remote || !remote.state) {
      outcome = 'created';
    } else if (store.isEmptyProgress(local)) {
      store.adoptState(store.mergeStates(local, remote.state));
      outcome = 'pulled';
    } else {
      store.adoptState(store.mergeStates(local, remote.state));
      outcome = 'merged';
    }

    signedInAs = check.username;
    writeStoredUser(signedInAs);
    await pushNow();
    return { username: check.username, outcome };
  } catch (err) {
    setStatus('error', err.message);
    throw err;
  }
}

/** Stops syncing. Progress stays on this device untouched. */
export function signOut() {
  signedInAs = null;
  writeStoredUser(null);
  clearTimeout(pushTimer);
  pushTimer = null;
  setStatus(isCloudConfigured() ? 'idle' : 'off');
}

export async function pushNow() {
  if (!signedInAs || !isCloudConfigured()) return false;
  if (pushing) {
    pushAgain = true;
    return false;
  }
  pushing = true;
  setStatus('syncing');
  try {
    await saveProfile(signedInAs, store.syncPayload());
    setStatus('saved');
    return true;
  } catch (err) {
    setStatus(navigator && navigator.onLine === false ? 'offline' : 'error', err.message);
    return false;
  } finally {
    pushing = false;
    if (pushAgain) {
      pushAgain = false;
      schedulePush();
    }
  }
}

export function schedulePush() {
  if (!signedInAs || !isCloudConfigured()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushNow();
  }, PUSH_DEBOUNCE_MS);
}

/** Pull the server copy and merge it in — used by "Sync now". */
export async function pullNow() {
  if (!signedInAs || !isCloudConfigured()) return false;
  setStatus('syncing');
  try {
    const remote = await fetchProfile(signedInAs);
    if (remote && remote.state) {
      store.adoptState(store.mergeStates(store.getState(), remote.state));
    }
    await pushNow();
    return true;
  } catch (err) {
    setStatus('error', err.message);
    return false;
  }
}

/**
 * Wire sync into the app: pull once at startup, then push on every change.
 * Safe to call when nothing is configured — it just reports 'off'.
 */
export function startSync() {
  // Register unconditionally: schedulePush already no-ops when there is no
  // project or nobody signed in, and wiring it here means connecting a project
  // later never leaves the app saving locally while claiming to sync.
  store.onChange(() => schedulePush());

  if (!isCloudConfigured()) {
    setStatus('off');
    return;
  }

  if (typeof document !== 'undefined') {
    // A tab being hidden or closed is the last chance to flush.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && signedInAs) flush();
    });
    window.addEventListener('pagehide', () => {
      if (signedInAs) flush();
    });
    window.addEventListener('online', () => {
      if (signedInAs) pushNow();
    });
  }

  if (signedInAs) pullNow();
  else setStatus('idle');
}

/**
 * Best-effort save on the way out. fetch with keepalive survives the unload
 * that a normal request would not.
 */
function flush() {
  const { url, key } = supabaseConfig();
  if (!url || !key || !signedInAs) return;
  clearTimeout(pushTimer);
  pushTimer = null;
  try {
    fetch(`${url}/rest/v1/rpc/save_profile`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_username: signedInAs, p_state: store.syncPayload() }),
      keepalive: true,
    }).catch(() => {});
  } catch (err) {
    /* nothing useful to do while the page is going away */
  }
}
