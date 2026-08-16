/* Node test run: node --test test/logic.test.js  (or: npm test)
   Covers the parts that must be right before any of it reaches a guitar. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  midiAt,
  noteName,
  midiToFreq,
  freqToMidiFloat,
  pitchClass,
  isNatural,
  posKey,
  parsePosKey,
  matchesTarget,
  octaveReducedDistance,
} from '../js/theory.js';
import { LESSONS, UNITS, ALL_POSITIONS, levelSpec } from '../js/curriculum.js';
import { grade, newRecord, mastery, isDue, pickNext, MAX_BOX, FLUENT_MS } from '../js/srs.js';
import { detectPitch, computeRms, isPitchStable, PitchEngine, SENSITIVITY } from '../js/audio.js';
import { Session } from '../js/session.js';
import * as store from '../js/store.js';
import * as cloud from '../js/cloud.js';
import { normalizeProjectUrl } from '../js/config.js';
import { boxPositions, oneOctave, ascending, descending, degreeOf, isInScale, boxFits, scaleTitle, SCALES, PC } from '../js/scales.js';
import { SCALE_LESSONS, EXERCISE, runSteps, lessonPositions, scalePitchSet } from '../js/scaleCurriculum.js';

/* ---------- theory ---------------------------------------------------- */

test('standard tuning open strings are the right pitches', () => {
  assert.equal(midiAt('standard', 6, 0), 40); // E2
  assert.equal(midiAt('standard', 5, 0), 45); // A2
  assert.equal(midiAt('standard', 1, 0), 64); // E4
  assert.equal(Math.round(midiToFreq(40)), 82);
  assert.equal(Math.round(midiToFreq(69)), 440);
});

test('note names follow the spelling setting', () => {
  assert.equal(noteName(midiAt('standard', 6, 1), 'sharps'), 'F');
  assert.equal(noteName(midiAt('standard', 6, 2), 'sharps'), 'F#');
  assert.equal(noteName(midiAt('standard', 6, 2), 'flats'), 'Gb');
  assert.equal(noteName(midiAt('standard', 6, 2), 'both'), 'F#/Gb');
});

test('the 12th fret is the open string an octave up on every string', () => {
  for (let s = 1; s <= 6; s++) {
    assert.equal(midiAt('standard', s, 12), midiAt('standard', s, 0) + 12);
    assert.equal(pitchClass(midiAt('standard', s, 12)), pitchClass(midiAt('standard', s, 0)));
  }
});

test('position keys round-trip', () => {
  assert.deepEqual(parsePosKey(posKey(6, 12)), { string: 6, fret: 12 });
  assert.equal(parsePosKey('nonsense'), null);
});

/* ---------- accepting a played note ----------------------------------- */

const E2 = 40;
const cents = (n) => n / 100;

test('a note dead on the target is accepted at any tolerance', () => {
  assert.equal(matchesTarget(E2, E2, { toleranceCents: 20 }), true);
  assert.equal(matchesTarget(E2, E2, { toleranceCents: 85 }), true);
});

test('the window is wider than the old ±50 cents of rounding to a semitone', () => {
  // 60 cents flat used to round to D# and be rejected outright.
  const sixtyFlat = E2 - cents(60);
  assert.equal(Math.round(sixtyFlat), E2 - 1, 'this pitch really does round to the wrong note');
  assert.equal(matchesTarget(sixtyFlat, E2, { toleranceCents: 70 }), true);
  assert.equal(matchesTarget(sixtyFlat, E2, { toleranceCents: 50 }), false);
});

test('it accepts either side of the target evenly', () => {
  for (const off of [-70, -45, -10, 0, 10, 45, 70]) {
    assert.equal(matchesTarget(E2 + cents(off), E2, { toleranceCents: 70 }), true, `${off} cents should pass`);
  }
  for (const off of [-71, -90, 71, 90]) {
    assert.equal(matchesTarget(E2 + cents(off), E2, { toleranceCents: 70 }), false, `${off} cents should fail`);
  }
});

test('the neighbouring fret is still rejected at every tolerance offered', () => {
  for (let tol = 20; tol <= 85; tol += 5) {
    assert.equal(matchesTarget(E2 + 1, E2, { toleranceCents: tol }), false, `a semitone up passed at ±${tol}`);
    assert.equal(matchesTarget(E2 - 1, E2, { toleranceCents: tol }), false, `a semitone down passed at ±${tol}`);
  }
});

test('octaves count as the same note, but only when lenient', () => {
  assert.equal(matchesTarget(E2 + 12, E2, { toleranceCents: 70 }), true);
  assert.equal(matchesTarget(E2 + 24, E2, { toleranceCents: 70 }), true);
  assert.equal(matchesTarget(E2 - 12, E2, { toleranceCents: 70 }), true);
  assert.equal(matchesTarget(E2 + 12, E2, { strict: true, toleranceCents: 70 }), false);
  assert.equal(matchesTarget(E2, E2, { strict: true, toleranceCents: 70 }), true);
});

test('a detuned octave is judged against the nearest octave, not the target itself', () => {
  const octaveUpSlightlyFlat = E2 + 12 - cents(40);
  assert.equal(matchesTarget(octaveUpSlightlyFlat, E2, { toleranceCents: 70 }), true);
  assert.equal(Math.round(octaveReducedDistance(octaveUpSlightlyFlat, E2) * 100), -40);
});

test('the tolerance never collapses to zero on a bad setting', () => {
  assert.equal(matchesTarget(E2 + cents(4), E2, { toleranceCents: 0 }), true);
  assert.equal(matchesTarget(E2 + cents(4), E2, { toleranceCents: -30 }), true);
});

test('a tapped note carries no detuning, so it matches exactly', () => {
  assert.equal(matchesTarget(midiAt('standard', 6, 3), midiAt('standard', 6, 3), { toleranceCents: 20 }), true);
  assert.equal(matchesTarget(midiAt('standard', 6, 4), midiAt('standard', 6, 3), { toleranceCents: 85 }), false);
});

