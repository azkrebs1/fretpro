/* Everything the app remembers, in localStorage. One JSON blob, versioned. */

const KEY = 'fretpro.state.v1';

/** Absent under Node (tests) and in some private-browsing modes. */
const storage = (() => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (err) {
    return null;
  }
})();

export const DEFAULT_SETTINGS = {
  tuning: 'standard',
  spelling: 'sharps', // sharps | flats | both
  inputMode: 'mic', // mic | tap
  timerSeconds: 6, // 0 = no clock
  lessonsTightenTimer: true,
  octaveStrictness: 'lenient', // strict = must be the exact string; lenient = any octave of the right note
  pitchTolerance: 70, // cents either side of the target that still counts
  detectionSensitivity: 'normal', // relaxed | normal | strict — see SENSITIVITY
  a4: 440,
  promptStyle: 'mixed', // name | position | mixed
  calibrateBeforeSession: 'auto', // auto (when stale) | always | never
  countIn: true,
  sound: true,
  flipBoard: false, // false = high E on top (tab layout)
  dailyGoal: 2, // sessions per day
  deviceId: null,
};

export const DEFAULT_CALIBRATION = {
  noiseFloor: null, // RMS of the room
  gate: null, // RMS a note must exceed to be judged
  at: null,
  sampleRate: null,
};

function blank() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    calibration: { ...DEFAULT_CALIBRATION },
    progress: {}, // lessonId -> { level, bestAccuracy, sessions, lastAt }
    notes: {}, // posKey -> srs record
    stats: {
      xp: 0,
      sessions: 0,
      prompts: 0,
      correct: 0,
      streak: 0,
      longestStreak: 0,
      lastPracticeDay: null,
      dayCounts: {}, // 'YYYY-MM-DD' -> prompts answered
      history: [], // recent session summaries
    },
  };
}

let state = load();

function load() {
  try {
    const raw = storage && storage.getItem(KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw);
    const base = blank();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      calibration: { ...base.calibration, ...(parsed.calibration || {}) },
      stats: { ...base.stats, ...(parsed.stats || {}) },
      progress: parsed.progress || {},
      notes: parsed.notes || {},
    };
  } catch (err) {
    console.warn('Could not read saved progress, starting fresh.', err);
    return blank();
  }
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow();
  }, 120);
}

export function saveNow() {
  clearTimeout(saveTimer);
  state.updatedAt = Date.now();
  for (const fn of changeListeners) {
    try {
      fn(state);
    } catch (err) {
      console.warn('A change listener failed.', err);
    }
  }
  if (!storage) return;
  try {
    storage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not save progress.', err);
  }
}

const changeListeners = new Set();

/** Called after every save — how the cloud sync knows there is work to push. */
export function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

export const getState = () => state;
export const settings = () => state.settings;
export const calibration = () => state.calibration;
export const stats = () => state.stats;

export function setSetting(key, value) {
  state.settings[key] = value;
  save();
}

export function setCalibration(next) {
  state.calibration = { ...state.calibration, ...next, at: Date.now() };
  save();
}

export function lessonProgress(lessonId) {
  return state.progress[lessonId] || { level: 0, bestAccuracy: 0, sessions: 0, lastAt: null };
}

export function setLessonProgress(lessonId, patch) {
  state.progress[lessonId] = { ...lessonProgress(lessonId), ...patch };
  save();
}

export function noteRecord(key) {
  return state.notes[key] || null;
}

export function putNoteRecord(key, record) {
  state.notes[key] = record;
  save();
}

export const allNoteRecords = () => state.notes;

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayDiff(a, b) {
  const parse = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(b) - parse(a)) / 86400000);
}

/** Called once per session; keeps the daily streak honest across midnight. */
export function touchStreak() {
  const today = todayKey();
  const s = state.stats;
  if (s.lastPracticeDay === today) return s.streak;
  const gap = s.lastPracticeDay ? dayDiff(s.lastPracticeDay, today) : null;
  s.streak = gap === 1 ? s.streak + 1 : 1;
  s.longestStreak = Math.max(s.longestStreak, s.streak);
  s.lastPracticeDay = today;
  save();
  return s.streak;
}

/** A streak only counts while today or yesterday has practice in it. */
export function currentStreak() {
  const s = state.stats;
  if (!s.lastPracticeDay) return 0;
  const gap = dayDiff(s.lastPracticeDay, todayKey());
  return gap <= 1 ? s.streak : 0;
}

export function addXp(amount) {
  state.stats.xp += amount;
  save();
  return state.stats.xp;
}

export function recordDayActivity(prompts) {
  const k = todayKey();
  state.stats.dayCounts[k] = (state.stats.dayCounts[k] || 0) + prompts;
  save();
}

export function pushHistory(summary) {
  state.stats.history.unshift(summary);
  state.stats.history = state.stats.history.slice(0, 60);
  save();
}

export function resetAll() {
  state = blank();
  saveNow();
}

export function exportJson() {
  return JSON.stringify(state, null, 2);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !parsed.settings) throw new Error('That file is not a FretPro backup.');
  if (storage) storage.setItem(KEY, JSON.stringify(parsed));
  state = load();
}

