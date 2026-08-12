/* Fretboard math and note naming. String 1 = thinnest (high E). */

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const TUNINGS = {
  standard: { label: 'Standard E', open: [64, 59, 55, 50, 45, 40] },
  halfDown: { label: 'Eb standard', open: [63, 58, 54, 49, 44, 39] },
  dropD: { label: 'Drop D', open: [64, 59, 55, 50, 45, 38] },
  openG: { label: 'Open G', open: [62, 59, 55, 50, 43, 38] },
};

export const MAX_FRET = 17;

/** MIDI note number for a string/fret in a tuning. */
export function midiAt(tuning, string, fret) {
  return TUNINGS[tuning].open[string - 1] + fret;
}

export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidiFloat(freq, a4 = 440) {
  return 69 + 12 * Math.log2(freq / a4);
}

export const pitchClass = (midi) => ((midi % 12) + 12) % 12;
export const octaveOf = (midi) => Math.floor(midi / 12) - 1;

/** 'sharps' | 'flats' | 'both' */
export function noteName(midi, spelling = 'sharps') {
  const pc = pitchClass(midi);
  const sharp = SHARP_NAMES[pc];
  const flat = FLAT_NAMES[pc];
  if (sharp === flat) return sharp;
  if (spelling === 'flats') return flat;
  if (spelling === 'both') return `${sharp}/${flat}`;
  return sharp;
}

/** Split a name into letter + accidental so the display can style them apart. */
export function splitName(name) {
  const [primary] = name.split('/');
  return { letter: primary[0], accidental: primary.slice(1).replace('#', '♯').replace('b', '♭') };
}

export function noteNameWithOctave(midi, spelling = 'sharps') {
  return `${noteName(midi, spelling)}${octaveOf(midi)}`;
}

export const isNatural = (midi) => [0, 2, 4, 5, 7, 9, 11].includes(pitchClass(midi));

/** Stable key for a board position, used by the SRS store. */
export const posKey = (string, fret) => `s${string}f${fret}`;

export function parsePosKey(key) {
  const m = /^s(\d+)f(\d+)$/.exec(key);
  return m ? { string: Number(m[1]), fret: Number(m[2]) } : null;
}

export const STRING_LABELS = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

/** Human description of a string, e.g. "6th string (low E)". */
export function stringLabel(tuning, string, spelling = 'sharps') {
  const open = noteName(midiAt(tuning, string, 0), spelling);
  return `${STRING_LABELS[string - 1]} string — ${open}`;
}

/** Every fret on `string` whose pitch class matches `midi`, within range. */
export function positionsForPitchClass(tuning, string, pc, maxFret = MAX_FRET) {
  const out = [];
  for (let f = 0; f <= maxFret; f++) {
    if (pitchClass(midiAt(tuning, string, f)) === pc) out.push(f);
  }
  return out;
}

export function centsOff(freq, midi, a4 = 440) {
  return 1200 * Math.log2(freq / midiToFreq(midi, a4));
}

/**
 * Signed distance in semitones from a played pitch to the nearest octave of a
 * target, so an E played two octaves up reads as 0 rather than 24.
 */
export function octaveReducedDistance(playedMidiFloat, targetMidi) {
  const d = playedMidiFloat - targetMidi;
  return d - 12 * Math.round(d / 12);
}

/**
 * Does a played pitch count as the target note?
 *
 * Works on the un-rounded pitch, so the acceptance window can be wider than
 * the ±50 cents you get from snapping to the nearest semitone first. A wrong
 * fret is 100 cents away, so anything below that still tells the two apart.
 *
 * @param {number} playedMidiFloat detected pitch, fractional MIDI
 * @param {number} targetMidi the note being asked for
 * @param {object} [opts]
 * @param {boolean} [opts.strict] require the exact string, not just the note
 * @param {number} [opts.toleranceCents] half-width of the acceptance window
 */
export function matchesTarget(playedMidiFloat, targetMidi, { strict = false, toleranceCents = 70 } = {}) {
  const tolerance = Math.max(5, toleranceCents);
  const distance = strict ? playedMidiFloat - targetMidi : octaveReducedDistance(playedMidiFloat, targetMidi);
  // Compared in cents with a hair of slack, so a value exactly on the boundary
  // is not rejected by floating-point drift.
  return Math.abs(distance) * 100 <= tolerance + 1e-6;
}