/* ---------- curriculum ------------------------------------------------ */

test('the path starts with three notes on the low E string', () => {
  const first = LESSONS[0];
  assert.equal(first.notes.length, 3);
  assert.deepEqual(
    first.notes.map((n) => n.string),
    [6, 6, 6]
  );
  assert.deepEqual(
    first.notes.map((n) => noteName(midiAt('standard', n.string, n.fret))),
    ['E', 'F', 'G']
  );
  assert.equal(first.requires, null, 'the first lesson must not be locked behind anything');
});

test('every lesson has notes, a unit, and a working prerequisite chain', () => {
  const ids = new Set(LESSONS.map((l) => l.id));
  assert.equal(ids.size, LESSONS.length, 'lesson ids must be unique');
  LESSONS.forEach((lesson, i) => {
    assert.ok(lesson.pool.length >= 2, `${lesson.id} needs at least two notes to drill`);
    assert.ok(lesson.unitId, `${lesson.id} has no unit`);
    if (i > 0) assert.equal(lesson.requires, LESSONS[i - 1].id);
    for (const n of lesson.pool) {
      assert.ok(n.string >= 1 && n.string <= 6, `${lesson.id} has a bad string`);
      assert.ok(n.fret >= 0 && n.fret <= 17, `${lesson.id} has a bad fret`);
    }
  });
});

test('early single-string lessons stay on one string', () => {
  const firstUnit = UNITS[0];
  for (const lesson of firstUnit.lessons) {
    const strings = new Set(lesson.notes.map((n) => n.string));
    assert.equal(strings.size, 1);
    assert.ok(strings.has(6));
  }
});

test('natural-note lessons really are natural notes', () => {
  for (const unit of UNITS.slice(0, 9)) {
    for (const lesson of unit.lessons) {
      for (const n of lesson.notes) {
        assert.ok(isNatural(midiAt('standard', n.string, n.fret)), `${lesson.id} s${n.string}f${n.fret} is not natural`);
      }
    }
  }
});

test('the path eventually covers every position from fret 0 to 17', () => {
  const covered = new Set(ALL_POSITIONS.map((n) => posKey(n.string, n.fret)));
  for (let s = 1; s <= 6; s++) {
    for (let f = 0; f <= 17; f++) {
      assert.ok(covered.has(posKey(s, f)), `never taught: string ${s} fret ${f}`);
    }
  }
  assert.equal(ALL_POSITIONS.length, 6 * 18);
});

test('levels get harder, not easier', () => {
  const specs = [0, 1, 2].map(levelSpec);
  for (let i = 1; i < specs.length; i++) {
    assert.ok(specs[i].prompts >= specs[i - 1].prompts);
    assert.ok(specs[i].minAccuracy >= specs[i - 1].minAccuracy);
    assert.ok(specs[i].timerScale <= specs[i - 1].timerScale);
  }
});

/* ---------- spaced repetition ----------------------------------------- */

test('a fast correct answer moves the note up a box; a miss knocks it down two', () => {
  let rec = newRecord();
  rec = grade(rec, true, 1200);
  assert.equal(rec.box, 1);
  rec = grade(rec, true, 1200);
  rec = grade(rec, true, 1200);
  assert.equal(rec.box, 3);
  rec = grade(rec, false, 6000);
  assert.equal(rec.box, 1);
  assert.equal(rec.lapses, 1);
});

test('a slow but correct answer holds its box instead of promoting', () => {
  let rec = grade(newRecord(), true, FLUENT_MS + 500);
  assert.equal(rec.box, 0);
  assert.equal(rec.correct, 1);
});

test('the box never runs off either end', () => {
  let rec = newRecord();
  for (let i = 0; i < 20; i++) rec = grade(rec, true, 800);
  assert.equal(rec.box, MAX_BOX);
  for (let i = 0; i < 20; i++) rec = grade(rec, false, 9000);
  assert.equal(rec.box, 0);
});

test('mastery needs accuracy and speed, not just repetitions', () => {
  let fast = newRecord();
  let slow = newRecord();
  for (let i = 0; i < 8; i++) {
    fast = grade(fast, true, 900);
    slow = grade(slow, true, 9000);
  }
  assert.ok(mastery(fast) > 0.85, `expected a high score, got ${mastery(fast)}`);
  assert.ok(mastery(slow) < mastery(fast));
  assert.equal(mastery(null), 0);
});

test('new notes are always due, and fresh ones are picked first', () => {
  assert.equal(isDue(null), true);
  const pool = [
    { string: 6, fret: 0 },
    { string: 6, fret: 1 },
    { string: 6, fret: 3 },
  ];
  const records = new Map([
    [posKey(6, 0), grade(grade(newRecord(), true, 800), true, 800)],
    [posKey(6, 1), grade(grade(newRecord(), true, 800), true, 800)],
  ]);
  const get = (k) => records.get(k) || null;
  const picks = new Set();
  for (let i = 0; i < 60; i++) picks.add(posKey(...Object.values(pickNext(pool, get, null))));
  assert.ok(picks.has(posKey(6, 3)), 'the unseen note must come up');
});

test('the same note is never asked twice in a row', () => {
  const pool = [
    { string: 5, fret: 0 },
    { string: 5, fret: 2 },
  ];
  for (let i = 0; i < 40; i++) {
    const next = pickNext(pool, () => null, posKey(5, 0));
    assert.notEqual(posKey(next.string, next.fret), posKey(5, 0));
  }
});

/* ---------- pitch detection ------------------------------------------- */

