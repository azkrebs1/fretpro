/* The learning path: units of lessons, each lesson a small pool of board positions.
   Ordering is deliberate — three notes at a time on one string, widening to the
   whole neck. Every lesson has 3 levels; a lesson unlocks the next at level 1. */

import { midiAt, noteName, pitchClass, isNatural, MAX_FRET } from './theory.js';

/** Natural-note frets per string in standard tuning, frets 0-12. */
const NATURALS = {
  6: [0, 1, 3, 5, 7, 8, 10, 12],
  5: [0, 2, 3, 5, 7, 8, 10, 12],
  4: [0, 2, 3, 5, 7, 9, 10, 12],
  3: [0, 2, 4, 5, 7, 9, 10, 12],
  2: [0, 1, 3, 5, 6, 8, 10, 12],
  1: [0, 1, 3, 5, 7, 8, 10, 12],
};

const ACCIDENTALS = {
  6: [2, 4, 6, 9, 11],
  5: [1, 4, 6, 9, 11],
  4: [1, 4, 6, 8, 11],
  3: [1, 3, 6, 8, 11],
  2: [2, 4, 7, 9, 11],
  1: [2, 4, 6, 9, 11],
};

const STRING_NAME = { 6: 'Low E', 5: 'A', 4: 'D', 3: 'G', 2: 'B', 1: 'High E' };

const pos = (string, frets) => frets.map((fret) => ({ string, fret }));

/** Three-note chunks in fret order, so each lesson is one hand position. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function noteWord(string, fret) {
  return noteName(midiAt('standard', string, fret), 'sharps');
}

/** Build the per-string units: three 3-note lessons, then the whole string. */
function stringUnit(string, order) {
  const frets = NATURALS[string];
  const groups = chunk(frets, 3);
  const lessons = groups.map((g, i) => ({
    id: `s${string}-g${i + 1}`,
    title: g.map((f) => noteWord(string, f)).join(' · '),
    subtitle: `Frets ${g[0]}–${g[g.length - 1]} on the ${STRING_NAME[string]} string`,
    notes: pos(string, g),
    // Carry the previous groups along so earlier notes keep getting rehearsed.
    review: pos(string, groups.slice(0, i).flat()),
  }));

  lessons.push({
    id: `s${string}-all`,
    title: `All naturals`,
    subtitle: `Every natural note on the ${STRING_NAME[string]} string`,
    notes: pos(string, frets),
    review: [],
    milestone: true,
  });

  return {
    id: `string-${string}`,
    order,
    title: `${STRING_NAME[string]} string`,
    blurb: `Natural notes on the ${STRING_NAME[string]} string, open to the 12th fret.`,
    strings: [string],
    lessons,
  };
}

/** Mixed-string lesson: naturals across several strings at once. */
function mixUnit(id, order, title, blurb, strings) {
  const all = strings.flatMap((s) => pos(s, NATURALS[s]));
  return {
    id,
    order,
    title,
    blurb,
    strings,
    lessons: [
      {
        id: `${id}-low`,
        title: 'Open position',
        subtitle: `Frets 0–4 across ${strings.length} strings`,
        notes: all.filter((n) => n.fret <= 4),
        review: [],
      },
      {
        id: `${id}-mid`,
        title: 'Middle of the neck',
        subtitle: `Frets 5–9 across ${strings.length} strings`,
        notes: all.filter((n) => n.fret >= 5 && n.fret <= 9),
        review: [],
      },
      {
        id: `${id}-all`,
        title: 'Anywhere',
        subtitle: `Every natural note on ${strings.length} strings`,
        notes: all,
        review: [],
        milestone: true,
      },
    ],
  };
}

/** Sharps and flats, three at a time per string. */
function accidentalUnit(id, order, title, blurb, strings) {
  const lessons = [];
  for (const s of strings) {
    const groups = chunk(ACCIDENTALS[s], 3);
    groups.forEach((g, i) => {
      lessons.push({
        id: `${id}-s${s}-g${i + 1}`,
        title: g.map((f) => noteWord(s, f)).join(' · '),
        subtitle: `Sharps on the ${STRING_NAME[s]} string`,
        notes: pos(s, g),
        review: pos(s, ACCIDENTALS[s].slice(0, i * 3)),
      });
    });
  }
  lessons.push({
    id: `${id}-all`,
    title: 'All sharps and flats',
    subtitle: `Every accidental on ${strings.map((s) => STRING_NAME[s]).join(', ')}`,
    notes: strings.flatMap((s) => pos(s, ACCIDENTALS[s])),
    review: [],
    milestone: true,
  });
  return { id, order, title, blurb, strings, lessons };
}

