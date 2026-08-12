/* Spaced repetition tuned for fretboard positions.

   A position moves up a box when you answer it correctly and quickly, and drops
   two boxes when you miss it. Boxes 0-1 come back inside the same session;
   boxes 2+ come back on later days. Mastery blends box, recent accuracy and
   speed, so a note you can only find slowly never reads as mastered. */

import { posKey } from './theory.js';

export const BOX_INTERVALS_MS = [
  0, // box 0 — again this session
  8 * 60 * 1000, // box 1 — a few minutes
  20 * 60 * 60 * 1000, // box 2 — later today / tomorrow
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  21 * 24 * 60 * 60 * 1000,
];

export const MAX_BOX = BOX_INTERVALS_MS.length - 1;

/** Answering inside this window counts as fluent recall, not a slow grind. */
export const FLUENT_MS = 3500;

export function newRecord() {
  return {
    box: 0,
    reps: 0,
    correct: 0,
    lapses: 0,
    avgMs: 0,
    fastest: null,
    due: 0,
    lastAt: null,
    recent: [], // last 10 attempts, 1 = right first try
  };
}

export function isNew(record) {
  return !record || record.reps === 0;
}

/**
 * Fold one attempt into a record.
 * @param {object|null} record existing record, or null for a first meeting
 * @param {boolean} correct right on the first attempt
 * @param {number} ms time from prompt to the correct answer
 */
export function grade(record, correct, ms) {
  const r = record ? { ...record, recent: [...record.recent] } : newRecord();
  const now = Date.now();
  r.reps += 1;
  r.lastAt = now;
  r.recent.push(correct ? 1 : 0);
  if (r.recent.length > 10) r.recent = r.recent.slice(-10);

  if (correct) {
    r.correct += 1;
    r.avgMs = r.avgMs ? Math.round(r.avgMs * 0.7 + ms * 0.3) : ms;
    r.fastest = r.fastest == null ? ms : Math.min(r.fastest, ms);
    // Only fluent answers earn a box; slow-but-right holds position.
    r.box = ms <= FLUENT_MS ? Math.min(MAX_BOX, r.box + 1) : r.box;
  } else {
    r.lapses += 1;
    r.box = Math.max(0, r.box - 2);
  }
  r.due = now + BOX_INTERVALS_MS[r.box];
  return r;
}

export function recentAccuracy(record) {
  if (!record || !record.recent.length) return 0;
  return record.recent.reduce((a, b) => a + b, 0) / record.recent.length;
}

/** 0-1. Needs box progress, recent accuracy and a fluent average time. */
export function mastery(record) {
  if (!record || record.reps === 0) return 0;
  const boxPart = record.box / MAX_BOX;
  const accPart = recentAccuracy(record);
  const speedPart = record.avgMs ? Math.max(0, Math.min(1, (FLUENT_MS * 1.6 - record.avgMs) / (FLUENT_MS * 1.3))) : 0;
  return Math.max(0, Math.min(1, boxPart * 0.5 + accPart * 0.35 + speedPart * 0.15));
}

export function isDue(record, now = Date.now()) {
  return !record || record.reps === 0 || record.due <= now;
}

/**
 * Pick the next position to prompt.
 * Weights: unseen notes first, then overdue, then weak, and never the note we
 * just asked (unless the pool has only one).
 */
export function pickNext(pool, getRecord, lastKey, now = Date.now()) {
  const candidates = pool.filter((n) => pool.length === 1 || posKey(n.string, n.fret) !== lastKey);
  const weights = candidates.map((n) => {
    const rec = getRecord(posKey(n.string, n.fret));
    if (isNew(rec)) return 100;
    let w = 6;
    const overdueMs = now - rec.due;
    if (overdueMs > 0) w += Math.min(40, 8 + overdueMs / (60 * 1000));
    w += (MAX_BOX - rec.box) * 6;
    w += (1 - recentAccuracy(rec)) * 30;
    if (rec.recent[rec.recent.length - 1] === 0) w += 15;
    return Math.max(1, w);
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/** How many positions in `pool` are due right now — drives the "review" badge. */
export function dueCount(pool, getRecord, now = Date.now()) {
  return pool.filter((n) => isDue(getRecord(posKey(n.string, n.fret)), now)).length;
}
