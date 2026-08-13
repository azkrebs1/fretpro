/* The scales track: minor pentatonic first, because it is five notes, one
   famous shape, and the fastest route to playing something that sounds like
   music. Each unit takes one shape and works it four ways — climb it, name its
   roots, name its degrees, then improvise inside it. */

import { pitchClass } from './theory.js';
import { SCALES, boxPositions, oneOctave, ascending, descending, dedupeRun, rootsIn, scaleTitle, rootName, PC } from './scales.js';

/** Exercise kinds the session engine understands. */
export const EXERCISE = {
  RUN: 'run', // play the shape in order
  DEGREE: 'degree', // "play the flat 3"
  ROOT: 'root', // "play a root"
  KEY: 'membership', // stay in key
};

const shape = (scaleId, rootPc, boxIndex) => ({ scaleId, rootPc, boxIndex });

function runLesson(id, { title, subtitle, scaleId, rootPc, boxIndex, direction = 'up', octaveOnly = false, prompts = 3, seconds = 20, milestone = false }) {
  return {
    id,
    title,
    subtitle,
    exercise: EXERCISE.RUN,
    ...shape(scaleId, rootPc, boxIndex),
    direction,
    octaveOnly,
    prompts,
    seconds,
    milestone,
  };
}

/** The ordered notes a run lesson asks for. */
export function runSteps(lesson) {
  const positions = boxPositions(lesson.scaleId, lesson.rootPc, lesson.boxIndex);
  const scope = lesson.octaveOnly ? oneOctave(positions, lesson.rootPc) : positions;
  const ordered = lesson.direction === 'down' ? descending(scope) : ascending(scope);
  if (lesson.direction === 'updown') {
    const up = ascending(scope);
    return dedupeRun([...up, ...up.slice(0, -1).reverse()]);
  }
  return dedupeRun(ordered);
}

/** Positions a non-run scale lesson draws from. */
export function lessonPositions(lesson) {
  const positions = boxPositions(lesson.scaleId, lesson.rootPc, lesson.boxIndex);
  if (lesson.exercise === EXERCISE.ROOT) return rootsIn(positions);
  return positions;
}

function boxUnit(idPrefix, order, { scaleId, rootPc, boxIndex, title, blurb, full = true }) {
  const label = scaleTitle(scaleId, rootPc);
  const boxName = `box ${boxIndex + 1}`;
  const lessons = [];

  lessons.push(
    runLesson(`${idPrefix}-oct-up`, {
      title: 'One octave, up',
      subtitle: `${label}, root to root in ${boxName}`,
      scaleId,
      rootPc,
      boxIndex,
      octaveOnly: true,
      prompts: 4,
      seconds: 14,
    }),
    runLesson(`${idPrefix}-oct-down`, {
      title: 'One octave, down',
      subtitle: 'The same notes backwards — harder than it looks',
      scaleId,
      rootPc,
      boxIndex,
      direction: 'down',
      octaveOnly: true,
      prompts: 4,
      seconds: 14,
    })
  );

  if (full) {
    lessons.push(
      runLesson(`${idPrefix}-box-up`, {
        title: 'Whole shape, up',
        subtitle: `Every note of ${boxName}, low string to high`,
        scaleId,
        rootPc,
        boxIndex,
        prompts: 3,
        seconds: 24,
      }),
      runLesson(`${idPrefix}-box-down`, {
        title: 'Whole shape, down',
        subtitle: `Every note of ${boxName}, high string to low`,
        scaleId,
        rootPc,
        boxIndex,
        direction: 'down',
        prompts: 3,
        seconds: 24,
      })
    );
  }

  lessons.push(
    {
      id: `${idPrefix}-roots`,
      title: 'Find the roots',
      subtitle: `Every ${rootName(rootPc)} in ${boxName} — the notes that let you move the shape`,
      exercise: EXERCISE.ROOT,
      ...shape(scaleId, rootPc, boxIndex),
      prompts: 8,
      seconds: 7,
    },
    {
      id: `${idPrefix}-degrees`,
      title: 'Name the degrees',
      subtitle: 'Play the interval it asks for, anywhere in the shape',
      exercise: EXERCISE.DEGREE,
      ...shape(scaleId, rootPc, boxIndex),
      prompts: 10,
      seconds: 9,
    },
    {
      id: `${idPrefix}-key`,
      title: 'Stay in key',
      subtitle: 'Improvise inside the shape — your notes, your order',
      exercise: EXERCISE.KEY,
      ...shape(scaleId, rootPc, boxIndex),
      prompts: 3,
      seconds: 45,
      notesNeeded: 12,
      milestone: true,
    }
  );

  return { id: idPrefix, order, title, blurb, scaleId, rootPc, boxIndex, lessons };
}