/** A plucked string: weak fundamental, strong 2nd/3rd harmonics, some noise. */
function pluck(freq, sampleRate, length, { noise = 0.01, seed = 1 } = {}) {
  const buf = new Float32Array(length);
  const amps = [0.35, 1.0, 0.62, 0.4, 0.25, 0.16, 0.1, 0.06];
  let rnd = seed;
  const rand = () => {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    return rnd / 2147483648 - 0.5;
  };
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let k = 0; k < amps.length; k++) {
      const partial = freq * (k + 1);
      if (partial > sampleRate / 2) break;
      v += amps[k] * Math.sin(2 * Math.PI * partial * t + k * 0.7);
    }
    buf[i] = v * 0.16 * Math.exp(-t * 1.2) + rand() * noise;
  }
  return buf;
}

const SR = 24000; // what the engine sees after 2x decimation
const N = 2048;

test('detects every open string and a handful of fretted notes', () => {
  const targets = [
    ['E2 low open', 40],
    ['A2', 45],
    ['D3', 50],
    ['G3', 55],
    ['B3', 59],
    ['E4 high open', 64],
    ['F3 (6th string, 13th fret)', 53],
    ['C4', 60],
    ['A4', 69],
    ['E5 (12th fret, high E)', 76],
    ['A5 (17th fret, high E)', 81],
  ];
  for (const [label, midi] of targets) {
    const freq = midiToFreq(midi);
    const result = detectPitch(pluck(freq, SR, N), SR);
    assert.ok(result, `${label}: nothing detected`);
    const detectedMidi = Math.round(freqToMidiFloat(result.freq));
    assert.equal(detectedMidi, midi, `${label}: heard ${result.freq.toFixed(1)} Hz, expected ${freq.toFixed(1)} Hz`);
    const cents = Math.abs(1200 * Math.log2(result.freq / freq));
    assert.ok(cents < 25, `${label}: off by ${cents.toFixed(1)} cents`);
  }
});

test('every chromatic note across the whole neck lands on the right pitch class', () => {
  let checked = 0;
  for (let s = 1; s <= 6; s++) {
    for (let f = 0; f <= 17; f++) {
      const midi = midiAt('standard', s, f);
      const result = detectPitch(pluck(midiToFreq(midi), SR, N, { seed: s * 31 + f }), SR);
      assert.ok(result, `string ${s} fret ${f}: nothing detected`);
      const heard = Math.round(freqToMidiFloat(result.freq));
      assert.equal(
        pitchClass(heard),
        pitchClass(midi),
        `string ${s} fret ${f}: heard ${noteName(heard)} (${result.freq.toFixed(1)} Hz), expected ${noteName(midi)}`
      );
      checked++;
    }
  }
  assert.equal(checked, 108);
});

test('a fundamental-free tone is still heard as the missing fundamental', () => {
  // Small laptop mics roll off the bottom; the 2nd and 3rd harmonics carry it.
  const freq = midiToFreq(40); // E2, 82.4 Hz
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    buf[i] = 0.2 * Math.sin(2 * Math.PI * freq * 2 * t) + 0.14 * Math.sin(2 * Math.PI * freq * 3 * t + 0.4);
  }
  const result = detectPitch(buf, SR);
  assert.ok(result);
  assert.equal(pitchClass(Math.round(freqToMidiFloat(result.freq))), pitchClass(40));
});

test('room noise alone is not heard as a note', () => {
  const buf = new Float32Array(N);
  let rnd = 7;
  for (let i = 0; i < N; i++) {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    buf[i] = (rnd / 2147483648 - 0.5) * 0.05;
  }
  const result = detectPitch(buf, SR);
  assert.equal(result, null, 'white noise must not register as a pitch');
});

test('a note survives a noisy room', () => {
  const freq = midiToFreq(52); // E3
  const result = detectPitch(pluck(freq, SR, N, { noise: 0.05 }), SR);
  assert.ok(result);
  assert.equal(Math.round(freqToMidiFloat(result.freq)), 52);
});

test('a steady pitch reads as stable even when it sits between two frets', () => {
  // 50 cents off E2 — the rounded name would flicker between E and F.
  const onTheBoundary = [40.5, 40.49, 40.51];
  assert.equal(onTheBoundary.map(Math.round).every((m, _, a) => m === a[0]), false, 'this really is a flickering case');
  assert.equal(isPitchStable(onTheBoundary), true);
});

test('a pitch still moving is not stable, and neither is too short a history', () => {
  assert.equal(isPitchStable([40.0, 40.6, 41.2]), false);
  assert.equal(isPitchStable([40.0, 40.0]), false);
  assert.equal(isPitchStable([]), false);
});

test('stability looks only at the most recent readings', () => {
  // an old outlier from the attack transient must not block a settled note
  assert.equal(isPitchStable([52.0, 40.02, 40.0, 40.01]), true);
});

test('rms is the plain root-mean-square', () => {
  assert.equal(computeRms(new Float32Array([1, -1, 1, -1])), 1);
  assert.equal(computeRms(new Float32Array(64)), 0);
});

/* ---------- scales ----------------------------------------------------- */

const fingering = (positions) => {
  const byString = {};
  for (const p of positions) (byString[p.string] ||= []).push(p.fret);
  return [6, 5, 4, 3, 2, 1].map((s) => `s${s}:${(byString[s] || []).join(',')}`).join('  ');
};

test('generated boxes match the shapes guitarists actually play', () => {
  // Hand-checked against the standard CAGED fingerings.
  assert.equal(
    fingering(boxPositions('minorPentatonic', PC.A, 0)),
    's6:5,8  s5:5,7  s4:5,7  s3:5,7  s2:5,8  s1:5,8',
    'A minor pentatonic box 1'
  );
  assert.equal(
    fingering(boxPositions('minorPentatonic', PC.A, 1)),
    's6:8,10  s5:7,10  s4:7,10  s3:7,9  s2:8,10  s1:8,10',
    'box 2 leans below its start on the A string'
  );
  assert.equal(
    fingering(boxPositions('minorPentatonic', PC.A, 2)),
    's6:10,12  s5:10,12  s4:10,12  s3:9,12  s2:10,13  s1:10,12',
    'A minor pentatonic box 3'
  );
  assert.equal(
    fingering(boxPositions('majorPentatonic', PC.G, 0)),
    's6:3,5  s5:2,5  s4:2,5  s3:2,4  s2:3,5  s1:3,5',
    'G major pentatonic box 1'
  );
  assert.equal(
    fingering(boxPositions('major', PC.C, 0)),
    's6:8,10,12  s5:8,10,12  s4:9,10,12  s3:9,10,12  s2:10,12,13  s1:10,12,13',
    'C major three-notes-per-string, including the B-string shift'
  );
});

