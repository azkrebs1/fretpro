/* Scales: interval formulas, box shapes on the neck, and runs through them.
 *
 * Shapes are generated rather than hand-typed. For each string, take the
 * lowest N scale tones at or above the box's starting fret; N is 2 for
 * pentatonic-sized scales and 3 for seven-note scales. For minor pentatonic
 * that reproduces the five familiar CAGED boxes exactly, and for the major
 * scale it produces the three-notes-per-string shapes — both real systems
 * guitarists already use, with no risk of a mistyped fret.
 */

import { midiAt, pitchClass, noteName, TUNINGS } from './theory.js';

export const SCALE_MAX_FRET = 20;

export const SCALES = {
  minorPentatonic: {
    id: 'minorPentatonic',
    name: 'Minor pentatonic',
    short: 'min pent',
    intervals: [0, 3, 5, 7, 10],
    degrees: ['1', '♭3', '4', '5', '♭7'],
    blurb: 'Five notes, one shape, and most of rock and blues.',
  },
  majorPentatonic: {
    id: 'majorPentatonic',
    name: 'Major pentatonic',
    short: 'maj pent',
    intervals: [0, 2, 4, 7, 9],
    degrees: ['1', '2', '3', '5', '6'],
    blurb: 'The same five shapes, heard from a different root. Brighter, country and pop.',
  },
  blues: {
    id: 'blues',
    name: 'Blues scale',
    short: 'blues',
    intervals: [0, 3, 5, 6, 7, 10],
    degrees: ['1', '♭3', '4', '♭5', '5', '♭7'],
    blurb: 'Minor pentatonic with the flat five wedged in — the note that makes it growl.',
  },
  major: {
    id: 'major',
    name: 'Major scale',
    short: 'major',
    intervals: [0, 2, 4, 5, 7, 9, 11],
    degrees: ['1', '2', '3', '4', '5', '6', '7'],
    blurb: 'Seven notes that everything else is measured against.',
  },
  naturalMinor: {
    id: 'naturalMinor',
    name: 'Natural minor',
    short: 'nat minor',
    intervals: [0, 2, 3, 5, 7, 8, 10],
    degrees: ['1', '2', '♭3', '4', '5', '♭6', '♭7'],
    blurb: 'The major scale starting from its sixth degree. Sad by default.',
  },
  mixolydian: {
    id: 'mixolydian',
    name: 'Mixolydian',
    short: 'mixo',
    intervals: [0, 2, 4, 5, 7, 9, 10],
    degrees: ['1', '2', '3', '4', '5', '6', '♭7'],
    blurb: 'Major with a flat seventh. The dominant-chord sound.',
  },
  dorian: {
    id: 'dorian',
    name: 'Dorian',
    short: 'dorian',
    intervals: [0, 2, 3, 5, 7, 9, 10],
    degrees: ['1', '2', '♭3', '4', '5', '6', '♭7'],
    blurb: 'Minor with a raised sixth. Funk, jazz and Santana.',
  },
};

export const getScale = (id) => SCALES[id];

/** How many notes sit on each string in a generated box. */
export function notesPerString(scale) {
  return scale.intervals.length <= 6 ? 2 : 3;
}

export const boxCount = (scale) => scale.intervals.length;

/** Pitch classes of the scale, as a Set for fast membership tests. */
export function scalePitchClasses(scaleId, rootPc) {
  const scale = SCALES[scaleId];
  return new Set(scale.intervals.map((i) => pitchClass(rootPc + i)));
}

export function isInScale(scaleId, rootPc, midi) {
  return scalePitchClasses(scaleId, rootPc).has(pitchClass(midi));
}

/** '1', '♭3', … or null when the note is outside the scale. */
export function degreeOf(scaleId, rootPc, midi) {
  const scale = SCALES[scaleId];
  const offset = pitchClass(pitchClass(midi) - rootPc);
  const index = scale.intervals.indexOf(offset);
  return index === -1 ? null : scale.degrees[index];
}

/** Lowest fret on `string` whose pitch class is `pc`, at or above `from`. */
function firstFretFor(tuning, string, pc, from = 0, maxFret = SCALE_MAX_FRET) {
  for (let fret = from; fret <= maxFret; fret++) {
    if (pitchClass(midiAt(tuning, string, fret)) === pc) return fret;
  }
  return null;
}

/** Lowest fret on `string` at or above `fromFret` playing a pitch >= minMidi. */
function findFret(tuning, string, pcs, minMidi, maxFret) {
  for (let fret = 0; fret <= maxFret; fret++) {
    const midi = midiAt(tuning, string, fret);
    if (midi >= minMidi && pcs.has(pitchClass(midi))) return { fret, midi };
  }
  return null;
}

