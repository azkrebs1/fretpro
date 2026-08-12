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