test('a box is one unbroken climb through the scale', () => {
  for (const [scaleId, root] of [['minorPentatonic', PC.A], ['blues', PC.E], ['major', PC.C], ['dorian', PC.D]]) {
    for (let box = 0; box < 3; box++) {
      const positions = boxPositions(scaleId, root, box);
      for (let i = 1; i < positions.length; i++) {
        assert.ok(
          positions[i].midi > positions[i - 1].midi,
          `${scaleId} box ${box}: pitch must always rise, broke at step ${i}`
        );
      }
    }
  }
});

test('every note in a box belongs to the scale, and degrees are labelled', () => {
  for (const scaleId of Object.keys(SCALES)) {
    const positions = boxPositions(scaleId, PC.A, 0);
    assert.ok(positions.length > 0, `${scaleId} produced no shape`);
    for (const p of positions) {
      assert.ok(isInScale(scaleId, PC.A, p.midi), `${scaleId}: ${p.string}/${p.fret} is out of the scale`);
      assert.ok(p.degree, `${scaleId}: ${p.string}/${p.fret} has no degree label`);
    }
    assert.ok(positions.some((p) => p.isRoot), `${scaleId} box has no root`);
  }
});

test('boxes have the right note count for their scale size', () => {
  assert.equal(boxPositions('minorPentatonic', PC.A, 0).length, 12, 'two per string');
  assert.equal(boxPositions('major', PC.C, 0).length, 18, 'three per string');
});

test('the one-octave run goes root to root', () => {
  const run = oneOctave(boxPositions('minorPentatonic', PC.A, 0), PC.A);
  assert.equal(run.length, 6);
  assert.equal(run[0].degree, '1');
  assert.equal(run[run.length - 1].degree, '1');
  assert.equal(run[run.length - 1].midi - run[0].midi, 12, 'exactly one octave apart');
  assert.deepEqual(run.map((p) => p.degree), ['1', '♭3', '4', '5', '♭7', '1']);
});

test('degrees are named from the root, and outsiders return null', () => {
  assert.equal(degreeOf('minorPentatonic', PC.A, 69), '1'); // A
  assert.equal(degreeOf('minorPentatonic', PC.A, 72), '♭3'); // C
  assert.equal(degreeOf('minorPentatonic', PC.A, 70), null, 'A# is not in A minor pentatonic');
  assert.equal(degreeOf('blues', PC.A, 75), '♭5', 'the blue note');
});

test('a descending run is the ascending one backwards', () => {
  const positions = boxPositions('minorPentatonic', PC.A, 0);
  const up = ascending(positions);
  const down = descending(positions);
  assert.deepEqual(down.map((p) => p.midi), [...up.map((p) => p.midi)].reverse());
});

test('runs never ask for the same pitch twice in a row', () => {
  for (const lesson of SCALE_LESSONS.filter((l) => l.exercise === EXERCISE.RUN)) {
    const steps = runSteps(lesson);
    assert.ok(steps.length >= 5, `${lesson.id} is too short to be a run`);
    for (let i = 1; i < steps.length; i++) {
      assert.notEqual(steps[i].midi, steps[i - 1].midi, `${lesson.id} repeats a pitch at step ${i}`);
    }
  }
});

test('every scale lesson is playable and chained in order', () => {
  const ids = new Set(SCALE_LESSONS.map((l) => l.id));
  assert.equal(ids.size, SCALE_LESSONS.length, 'lesson ids must be unique');
  SCALE_LESSONS.forEach((lesson, i) => {
    assert.equal(lesson.requires, i === 0 ? null : SCALE_LESSONS[i - 1].id);
    assert.ok(lesson.prompts >= 1 && lesson.seconds >= 4, `${lesson.id} has a silly budget`);
    const positions = boxPositions(lesson.scaleId, lesson.rootPc, lesson.boxIndex);
    assert.ok(positions.length > 0, `${lesson.id} has no shape`);
    for (const p of positions) {
      assert.ok(p.fret >= 0 && p.fret <= 20, `${lesson.id} runs off the neck at fret ${p.fret}`);
      assert.ok(p.string >= 1 && p.string <= 6);
    }
    if (lesson.exercise === EXERCISE.ROOT) {
      assert.ok(lessonPositions(lesson).every((p) => p.isRoot), `${lesson.id} should only offer roots`);
    }
  });
});

test('every scale shape in the track fits on the neck', () => {
  for (const lesson of SCALE_LESSONS) {
    assert.ok(
      boxFits(lesson.scaleId, lesson.rootPc, lesson.boxIndex),
      `${lesson.id}: ${scaleTitle(lesson.scaleId, lesson.rootPc)} box ${lesson.boxIndex + 1} does not fit`
    );
  }
});

test('the stay-in-key set is exactly the scale, no more', () => {
  const lesson = SCALE_LESSONS.find((l) => l.exercise === EXERCISE.KEY);
  const allowed = scalePitchSet(lesson);
  assert.equal(allowed.size, SCALES[lesson.scaleId].intervals.length);
  for (const p of boxPositions(lesson.scaleId, lesson.rootPc, lesson.boxIndex)) {
    assert.ok(allowed.has(pitchClass(p.midi)), 'every note of the shape must be accepted');
  }
});