/** The pitch a box opens on: the root on the 6th string, advanced by box number. */
export function boxStartMidi(scaleId, rootPc, boxIndex, tuning = 'standard') {
  const pcs = scalePitchClasses(scaleId, rootPc);
  const rootFret = firstFretFor(tuning, 6, rootPc, 0, 11);
  if (rootFret == null) return null;
  let midi = midiAt(tuning, 6, rootFret);
  for (let i = 0; i < boxIndex; i++) {
    const next = findFret(tuning, 6, pcs, midi + 1, SCALE_MAX_FRET);
    if (!next) return null;
    midi = next.midi;
  }
  return midi;
}

export function boxStartFret(scaleId, rootPc, boxIndex, tuning = 'standard') {
  const midi = boxStartMidi(scaleId, rootPc, boxIndex, tuning);
  if (midi == null) return null;
  return midi - TUNINGS[tuning].open[5];
}

/**
 * Every position in one box, low string to high.
 *
 * A box is one continuous climb through the scale: each string picks up at the
 * next scale tone above where the previous string stopped, taking two notes per
 * string for pentatonic shapes and three for seven-note scales. That is the
 * actual definition of both the CAGED boxes and the three-notes-per-string
 * system, so the leaning shapes (box 2 dipping to the 7th fret on the A string,
 * the B-string shift) fall out on their own instead of needing special cases.
 *
 * @returns {Array<{string:number, fret:number, midi:number, degree:string, isRoot:boolean}>}
 */
export function boxPositions(scaleId, rootPc, boxIndex, tuning = 'standard', maxFret = SCALE_MAX_FRET) {
  const scale = SCALES[scaleId];
  const pcs = scalePitchClasses(scaleId, rootPc);
  const perString = notesPerString(scale);
  const start = boxStartMidi(scaleId, rootPc, boxIndex, tuning);
  if (start == null) return [];

  const out = [];
  let cursor = start;

  for (let string = 6; string >= 1; string--) {
    for (let n = 0; n < perString; n++) {
      const hit = findFret(tuning, string, pcs, cursor, maxFret);
      if (!hit) return out;
      out.push({
        string,
        fret: hit.fret,
        midi: hit.midi,
        degree: degreeOf(scaleId, rootPc, hit.midi),
        isRoot: pitchClass(hit.midi) === rootPc,
      });
      cursor = hit.midi + 1;
    }
  }
  return out;
}

/** Box notes in playing order: lowest pitch first, thickest string breaking ties. */
export function ascending(positions) {
  return [...positions].sort((a, b) => a.midi - b.midi || b.string - a.string);
}

export function descending(positions) {
  return ascending(positions).reverse();
}

/**
 * Root up to the next root — the six-note run to learn before the whole box.
 * Falls back to the first octave's worth if the box has no second root.
 */
export function oneOctave(positions, rootPc) {
  const sorted = ascending(positions);
  const startIndex = sorted.findIndex((p) => pitchClass(p.midi) === rootPc);
  if (startIndex === -1) return sorted;
  const run = [sorted[startIndex]];
  for (let i = startIndex + 1; i < sorted.length; i++) {
    run.push(sorted[i]);
    if (pitchClass(sorted[i].midi) === rootPc && sorted[i].midi > sorted[startIndex].midi) break;
  }
  return run;
}

/** Drop a step whose pitch repeats the previous one, so a run never stalls. */
export function dedupeRun(steps) {
  return steps.filter((step, i) => i === 0 || step.midi !== steps[i - 1].midi);
}

export const rootsIn = (positions) => positions.filter((p) => p.isRoot);

/** The fret window a box occupies, for drawing just the useful part of the neck. */
export function boxWindow(positions, pad = 1) {
  if (!positions.length) return { minFret: 0, maxFret: 12 };
  const frets = positions.map((p) => p.fret);
  return {
    minFret: Math.max(0, Math.min(...frets) - pad),
    maxFret: Math.min(SCALE_MAX_FRET, Math.max(...frets) + pad),
  };
}

export function scaleTitle(scaleId, rootPc, spelling = 'sharps') {
  const root = noteName(60 + pitchClass(rootPc), spelling).split('/')[0];
  return `${root} ${SCALES[scaleId].name.toLowerCase()}`;
}

export function rootName(rootPc, spelling = 'sharps') {
  return noteName(60 + pitchClass(rootPc), spelling).split('/')[0];
}

/** Sanity guard used by the curriculum: does this shape fit on the neck? */
export function boxFits(scaleId, rootPc, boxIndex, tuning = 'standard', maxFret = SCALE_MAX_FRET) {
  const scale = SCALES[scaleId];
  const positions = boxPositions(scaleId, rootPc, boxIndex, tuning, maxFret);
  return positions.length === 6 * notesPerString(scale);
}

export const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