/* ---------- cloud sync ------------------------------------------------ */

/**
 * What gets uploaded. Calibration and deviceId stay on this device on purpose:
 * a noise gate measured on one laptop's microphone is wrong for another.
 */
export function syncPayload(source = state) {
  const { deviceId, ...settings } = source.settings;
  return {
    version: source.version,
    updatedAt: source.updatedAt || 0,
    settings,
    progress: source.progress,
    notes: source.notes,
    stats: source.stats,
  };
}

const maxNum = (a, b) => Math.max(Number(a) || 0, Number(b) || 0);

/**
 * Combine two saved states without losing progress from either side.
 *
 * Practice history is additive, so nearly everything resolves by taking the
 * better value rather than the newer one — two devices used offline on the
 * same day should end up with the sum of the work, not whichever synced last.
 * Only genuinely single-valued things (settings) fall back to "newer wins".
 *
 * @param {object} local the state on this device
 * @param {object} remote the state fetched from Supabase
 * @returns {object} a new merged state; neither input is modified
 */
export function mergeStates(local, remote) {
  if (!remote) return local;
  if (!local) return remote;

  const localNewer = (local.updatedAt || 0) >= (remote.updatedAt || 0);
  const base = blank();

  // Settings are single-valued preferences, so the newer side wins outright.
  const preferred = localNewer ? local : remote;
  const settings = { ...base.settings, ...(preferred.settings || {}) };
  // deviceId always belongs to this device.
  settings.deviceId = (local.settings && local.settings.deviceId) || settings.deviceId;

  // Lesson levels only ever go up.
  const progress = {};
  for (const id of new Set([...Object.keys(local.progress || {}), ...Object.keys(remote.progress || {})])) {
    const a = (local.progress || {})[id] || {};
    const b = (remote.progress || {})[id] || {};
    progress[id] = {
      level: maxNum(a.level, b.level),
      bestAccuracy: Math.max(Number(a.bestAccuracy) || 0, Number(b.bestAccuracy) || 0),
      sessions: maxNum(a.sessions, b.sessions),
      lastAt: maxNum(a.lastAt, b.lastAt) || null,
    };
  }

  // A note's record is a snapshot of one schedule, so take it whole from
  // whichever side saw the note most recently rather than blending fields.
  const notes = {};
  for (const key of new Set([...Object.keys(local.notes || {}), ...Object.keys(remote.notes || {})])) {
    const a = (local.notes || {})[key];
    const b = (remote.notes || {})[key];
    if (!a) notes[key] = b;
    else if (!b) notes[key] = a;
    else if ((a.lastAt || 0) !== (b.lastAt || 0)) notes[key] = (a.lastAt || 0) > (b.lastAt || 0) ? a : b;
    else notes[key] = (a.reps || 0) >= (b.reps || 0) ? a : b;
  }

  const ls = local.stats || {};
  const rs = remote.stats || {};
  const dayCounts = {};
  for (const day of new Set([...Object.keys(ls.dayCounts || {}), ...Object.keys(rs.dayCounts || {})])) {
    dayCounts[day] = maxNum((ls.dayCounts || {})[day], (rs.dayCounts || {})[day]);
  }

  const seen = new Set();
  const history = [...(ls.history || []), ...(rs.history || [])]
    .filter((entry) => {
      const id = `${entry.at}:${entry.lessonId || entry.title}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 60);

  const lastPracticeDay =
    !ls.lastPracticeDay || !rs.lastPracticeDay
      ? ls.lastPracticeDay || rs.lastPracticeDay || null
      : ls.lastPracticeDay > rs.lastPracticeDay
      ? ls.lastPracticeDay
      : rs.lastPracticeDay;

  const stats = {
    ...base.stats,
    xp: maxNum(ls.xp, rs.xp),
    sessions: maxNum(ls.sessions, rs.sessions),
    prompts: maxNum(ls.prompts, rs.prompts),
    correct: maxNum(ls.correct, rs.correct),
    streak: maxNum(ls.streak, rs.streak),
    longestStreak: maxNum(ls.longestStreak, rs.longestStreak),
    lastPracticeDay,
    dayCounts,
    history,
  };

  return {
    version: base.version,
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
    settings,
    // Calibration is never synced, so it stays whatever this device measured.
    calibration: local.calibration || base.calibration,
    progress,
    notes,
    stats,
  };
}

/** Replace the running state, e.g. after merging in a profile from Supabase. */
export function adoptState(next) {
  state = { ...blank(), ...next, calibration: state.calibration };
  saveNow();
  return state;
}

/** True when nothing has been practised on this device yet. */
export function isEmptyProgress(source = state) {
  return (
    Object.keys(source.notes || {}).length === 0 &&
    Object.keys(source.progress || {}).length === 0 &&
    !(source.stats && source.stats.xp)
  );
}

/** XP curve: level N needs 100 + 60*(N-1) XP on top of the previous level. */
export function levelFromXp(xp) {
  let level = 1;
  let need = 100;
  let remaining = xp;
  while (remaining >= need) {
    remaining -= need;
    level += 1;
    need = 100 + 60 * (level - 1);
  }
  return { level, into: remaining, need };
}