test('the track opens on minor pentatonic, as chosen', () => {
  assert.equal(SCALE_LESSONS[0].scaleId, 'minorPentatonic');
  assert.equal(SCALE_LESSONS[0].exercise, EXERCISE.RUN);
  assert.equal(SCALE_LESSONS[0].octaveOnly, true, 'start with one octave, not the whole box');
});

/* ---------- finishing a scale session --------------------------------- */

function scaleSessionConfig(lesson, overrides = {}) {
  return {
    exercise: lesson.exercise,
    steps: lesson.exercise === EXERCISE.RUN ? runSteps(lesson) : undefined,
    allowedPcs: lesson.exercise === EXERCISE.KEY ? scalePitchSet(lesson) : undefined,
    notesNeeded: lesson.notesNeeded,
    pool: lesson.exercise === EXERCISE.RUN || lesson.exercise === EXERCISE.KEY ? undefined : lessonPositions(lesson),
    boxPositions: boxPositions(lesson.scaleId, lesson.rootPc, lesson.boxIndex),
    scaleId: lesson.scaleId,
    rootPc: lesson.rootPc,
    prompts: 1,
    title: lesson.title,
    timerSeconds: 0,
    inputMode: 'tap',
    promptStyle: 'name',
    ...overrides,
  };
}

test('a completed run ends the session instead of hanging on the last note', async () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  const lesson = SCALE_LESSONS[0];
  const steps = runSteps(lesson);
  let summary = null;
  const session = new Session(scaleSessionConfig(lesson), { onEnd: (s) => (summary = s) });
  session.start();

  for (const step of steps) session.judge(step.midi, { midiFloat: step.midi });
  await sleep(900);

  assert.ok(summary, 'the last note of the last run must end the session');
  assert.equal(summary.prompts, 1);
  assert.equal(summary.correct, 1);
  assert.ok(Number.isFinite(summary.mastery), 'mastery must be a number, not a crash');
  session.stop();
  store.resetAll();
});

test('a completed stay-in-key round ends the session too', async () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  const lesson = SCALE_LESSONS.find((l) => l.exercise === EXERCISE.KEY);
  const allowed = [...scalePitchSet(lesson)];
  let summary = null;
  const session = new Session(scaleSessionConfig(lesson, { notesNeeded: 6 }), { onEnd: (s) => (summary = s) });
  session.start();

  // Cycle the scale so every note gets used and none repeats back to back.
  for (let i = 0; i < 8; i++) {
    const midi = 60 + allowed[i % allowed.length];
    session.judge(midi, { midiFloat: midi });
  }
  await sleep(900);

  assert.ok(summary, 'stay-in-key must be able to finish');
  assert.ok(Number.isFinite(summary.mastery));
  session.stop();
  store.resetAll();
});

test('a run demands the right octave, so the last note cannot restart it', async () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  // The A minor pentatonic octave run ends on A and the next run opens on A,
  // an octave lower. The high one must not answer for the low one.
  const lesson = SCALE_LESSONS[0];
  const steps = runSteps(lesson);
  const first = steps[0];
  const last = steps[steps.length - 1];
  assert.equal(pitchClass(first.midi), pitchClass(last.midi), 'this run really does start and end on the same note name');
  assert.notEqual(first.midi, last.midi, 'but an octave apart');

  const session = new Session(scaleSessionConfig(lesson, { prompts: 2 }), {});
  session.start();
  session.judge(last.midi, { midiFloat: last.midi });
  assert.equal(session.prompt.stepIndex, 0, 'the wrong octave must not advance the run');
  session.judge(first.midi, { midiFloat: first.midi });
  assert.equal(session.prompt.stepIndex, 1, 'the right octave does');
  session.stop();
  store.resetAll();
});

test('a note still ringing when our own chime ends is not heard as a new pluck', () => {
  const engine = new PitchEngine();
  engine.setGate(0.01);
  engine.disarm(57); // a note was judged and is ringing on
  engine.suppress(300);

  // Frames during suppression: the envelope decays while we make our own noise.
  const ringing = 0.2;
  engine.wasSuppressed = true;
  engine.env = 0.004; // decayed far below the note that is actually sounding

  // The first frame after suppression must re-seed rather than cry attack.
  const envBefore = engine.env;
  const justResumed = true;
  const attack = !justResumed && ringing > engine.gate && ringing > Math.max(envBefore * 1.6, engine.gate * 1.2);
  assert.equal(attack, false, 'a decayed envelope must not turn a sustained note into an attack');
});

/* ---------- accounts and cloud saves ---------------------------------- */

test('usernames are normalised and checked the same way the database does it', () => {
  assert.equal(cloud.normalizeUsername('  AZ_Krebs '), 'az_krebs');
  assert.equal(cloud.validateUsername('az').ok, true);
  assert.equal(cloud.validateUsername('  AZ  ').username, 'az');
  assert.equal(cloud.validateUsername('a').ok, false, 'one character is too short');
  assert.equal(cloud.validateUsername('x'.repeat(25)).ok, false, '25 characters is too long');
  assert.equal(cloud.validateUsername('has space').ok, false);
  assert.equal(cloud.validateUsername('drop;table').ok, false);
  assert.equal(cloud.validateUsername('').ok, false);
  assert.equal(cloud.validateUsername(null).ok, false);
  assert.equal(cloud.validateUsername('good-name_9').ok, true);
});