function chromaticUnit(order) {
  const all = [];
  for (let s = 6; s >= 1; s--) for (let f = 0; f <= 12; f++) all.push({ string: s, fret: f });
  return {
    id: 'chromatic',
    order,
    title: 'Every note',
    blurb: 'All twelve notes, all six strings, open to the 12th fret.',
    strings: [1, 2, 3, 4, 5, 6],
    lessons: [
      {
        id: 'chromatic-low',
        title: 'Frets 0–4',
        subtitle: 'Naturals and accidentals in open position',
        notes: all.filter((n) => n.fret <= 4),
        review: [],
      },
      {
        id: 'chromatic-mid',
        title: 'Frets 5–8',
        subtitle: 'Naturals and accidentals, middle position',
        notes: all.filter((n) => n.fret >= 5 && n.fret <= 8),
        review: [],
      },
      {
        id: 'chromatic-high',
        title: 'Frets 9–12',
        subtitle: 'Naturals and accidentals up to the octave',
        notes: all.filter((n) => n.fret >= 9),
        review: [],
      },
      {
        id: 'chromatic-all',
        title: 'The whole neck',
        subtitle: 'Anything, anywhere, frets 0–12',
        notes: all,
        review: [],
        milestone: true,
      },
    ],
  };
}

function beyondTwelveUnit(order) {
  const all = [];
  for (let s = 6; s >= 1; s--) for (let f = 12; f <= MAX_FRET; f++) all.push({ string: s, fret: f });
  return {
    id: 'beyond-12',
    order,
    title: 'Past the octave',
    blurb: 'Frets 12 to 17 — the same shapes, one octave up.',
    strings: [1, 2, 3, 4, 5, 6],
    lessons: [
      {
        id: 'beyond-naturals',
        title: 'Naturals above 12',
        subtitle: 'Frets 12–17, natural notes only',
        notes: all.filter((n) => isNatural(midiAt('standard', n.string, n.fret))),
        review: [],
      },
      {
        id: 'beyond-all',
        title: 'Everything above 12',
        subtitle: 'Frets 12–17, all twelve notes',
        notes: all,
        review: [],
        milestone: true,
      },
    ],
  };
}

export const UNITS = (() => {
  const units = [];
  let order = 1;
  units.push(stringUnit(6, order++));
  units.push(stringUnit(5, order++));
  units.push(mixUnit('mix-65', order++, 'E and A together', 'Switch between the two lowest strings on demand.', [6, 5]));
  units.push(stringUnit(4, order++));
  units.push(stringUnit(3, order++));
  units.push(mixUnit('mix-6543', order++, 'The bass four', 'Naturals across the E, A, D and G strings.', [6, 5, 4, 3]));
  units.push(stringUnit(2, order++));
  units.push(stringUnit(1, order++));
  units.push(mixUnit('mix-all', order++, 'All six strings', 'Every natural note on the neck, frets 0 to 12.', [6, 5, 4, 3, 2, 1]));
  units.push(accidentalUnit('acc-bass', order++, 'Sharps: bass strings', 'The notes between the naturals on E, A and D.', [6, 5, 4]));
  units.push(accidentalUnit('acc-treble', order++, 'Sharps: treble strings', 'The notes between the naturals on G, B and high E.', [3, 2, 1]));
  units.push(chromaticUnit(order++));
  units.push(beyondTwelveUnit(order++));
  return units;
})();

/** Flat lesson list in path order, with unit context and prerequisites attached. */
export const LESSONS = (() => {
  const out = [];
  let prev = null;
  for (const unit of UNITS) {
    for (const lesson of unit.lessons) {
      const entry = {
        ...lesson,
        unitId: unit.id,
        unitTitle: unit.title,
        index: out.length,
        requires: prev,
        /** Notes drilled this lesson, newest first, plus carried-over review notes. */
        pool: dedupe([...lesson.notes, ...(lesson.review || [])]),
        newNotes: lesson.notes,
      };
      out.push(entry);
      prev = entry.id;
    }
  }
  return out;
})();

function dedupe(notes) {
  const seen = new Set();
  return notes.filter((n) => {
    const k = `${n.string}:${n.fret}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const LESSON_BY_ID = new Map(LESSONS.map((l) => [l.id, l]));
export const UNIT_BY_ID = new Map(UNITS.map((u) => [u.id, u]));

export const MAX_LEVEL = 3;

/** Requirements per level: more reps, tighter clock, higher bar. */
export const LEVEL_SPEC = [
  { level: 1, prompts: 12, minAccuracy: 0.75, timerScale: 1.0, xp: 20, label: 'Learn' },
  { level: 2, prompts: 15, minAccuracy: 0.85, timerScale: 0.8, xp: 30, label: 'Practice' },
  { level: 3, prompts: 20, minAccuracy: 0.9, timerScale: 0.65, xp: 45, label: 'Master' },
];

export function levelSpec(level) {
  return LEVEL_SPEC[Math.min(level, MAX_LEVEL - 1)] || LEVEL_SPEC[0];
}

/** Total distinct positions the path covers — the denominator for overall mastery. */
export const ALL_POSITIONS = (() => {
  const seen = new Map();
  for (const l of LESSONS) {
    for (const n of l.notes) seen.set(`${n.string}:${n.fret}`, n);
  }
  return [...seen.values()];
})();

/** Pitch classes present in a note pool, for building tap-mode answer choices. */
export function poolPitchClasses(pool) {
  return [...new Set(pool.map((n) => pitchClass(midiAt('standard', n.string, n.fret))))].sort((a, b) => a - b);
}