/** A unit of the same shape moved to new keys — the point of learning shapes. */
function transposeUnit(idPrefix, order, { scaleId, boxIndex, roots, title, blurb }) {
  const lessons = roots.map((rootPc, i) =>
    runLesson(`${idPrefix}-${rootName(rootPc).toLowerCase().replace('#', 's')}`, {
      title: `${rootName(rootPc)} — one octave`,
      subtitle: `The same shape, root on fret ${boxPositions(scaleId, rootPc, boxIndex)[0]?.fret ?? '?'}`,
      scaleId,
      rootPc,
      boxIndex,
      octaveOnly: true,
      prompts: 4,
      seconds: 14,
    })
  );

  lessons.push({
    id: `${idPrefix}-key`,
    title: 'Stay in key, new root',
    subtitle: `Improvise in ${scaleTitle(scaleId, roots[roots.length - 1])}`,
    exercise: EXERCISE.KEY,
    ...shape(scaleId, roots[roots.length - 1], boxIndex),
    prompts: 3,
    seconds: 45,
    notesNeeded: 12,
    milestone: true,
  });

  return { id: idPrefix, order, title, blurb, scaleId, rootPc: roots[0], boxIndex, lessons };
}

export const SCALE_UNITS = (() => {
  const units = [];
  let order = 1;

  units.push(
    boxUnit('sc-amp1', order++, {
      scaleId: 'minorPentatonic',
      rootPc: PC.A,
      boxIndex: 0,
      title: 'A minor pentatonic — box 1',
      blurb: 'The most-played shape on the guitar. Five notes, starting at the 5th fret.',
    })
  );

  units.push(
    boxUnit('sc-amp2', order++, {
      scaleId: 'minorPentatonic',
      rootPc: PC.A,
      boxIndex: 1,
      title: 'A minor pentatonic — box 2',
      blurb: 'The shape above it. Notice it shares a note per string with box 1.',
    })
  );

  units.push(
    transposeUnit('sc-move', order++, {
      scaleId: 'minorPentatonic',
      boxIndex: 0,
      roots: [PC.E, PC.G, PC.D],
      title: 'Move the shape',
      blurb: 'Same fingers, new root. This is what shapes are for.',
    })
  );

  units.push(
    boxUnit('sc-gmp1', order++, {
      scaleId: 'majorPentatonic',
      rootPc: PC.G,
      boxIndex: 0,
      title: 'G major pentatonic',
      blurb: 'The same five shapes heard from a brighter root.',
    })
  );

  units.push(
    boxUnit('sc-ablues', order++, {
      scaleId: 'blues',
      rootPc: PC.A,
      boxIndex: 0,
      title: 'A blues scale',
      blurb: 'Box 1 with the flat five wedged in — the note that makes it growl.',
    })
  );

  units.push(
    boxUnit('sc-cmaj', order++, {
      scaleId: 'major',
      rootPc: PC.C,
      boxIndex: 0,
      title: 'C major scale',
      blurb: 'Seven notes, three per string. Everything else is measured against this.',
    })
  );

  return units;
})();

/** Flat, ordered lesson list with unit context and prerequisites attached. */
export const SCALE_LESSONS = (() => {
  const out = [];
  let previous = null;
  for (const unit of SCALE_UNITS) {
    for (const lesson of unit.lessons) {
      const entry = {
        ...lesson,
        unitId: unit.id,
        unitTitle: unit.title,
        index: out.length,
        requires: previous,
        track: 'scales',
      };
      out.push(entry);
      previous = entry.id;
    }
  }
  return out;
})();

export const SCALE_LESSON_BY_ID = new Map(SCALE_LESSONS.map((l) => [l.id, l]));

/** Every position the scales track ever asks for, for progress reporting. */
export const SCALE_POSITIONS = (() => {
  const seen = new Map();
  for (const lesson of SCALE_LESSONS) {
    for (const p of boxPositions(lesson.scaleId, lesson.rootPc, lesson.boxIndex)) {
      seen.set(`${p.string}:${p.fret}`, { string: p.string, fret: p.fret });
    }
  }
  return [...seen.values()];
})();

export function scaleLessonLabel(lesson) {
  return `${scaleTitle(lesson.scaleId, lesson.rootPc)} · ${lesson.title}`;
}

/** Short tag shown on a path node. */
export function scaleNodeLabel(lesson) {
  if (lesson.exercise === EXERCISE.KEY) return 'KEY';
  if (lesson.exercise === EXERCISE.ROOT) return 'ROOT';
  if (lesson.exercise === EXERCISE.DEGREE) return 'DEG';
  if (lesson.direction === 'down') return '↓';
  return '↑';
}

export const scalePitchSet = (lesson) =>
  new Set(SCALES[lesson.scaleId].intervals.map((i) => pitchClass(lesson.rootPc + i)));