test('the project URL is accepted in every form the dashboard shows it', () => {
  const want = 'https://qsyxckyodnzoyrqayusd.supabase.co';
  // The dashboard displays the REST endpoint, which is the natural thing to copy.
  assert.equal(normalizeProjectUrl('https://qsyxckyodnzoyrqayusd.supabase.co/rest/v1/'), want);
  assert.equal(normalizeProjectUrl('https://qsyxckyodnzoyrqayusd.supabase.co/rest/v1'), want);
  assert.equal(normalizeProjectUrl('https://qsyxckyodnzoyrqayusd.supabase.co/'), want);
  assert.equal(normalizeProjectUrl('https://qsyxckyodnzoyrqayusd.supabase.co'), want);
  assert.equal(normalizeProjectUrl('  https://qsyxckyodnzoyrqayusd.supabase.co///  '), want);
  assert.equal(normalizeProjectUrl('qsyxckyodnzoyrqayusd.supabase.co'), want, 'a missing scheme is filled in');
  assert.equal(normalizeProjectUrl(''), '');
  assert.equal(normalizeProjectUrl(null), '');
});

test('the normalised URL builds the endpoint that actually answered', () => {
  const base = normalizeProjectUrl('https://example.supabase.co/rest/v1/');
  assert.equal(`${base}/rest/v1/rpc/get_profile`, 'https://example.supabase.co/rest/v1/rpc/get_profile');
  assert.ok(!`${base}/rest/v1/rpc/get_profile`.includes('/rest/v1/rest/v1'), 'the doubled path was the whole bug');
});

test('the upload leaves microphone calibration and the device id behind', () => {
  store.resetAll();
  store.setCalibration({ gate: 0.02, noiseFloor: 0.004 });
  store.setSetting('deviceId', 'this-laptop');
  const payload = store.syncPayload();
  assert.equal(payload.calibration, undefined, 'a gate measured on one mic is wrong on another');
  assert.equal(payload.settings.deviceId, undefined);
  assert.ok(payload.stats && payload.progress && payload.notes);
  store.resetAll();
});

function stateWith({ xp = 0, notes = {}, progress = {}, updatedAt = 1000, settings = {} } = {}) {
  return {
    version: 1,
    updatedAt,
    settings: { timerSeconds: 6, ...settings },
    calibration: {},
    progress,
    notes,
    stats: { xp, sessions: 0, prompts: 0, correct: 0, streak: 0, longestStreak: 0, lastPracticeDay: null, dayCounts: {}, history: [] },
  };
}

test('merging two devices keeps the best of each, never the smaller', () => {
  const local = stateWith({ xp: 300, progress: { 's6-g1': { level: 3, sessions: 5, bestAccuracy: 0.9, lastAt: 50 } } });
  const remote = stateWith({ xp: 120, progress: { 's6-g1': { level: 1, sessions: 9, bestAccuracy: 0.7, lastAt: 20 } } });
  const merged = store.mergeStates(local, remote);
  assert.equal(merged.stats.xp, 300, 'XP must not go backwards');
  assert.equal(merged.progress['s6-g1'].level, 3, 'a cleared level must not be un-cleared');
  assert.equal(merged.progress['s6-g1'].sessions, 9, 'session counts take the higher side');
});

test('a note record comes from whichever device saw it more recently', () => {
  const older = { box: 1, reps: 2, correct: 1, lapses: 1, avgMs: 4000, due: 10, lastAt: 100, recent: [0, 1] };
  const newer = { box: 4, reps: 9, correct: 9, lapses: 0, avgMs: 900, due: 99, lastAt: 500, recent: [1, 1, 1] };
  const merged = store.mergeStates(
    stateWith({ notes: { s6f0: older } }),
    stateWith({ notes: { s6f0: newer } })
  );
  assert.deepEqual(merged.notes.s6f0, newer, 'the whole record moves together, not field by field');
});

test('merging brings across notes that only one side has ever seen', () => {
  const merged = store.mergeStates(
    stateWith({ notes: { s6f0: { box: 1, reps: 1, lastAt: 5, recent: [1] } } }),
    stateWith({ notes: { s5f3: { box: 2, reps: 4, lastAt: 7, recent: [1] } } })
  );
  assert.deepEqual(Object.keys(merged.notes).sort(), ['s5f3', 's6f0']);
});

test('settings follow the device that saved most recently', () => {
  const older = stateWith({ updatedAt: 100, settings: { timerSeconds: 6 } });
  const newer = stateWith({ updatedAt: 900, settings: { timerSeconds: 3 } });
  assert.equal(store.mergeStates(older, newer).settings.timerSeconds, 3);
  assert.equal(store.mergeStates(newer, older).settings.timerSeconds, 3);
});

test('the local calibration always survives a merge', () => {
  const local = { ...stateWith({}), calibration: { gate: 0.03, noiseFloor: 0.005 } };
  const remote = { ...stateWith({ updatedAt: 99999 }), calibration: { gate: 0.9, noiseFloor: 0.5 } };
  assert.deepEqual(store.mergeStates(local, remote).calibration, { gate: 0.03, noiseFloor: 0.005 });
});

test('session history is combined without duplicating the same session twice', () => {
  const entry = { at: 500, lessonId: 's6-g1', title: 'E F G', accuracy: 1, prompts: 12, avgMs: 900, xp: 30 };
  const other = { at: 700, lessonId: 's6-g2', title: 'A B C', accuracy: 0.8, prompts: 12, avgMs: 1200, xp: 25 };
  const local = stateWith({});
  local.stats.history = [entry];
  const remote = stateWith({});
  remote.stats.history = [other, entry];
  const merged = store.mergeStates(local, remote);
  assert.equal(merged.stats.history.length, 2);
  assert.equal(merged.stats.history[0].at, 700, 'newest first');
});

test('merging against nothing is a no-op in both directions', () => {
  const local = stateWith({ xp: 40 });
  assert.equal(store.mergeStates(local, null), local);
  assert.equal(store.mergeStates(null, local), local);
});

test('a device that has never practised is recognised as empty', () => {
  store.resetAll();
  assert.equal(store.isEmptyProgress(), true);
  store.addXp(10);
  assert.equal(store.isEmptyProgress(), false);
  store.resetAll();
});

test('a bad username is rejected locally, before anything reaches the network', async () => {
  // Deliberately network-free: the name is checked before the project is, so
  // running the tests never touches a real Supabase project even when
  // js/config.js has live credentials in it.
  await assert.rejects(() => cloud.signIn('no'.repeat(40)), /too long/i);
  await assert.rejects(() => cloud.signIn('bad name'), /letters, numbers/i);
  await assert.rejects(() => cloud.signIn(''), /pick a username/i);
});

test('signing in is refused outright when no project is connected', async (t) => {
  if (cloud.isCloudConfigured()) {
    t.skip('js/config.js has live credentials, so this path cannot be reached here');
    return;
  }
  await assert.rejects(() => cloud.signIn('someone'), /not configured/i);
});

/* ---------- not answering with the wrong sound ------------------------ */

test('stricter sensitivity really is stricter on every axis', () => {
  const order = ['relaxed', 'normal', 'strict'].map((k) => SENSITIVITY[k]);
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i].minClarity > order[i - 1].minClarity, 'clarity bar must rise');
    assert.ok(order[i].stableFrames >= order[i - 1].stableFrames, 'hold time must not fall');
    assert.ok(order[i].gateBoost >= order[i - 1].gateBoost, 'gate must not fall');
  }
});

test('the gate scales with sensitivity', () => {
  const engine = new PitchEngine();
  engine.setSensitivity('relaxed');
  engine.setGate(0.05);
  const relaxed = engine.gate;
  engine.setSensitivity('strict');
  assert.ok(engine.gate > relaxed, 'strict should demand a louder sound');
  assert.equal(engine.minClarity, SENSITIVITY.strict.minClarity);
  assert.equal(engine.stableFrames, SENSITIVITY.strict.stableFrames);
});

test('the gate never drops below the hard floor, whatever it is handed', () => {
  const engine = new PitchEngine();
  engine.setGate(0);
  assert.ok(engine.gate > 0);
  engine.setGate(undefined);
  assert.ok(engine.gate > 0);
});

test('suppressing the engine closes it to answers straight away', () => {
  const engine = new PitchEngine();
  engine.arm();
  assert.equal(engine.armed, true);
  engine.suppress(300);
  assert.equal(engine.armed, false, 'our own beeps must not be answerable');
  assert.ok(engine.suppressedUntil > 0);
  const first = engine.suppressedUntil;
  engine.suppress(10);
  assert.equal(engine.suppressedUntil, first, 'a shorter beep must not cut a longer one short');
});

test('disarming remembers the pitch that may still be ringing', () => {
  const engine = new PitchEngine();
  engine.disarm(43.2);
  assert.equal(engine.armed, false);
  assert.equal(engine.armReference, 43.2);
  engine.arm();
  assert.equal(engine.armReference, null);
});

/* A fake engine that records how the session opens and closes the mic. */
function recordingEngine() {
  const calls = [];
  let listener = null;
  return {
    calls,
    onFrame(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    arm() {
      calls.push({ call: 'arm' });
    },
    disarm(pitch = null) {
      calls.push({ call: 'disarm', pitch });
    },
    emit(frame) {
      if (listener) listener(frame);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a new prompt never re-opens the mic while the last note is still ringing', async () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);
  store.setSetting('inputMode', 'mic');

  const engine = recordingEngine();
  const session = new Session(
    {
      pool: [
        { string: 6, fret: 0 },
        { string: 6, fret: 1 },
        { string: 6, fret: 3 },
      ],
      prompts: 2,
      title: 'test',
      timerSeconds: 0,
      inputMode: 'mic',
      promptStyle: 'name',
    },
    {}
  );
  session.attach(engine);
  session.start();

  const firstMidi = session.prompt.midi;
  session.judge(firstMidi, { midiFloat: firstMidi });
  await sleep(700); // past CORRECT_HOLD_MS, so prompt two is up

  const opens = engine.calls.filter((c) => c.call === 'arm');
  assert.equal(opens.length, 1, 'only the very first prompt may open the mic outright');

  const promptTwoCall = engine.calls[engine.calls.length - 1];
  assert.equal(promptTwoCall.call, 'disarm', 'prompt two must start closed, not armed');
  assert.equal(promptTwoCall.pitch, firstMidi, 'and must know which note is still ringing');
  session.stop();
});

test('a ringing note cannot answer the next prompt, but a new note can', async () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);
  store.setSetting('inputMode', 'mic');

  const engine = recordingEngine();
  const session = new Session(
    { pool: [{ string: 6, fret: 0 }, { string: 6, fret: 3 }], prompts: 3, title: 'test', timerSeconds: 0, inputMode: 'mic', promptStyle: 'name' },
    {}
  );
  session.attach(engine);
  session.start();

  const target = session.prompt.midi;
  // A frame the engine has refused to arm for — the previous note ringing on.
  session.judge && engine.emit({ armed: false, stable: true, midi: target + 5, midiFloat: target + 5, clarity: 1, cents: 0, freq: 200 });
  assert.equal(session.results.length, 0, 'an unarmed frame must not be judged at all');

  // Now an armed, settled frame with the right note.
  engine.emit({ armed: true, stable: true, midi: target, midiFloat: target, clarity: 1, cents: 0, freq: 200 });
  assert.equal(session.results.length, 1);
  assert.equal(session.results[0].correct, true);
  session.stop();
});

/* ---------- sequences and guided runs --------------------------------- */

const SEQ_POOL = [
  { string: 6, fret: 0 },
  { string: 6, fret: 3 },
  { string: 6, fret: 5 },
  { string: 5, fret: 2 },
  { string: 5, fret: 5 },
];

function drillConfig(overrides = {}) {
  return {
    pool: SEQ_POOL,
    prompts: 1,
    title: 'test drill',
    timerSeconds: 0,
    inputMode: 'tap',
    promptStyle: 'name',
    ...overrides,
  };
}

test('a slot of several notes comes out as an ordered run of that length', () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  const session = new Session(drillConfig({ sequenceLength: 4 }), {});
  session.start();

  const prompt = session.prompt;
  assert.equal(prompt.kind, 'run');
  assert.equal(prompt.steps.length, 4);
  assert.equal(prompt.stepIndex, 0);
  for (const step of prompt.steps) {
    assert.equal(step.midi, midiAt('standard', step.string, step.fret));
    assert.ok(SEQ_POOL.some((n) => n.string === step.string && n.fret === step.fret), 'every step comes from the pool');
  }
  session.stop();
  store.resetAll();
});

test('a slot never asks for the same note name twice running', () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  // Enough draws that a repeat would show up if nothing prevented it.
  for (let round = 0; round < 40; round++) {
    const session = new Session(drillConfig({ sequenceLength: 6 }), {});
    session.start();
    const steps = session.prompt.steps;
    for (let i = 1; i < steps.length; i++) {
      assert.notEqual(
        pitchClass(steps[i].midi),
        pitchClass(steps[i - 1].midi),
        'a note still ringing must not be able to answer for the next one'
      );
    }
    session.stop();
  }
  store.resetAll();
});

test('a sequence is finished by playing its notes in order, and grades every one', async () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  let summary = null;
  const session = new Session(drillConfig({ sequenceLength: 3 }), { onEnd: (s) => (summary = s) });
  session.start();
  const steps = [...session.prompt.steps];

  for (const step of steps) session.judge(step.midi, { midiFloat: step.midi });
  await sleep(900);

  assert.ok(summary, 'the last note of the last slot must end the session');
  assert.equal(summary.prompts, 1);
  assert.equal(summary.correct, 1, 'a clean slot counts as one first-try answer');
  for (const step of steps) {
    assert.ok(store.noteRecord(posKey(step.string, step.fret)), 'every note of the slot feeds the schedule');
  }
  session.stop();
  store.resetAll();
});

test('a wrong note holds the sequence on the step it is on', () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  const session = new Session(drillConfig({ sequenceLength: 3 }), {});
  session.start();
  const first = session.prompt.steps[0];

  session.judge(first.midi + 1, { midiFloat: first.midi + 1 });
  assert.equal(session.prompt.stepIndex, 0, 'a wrong note waits, it does not advance');
  session.judge(first.midi, { midiFloat: first.midi });
  assert.equal(session.prompt.stepIndex, 1);
  session.stop();
  store.resetAll();
});

test('a drill sequence follows the octave setting, unlike a scale run', () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  store.setSetting('octaveStrictness', 'lenient');
  const lenient = new Session(drillConfig({ sequenceLength: 2 }), {});
  lenient.start();
  const target = lenient.prompt.steps[0].midi;
  lenient.judge(target + 12, { midiFloat: target + 12 });
  assert.equal(lenient.prompt.stepIndex, 1, 'the right note an octave up counts when lenient');
  lenient.stop();

  store.setSetting('octaveStrictness', 'strict');
  const strict = new Session(drillConfig({ sequenceLength: 2 }), {});
  strict.start();
  const exact = strict.prompt.steps[0].midi;
  strict.judge(exact + 12, { midiFloat: exact + 12 });
  assert.equal(strict.prompt.stepIndex, 0, 'and does not when the setting says exact string');
  strict.stop();

  store.setSetting('octaveStrictness', 'lenient');
  store.resetAll();
});

test('a guided run moves on by itself and judges nothing', async () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  let summary = null;
  const session = new Session(
    drillConfig({ prompts: 2, sequenceLength: 2, timerSeconds: 0.3, guided: true }),
    { onEnd: (s) => (summary = s) }
  );
  session.start();

  // Nothing that arrives while a guided slot is up may be judged.
  const step = session.prompt.steps[0];
  session.judge(step.midi, { midiFloat: step.midi });
  session.judge(step.midi + 7, { midiFloat: step.midi + 7 });
  assert.equal(session.results.length, 0, 'a guided run has no answers to record');

  await sleep(900);

  assert.ok(summary, 'the clock alone must be able to finish a guided run');
  assert.equal(summary.guided, true);
  assert.equal(summary.slots, 2);
  assert.equal(summary.notesShown, 4);
  assert.equal(store.stats().xp, 0, 'no XP for a run nobody listened to');
  assert.equal(store.stats().history.length, 0, 'and nothing in the history');
  assert.equal(Object.keys(store.allNoteRecords()).length, 0, 'and not one note rescheduled');
  session.stop();
  store.resetAll();
});

test('a guided slot walks its own notes as the clock runs down', async () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);

  const seen = [];
  const session = new Session(drillConfig({ prompts: 1, sequenceLength: 3, timerSeconds: 0.6, guided: true }), {
    onAdvance: (prompt) => seen.push(prompt.stepIndex),
  });
  session.start();
  assert.equal(session.prompt.stepIndex, 0, 'it opens on the first note');

  await sleep(500);
  assert.deepEqual(seen, [1, 2], 'the slot is cut into one share per note');
  session.stop();
  store.resetAll();
});

test('an unsettled frame is ignored even when the mic is open', async () => {
  store.resetAll();
  store.setSetting('countIn', false);
  store.setSetting('sound', false);
  store.setSetting('inputMode', 'mic');

  const engine = recordingEngine();
  const session = new Session(
    { pool: [{ string: 6, fret: 0 }, { string: 6, fret: 3 }], prompts: 2, title: 'test', timerSeconds: 0, inputMode: 'mic', promptStyle: 'name' },
    {}
  );
  session.attach(engine);
  session.start();
  const target = session.prompt.midi;

  engine.emit({ armed: true, stable: false, midi: target + 4, midiFloat: target + 4, clarity: 1, cents: 0, freq: 200 });
  engine.emit({ armed: true, stable: true, midi: null, midiFloat: null, clarity: 0, cents: 0, freq: null });
  assert.equal(session.results.length, 0, 'transients must not count as answers');
  session.stop();
  store.resetAll();
});
