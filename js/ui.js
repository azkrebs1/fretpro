/* Screens, rendering and wiring. */

import { midiAt, noteName, splitName, posKey, parsePosKey, isNatural, pitchClass, TUNINGS, MAX_FRET } from './theory.js';
import { LESSONS, LESSON_BY_ID, UNITS, MAX_LEVEL, levelSpec, ALL_POSITIONS, poolPitchClasses } from './curriculum.js';
import * as store from './store.js';
import { mastery, isDue } from './srs.js';
import { PitchEngine, playNoteTone, playLevelUp, onSelfNoise, SENSITIVITY, Metronome, MIN_BPM, MAX_BPM } from './audio.js';
import { createFretboard, noteBadge } from './fretboard.js';
import { Session, effectiveTimer, MAX_SEQUENCE } from './session.js';
import * as cloud from './cloud.js';
import { supabaseConfig, writeOverride } from './config.js';
import { boxPositions, boxWindow, boxCount, boxFits, scaleTitle, rootName, SCALES, SCALE_MAX_FRET } from './scales.js';
import {
  SCALE_UNITS,
  SCALE_LESSONS,
  SCALE_LESSON_BY_ID,
  EXERCISE,
  runSteps,
  lessonPositions,
  scaleNodeLabel,
  scalePitchSet,
} from './scaleCurriculum.js';

/* ---------- tiny DOM helper ------------------------------------------ */

export function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const $ = (sel) => document.querySelector(sel);
const pct = (v) => `${Math.round(v * 100)}%`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------- module state --------------------------------------------- */

export const engine = new PitchEngine();

// Anything the app plays comes back through the speakers, so stop listening
// for as long as it sounds. Without this the app answers its own prompts.
onSelfNoise((ms) => engine.suppress(ms));
let activeSession = null;
let activeMetronome = null;
let sessionBoard = null;
let progressBoard = null;
let meterUnsub = null;
let currentScreen = 'path';
let pendingStart = null; // session config waiting on calibration

/* ---------- screen switching ----------------------------------------- */

export function showScreen(name) {
  currentScreen = name;
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('is-active'));
  const el = $(`#screen-${name}`);
  if (el) el.classList.add('is-active');
  document.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('is-active', b.dataset.screen === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function toast(message, kind = '') {
  const node = h('div', { class: `toast ${kind ? `is-${kind}` : ''}`, text: message });
  $('#toasts').appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 320);
  }, 3200);
}

export function openSheet(title, body, actions = []) {
  const card = $('#sheetCard');
  card.textContent = '';
  card.appendChild(h('h2', { id: 'sheetTitle', text: title }));
  for (const b of [].concat(body)) card.appendChild(typeof b === 'string' ? h('p', { class: 'lede', text: b }) : b);
  if (actions.length) card.appendChild(h('div', { class: 'btn-row', style: 'margin-top:18px' }, actions));
  $('#sheet').hidden = false;
}

export function closeSheet() {
  $('#sheet').hidden = true;
}

/* ---------- naming helpers ------------------------------------------- */

function nameOf(string, fret) {
  const s = store.settings();
  return noteName(midiAt(s.tuning, string, fret), s.spelling);
}

function shortName(string, fret) {
  return nameOf(string, fret).split('/')[0];
}

/** Lesson titles follow the tuning, so they stay true if you retune. */
function lessonTitle(lesson) {
  if (!lesson.milestone && lesson.newNotes.length <= 3) {
    return lesson.newNotes.map((n) => shortName(n.string, n.fret)).join(' · ');
  }
  return lesson.title;
}

function nodeLabel(lesson) {
  if (lesson.milestone) return 'ALL';
  if (lesson.newNotes.length <= 3) return lesson.newNotes.map((n) => shortName(n.string, n.fret).replace('#', '♯')).join('');
  return String(lesson.newNotes.length);
}

function glyphFor(name) {
  const { letter, accidental } = splitName(name);
  return h('div', { class: 'glyph' }, [letter, accidental ? h('sup', { text: accidental }) : null]);
}

/* ---------- progress helpers ----------------------------------------- */

export function lessonState(lesson) {
  const prog = store.lessonProgress(lesson.id);
  const prevDone = !lesson.requires || store.lessonProgress(lesson.requires).level >= 1;
  if (prog.level >= MAX_LEVEL) return 'done';
  if (prog.level >= 1) return 'started';
  return prevDone ? 'next' : 'locked';
}

function firstOpenLesson() {
  return LESSONS.find((l) => lessonState(l) === 'next' || lessonState(l) === 'started') || LESSONS[LESSONS.length - 1];
}

function masteryFor(string, fret) {
  return mastery(store.noteRecord(posKey(string, fret)));
}

function overallMastery() {
  const total = ALL_POSITIONS.reduce((acc, n) => acc + masteryFor(n.string, n.fret), 0);
  return total / ALL_POSITIONS.length;
}

/** Positions the learner has actually met, for review drills. */
function seenPositions() {
  return Object.keys(store.allNoteRecords())
    .map(parsePosKey)
    .filter(Boolean);
}

function duePositions() {
  return seenPositions().filter((n) => isDue(store.noteRecord(posKey(n.string, n.fret))));
}

/* ---------- rail ------------------------------------------------------ */

export function renderRail() {
  const s = store.stats();
  const lvl = store.levelFromXp(s.xp);
  const streak = store.currentStreak();
  const today = s.dayCounts[store.todayKey()] || 0;
  const rail = $('#railStats');
  rail.textContent = '';
  rail.append(
    accountChip(),
    h('div', { class: 'stat-chip', title: `${s.xp} XP total` }, [
      h('b', { text: `L${lvl.level}` }),
      h('span', { text: 'level' }),
    ]),
    h('div', { class: `stat-chip ${streak > 0 ? 'is-hot' : ''}`, title: 'Days in a row with practice' }, [
      h('b', { text: String(streak) }),
      h('span', { text: 'streak' }),
    ]),
    h('div', { class: 'stat-chip', title: 'Notes answered today' }, [
      h('b', { text: String(today) }),
      h('span', { text: 'today' }),
    ])
  );
}

const SYNC_LOOK = {
  off: { dot: '', label: 'local only', title: 'Cloud saves are not set up — progress stays in this browser.' },
  idle: { dot: '', label: 'not signed in', title: 'Sign in from Setup to save progress across devices.' },
  syncing: { dot: 'is-syncing', label: 'syncing…', title: 'Talking to the server.' },
  saved: { dot: 'is-ok', label: 'saved', title: 'Progress is saved to your account.' },
  offline: { dot: 'is-warn', label: 'offline', title: 'No connection — progress is safe locally and will sync later.' },
  error: { dot: 'is-bad', label: 'sync failed', title: 'Could not reach the server.' },
};

/** Small account/sync indicator that lives in the top rail. */
function accountChip() {
  const status = cloud.syncStatus();
  const look = SYNC_LOOK[status.state] || SYNC_LOOK.idle;
  const user = cloud.currentUser();
  const chip = h(
    'button',
    {
      class: 'account-chip',
      type: 'button',
      title: status.message || look.title,
      onclick: () => {
        renderSetup();
        showScreen('setup');
        const panel = document.getElementById('accountPanel');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
    },
    [
      h('span', { class: `sync-dot ${look.dot}` }),
      h('span', { class: 'account-chip-text' }, [
        h('b', { text: user ? `@${user}` : 'Guest' }),
        h('span', { text: user ? look.label : look.label }),
      ]),
    ]
  );
  return chip;
}

function setMicPlate(text, live = false) {
  $('#plateMic').textContent = text;
  $('#jewel').classList.toggle('is-live', live);
}

/* ---------- path screen ---------------------------------------------- */

export function renderPath() {
  const root = $('#screen-path');
  root.textContent = '';

  const open = firstOpenLesson();
  const s = store.stats();
  const goalDone = Math.min(store.settings().dailyGoal, countTodaySessions());
  const overall = overallMastery();

  root.appendChild(
    h('div', { class: 'path-head' }, [
      h('div', {}, [
        h('div', { class: 'eyebrow', text: 'Learn the neck, three notes at a time' }),
        h('h1', { text: 'The path' }),
        h('p', { class: 'lede', text: 'Each stop adds three notes on one string. Clear it and the next unlocks. Nothing is ever dropped — old notes keep coming back on their own schedule.' }),
      ]),
      h('div', { class: 'goal' }, [
        h('div', { class: 'eyebrow', text: `Today · ${goalDone} of ${store.settings().dailyGoal} sessions` }),
        h('div', { class: 'goal-bar' }, [h('i', { style: `width:${pct(clamp(goalDone / Math.max(1, store.settings().dailyGoal), 0, 1))}` })]),
        h('div', { class: 'eyebrow', style: 'margin-top:10px', text: `Fretboard mastered · ${pct(overall)}` }),
        h('div', { class: 'goal-bar' }, [h('i', { style: `width:${pct(overall)}` })]),
      ]),
    ])
  );

  root.appendChild(
    h('div', { class: 'btn-row', style: 'margin-bottom:8px' }, [
      h('button', { class: 'btn is-primary', onclick: () => startLesson(open.id) }, [
        `Continue · ${lessonTitle(open)}`,
      ]),
      h('button', { class: 'btn is-ghost', onclick: () => startReview() }, [`Review due (${duePositions().length})`]),
    ])
  );

  const neck = h('div', { class: 'neck' });
  UNITS.forEach((unit, ui) => {
    const unitLessons = LESSONS.filter((l) => l.unitId === unit.id);
    const locked = unitLessons.every((l) => lessonState(l) === 'locked');
    const unitEl = h('section', { class: `neck-unit ${locked ? 'unit-locked' : ''}` }, [
      h('div', { class: 'unit-head' }, [
        h('span', { class: 'unit-num', text: String(ui + 1).padStart(2, '0') }),
        h('h2', { text: unit.title }),
        h('p', { text: locked ? 'Locked — finish the unit above' : unit.blurb }),
      ]),
    ]);

    const strip = h('div', { class: 'neck-strip' });
    unitLessons.forEach((lesson, li) => {
      const state = lessonState(lesson);
      const prog = store.lessonProgress(lesson.id);
      const side = li % 2 === 0 ? 'on-right' : 'on-left';
      const btn = h(
        'button',
        {
          type: 'button',
          class: `node ${state === 'locked' ? 'is-locked' : ''} ${state === 'next' ? 'is-next' : ''} ${
            state === 'done' ? 'is-done' : ''
          } ${lesson.milestone ? 'is-milestone' : ''}`,
          disabled: state === 'locked',
          'aria-label': `${lessonTitle(lesson)} — ${lesson.subtitle}`,
          onclick: () => openLessonSheet(lesson.id),
        },
        [
          h('span', { class: 'node-label', text: nodeLabel(lesson) }),
          h(
            'span',
            { class: 'node-pips' },
            [0, 1, 2].map((i) => h('i', { class: i < prog.level ? 'is-on' : '' }))
          ),
        ]
      );

      strip.appendChild(
        h('div', { class: 'node-row' }, [
          btn,
          h('div', { class: `node-caption ${side}` }, [
            h('b', { text: lessonTitle(lesson) }),
            lesson.subtitle,
            h('em', { text: state === 'locked' ? ' · locked' : ` · level ${prog.level}/${MAX_LEVEL}` }),
          ]),
        ])
      );
    });

    unitEl.appendChild(strip);
    neck.appendChild(unitEl);
  });

  root.appendChild(neck);
}

function countTodaySessions() {
  const today = store.todayKey();
  return store.stats().history.filter((entry) => store.todayKey(new Date(entry.at)) === today).length;
}

function openLessonSheet(lessonId) {
  const lesson = LESSON_BY_ID.get(lessonId);
  const state = lessonState(lesson);
  if (state === 'locked') return;
  const prog = store.lessonProgress(lessonId);
  const target = Math.min(MAX_LEVEL, prog.level + 1);
  const spec = levelSpec(target - 1);
  const timer = effectiveTimer(store.settings().timerSeconds, target);

  const badges = h(
    'div',
    { class: 'badge-row' },
    lesson.pool.slice(0, 14).map((n) => noteBadge(store.settings().tuning, n.string, n.fret, store.settings().spelling))
  );

  openSheet(
    lessonTitle(lesson),
    [
      h('p', { class: 'lede', text: lesson.subtitle }),
      h('div', { class: 'result-grid', style: 'margin:16px 0 6px' }, [
        h('div', { class: 'tile' }, [h('span', { text: 'Level' }), h('b', { text: `${prog.level}/${MAX_LEVEL}` }), h('small', { text: spec.label })]),
        h('div', { class: 'tile' }, [h('span', { text: 'Prompts' }), h('b', { text: String(spec.prompts) })]),
        h('div', { class: 'tile' }, [
          h('span', { text: 'Clock' }),
          h('b', { text: timer ? `${timer}s` : '∞' }),
          h('small', { text: `pass at ${pct(spec.minAccuracy)}` }),
        ]),
      ]),
      h('div', { class: 'eyebrow', style: 'margin-top:14px', text: `Notes in play (${lesson.pool.length})` }),
      badges,
    ],
    [
      h('button', { class: 'btn is-primary', onclick: () => { closeSheet(); startLesson(lessonId); } }, [
        prog.level >= MAX_LEVEL ? 'Practice again' : `Start level ${target}`,
      ]),
      h('button', { class: 'btn is-ghost', onclick: closeSheet }, ['Cancel']),
    ]
  );
}

/* ---------- scales track ---------------------------------------------- */

/** Scales open once the note path has covered every string. */
export const SCALES_GATE_LESSON = 'mix-all-all';

export function scalesUnlocked() {
  return store.settings().scalesUnlockedEarly === true || store.lessonProgress(SCALES_GATE_LESSON).level >= 1;
}

export function scaleLessonState(lesson) {
  if (!scalesUnlocked()) return 'locked';
  const prog = store.lessonProgress(lesson.id);
  const prevDone = !lesson.requires || store.lessonProgress(lesson.requires).level >= 1;
  if (prog.level >= MAX_LEVEL) return 'done';
  if (prog.level >= 1) return 'started';
  return prevDone ? 'next' : 'locked';
}

function firstOpenScaleLesson() {
  return (
    SCALE_LESSONS.find((l) => ['next', 'started'].includes(scaleLessonState(l))) || SCALE_LESSONS[SCALE_LESSONS.length - 1]
  );
}

export function renderScales() {
  const root = $('#screen-scales');
  root.textContent = '';
  const unlocked = scalesUnlocked();
  const open = firstOpenScaleLesson();

  root.appendChild(
    h('div', { class: 'path-head' }, [
      h('div', {}, [
        h('div', { class: 'eyebrow', text: 'Shapes, not just notes' }),
        h('h1', { text: 'Scales' }),
        h('p', { class: 'lede', text: 'Climb a shape in order, find its roots, name its degrees, then improvise inside it. Every note you play here also counts toward your fretboard mastery.' }),
      ]),
    ])
  );

  if (!unlocked) {
    root.appendChild(
      h('div', { class: 'banner' }, [
        h('b', { text: 'Locked for now' }),
        'Scales open once you clear "Anywhere" in the All six strings unit. Shapes only mean something when you already know what the notes are called — but it is your neck, so skip ahead if you want.',
        h('div', { class: 'btn-row', style: 'margin-top:14px' }, [
          h('button', {
            class: 'btn',
            onclick: () => {
              store.setSetting('scalesUnlockedEarly', true);
              renderScales();
              toast('Scales unlocked.', 'good');
            },
          }, ['Open it anyway']),
        ]),
      ])
    );
  } else {
    root.appendChild(
      h('div', { class: 'btn-row', style: 'margin-bottom:8px' }, [
        h('button', { class: 'btn is-primary', onclick: () => startScaleLesson(open.id) }, [`Continue · ${open.title}`]),
      ])
    );
  }

  const neck = h('div', { class: 'neck' });
  SCALE_UNITS.forEach((unit, ui) => {
    const unitLessons = SCALE_LESSONS.filter((l) => l.unitId === unit.id);
    const allLocked = unitLessons.every((l) => scaleLessonState(l) === 'locked');
    const unitEl = h('section', { class: `neck-unit ${allLocked ? 'unit-locked' : ''}` }, [
      h('div', { class: 'unit-head' }, [
        h('span', { class: 'unit-num', text: `S${String(ui + 1).padStart(2, '0')}` }),
        h('h2', { text: unit.title }),
        h('p', { text: allLocked && !unlocked ? 'Locked' : unit.blurb }),
      ]),
    ]);

    const strip = h('div', { class: 'neck-strip' });
    unitLessons.forEach((lesson, li) => {
      const state = scaleLessonState(lesson);
      const prog = store.lessonProgress(lesson.id);
      const side = li % 2 === 0 ? 'on-right' : 'on-left';
      const node = h(
        'button',
        {
          type: 'button',
          class: `node ${state === 'locked' ? 'is-locked' : ''} ${state === 'next' ? 'is-next' : ''} ${
            state === 'done' ? 'is-done' : ''
          } ${lesson.milestone ? 'is-milestone' : ''}`,
          disabled: state === 'locked',
          'aria-label': `${lesson.title} — ${lesson.subtitle}`,
          onclick: () => openScaleSheet(lesson.id),
        },
        [
          h('span', { class: 'node-label', text: scaleNodeLabel(lesson) }),
          h(
            'span',
            { class: 'node-pips' },
            [0, 1, 2].map((i) => h('i', { class: i < prog.level ? 'is-on' : '' }))
          ),
        ]
      );

      strip.appendChild(
        h('div', { class: 'node-row' }, [
          node,
          h('div', { class: `node-caption ${side}` }, [
            h('b', { text: lesson.title }),
            lesson.subtitle,
            h('em', { text: state === 'locked' ? ' · locked' : ` · level ${prog.level}/${MAX_LEVEL}` }),
          ]),
        ])
      );
    });

    unitEl.appendChild(strip);
    neck.appendChild(unitEl);
  });

  root.appendChild(neck);
}

function openScaleSheet(lessonId) {
  const lesson = SCALE_LESSON_BY_ID.get(lessonId);
  if (scaleLessonState(lesson) === 'locked') return;
  const prog = store.lessonProgress(lessonId);
  const target = Math.min(MAX_LEVEL, prog.level + 1);
  const spec = levelSpec(target - 1);
  const seconds = Math.max(4, Math.round(lesson.seconds * spec.timerScale));

  const explain =
    lesson.exercise === EXERCISE.RUN
      ? `Play all ${runSteps(lesson).length} notes in order. ${target >= 3 ? 'At this level a wrong note restarts the run.' : 'A wrong note just waits for you to find the right one.'}`
      : lesson.exercise === EXERCISE.KEY
      ? `Play ${lesson.notesNeeded} notes from the scale in any order, using every note of it at least once. Anything outside the scale shows red.`
      : lesson.exercise === EXERCISE.ROOT
      ? 'Play the root wherever it appears in the shape.'
      : 'Play the degree it names, anywhere in the shape.';

  openSheet(
    `${scaleTitle(lesson.scaleId, lesson.rootPc)} · ${lesson.title}`,
    [
      h('p', { class: 'lede', text: lesson.subtitle }),
      h('div', { class: 'result-grid', style: 'margin:16px 0 6px' }, [
        h('div', { class: 'tile' }, [h('span', { text: 'Level' }), h('b', { text: `${prog.level}/${MAX_LEVEL}` }), h('small', { text: spec.label })]),
        h('div', { class: 'tile' }, [
          h('span', { text: lesson.exercise === EXERCISE.RUN ? 'Runs' : 'Rounds' }),
          h('b', { text: String(lesson.prompts) }),
        ]),
        h('div', { class: 'tile' }, [h('span', { text: 'Clock each' }), h('b', { text: `${seconds}s` })]),
      ]),
      h('p', { class: 'help', text: explain }),
    ],
    [
      h('button', { class: 'btn is-primary', onclick: () => { closeSheet(); startScaleLesson(lessonId); } }, [
        prog.level >= MAX_LEVEL ? 'Practice again' : `Start level ${target}`,
      ]),
      h('button', { class: 'btn is-ghost', onclick: closeSheet }, ['Cancel']),
    ]
  );
}

export function startScaleLesson(lessonId) {
  const lesson = SCALE_LESSON_BY_ID.get(lessonId);
  const prog = store.lessonProgress(lessonId);
  const target = Math.min(MAX_LEVEL, prog.level + 1);
  const spec = levelSpec(target - 1);
  const s = store.settings();
  const positions = boxPositions(lesson.scaleId, lesson.rootPc, lesson.boxIndex);

  const config = {
    exercise: lesson.exercise,
    scaleLessonId: lessonId,
    lessonId,
    targetLevel: target,
    title: `${scaleTitle(lesson.scaleId, lesson.rootPc, s.spelling)} · ${lesson.title}`,
    prompts: lesson.prompts,
    timerSeconds: Math.max(4, Math.round(lesson.seconds * spec.timerScale)),
    inputMode: s.inputMode,
    promptStyle: 'name',
    boxPositions: positions,
    scaleId: lesson.scaleId,
    rootPc: lesson.rootPc,
    // Level 3 makes a fumbled run start again, the way you would practise it.
    restartOnError: target >= MAX_LEVEL,
  };

  if (lesson.exercise === EXERCISE.RUN) {
    config.steps = runSteps(lesson);
  } else if (lesson.exercise === EXERCISE.KEY) {
    config.allowedPcs = scalePitchSet(lesson);
    config.notesNeeded = lesson.notesNeeded || 12;
  } else {
    config.pool = lessonPositions(lesson);
  }

  beginSession(config);
}

/* ---------- starting sessions ---------------------------------------- */

export function startLesson(lessonId) {
  const lesson = LESSON_BY_ID.get(lessonId);
  const prog = store.lessonProgress(lessonId);
  const target = Math.min(MAX_LEVEL, prog.level + 1);
  const spec = levelSpec(target - 1);
  const s = store.settings();
  beginSession({
    pool: lesson.pool,
    prompts: spec.prompts,
    title: `${lesson.unitTitle} · ${lessonTitle(lesson)}`,
    lessonId,
    targetLevel: target,
    timerSeconds: effectiveTimer(s.timerSeconds, target),
    inputMode: s.inputMode,
    promptStyle: s.promptStyle,
  });
}

export function startReview() {
  const due = duePositions();
  const pool = due.length >= 3 ? due : seenPositions();
  if (pool.length < 1) {
    toast('Nothing to review yet — start the first lesson.', 'bad');
    return;
  }
  const s = store.settings();
  beginSession({
    pool,
    prompts: Math.min(24, Math.max(10, pool.length)),
    title: 'Review · notes that are due',
    timerSeconds: s.timerSeconds,
    inputMode: s.inputMode,
    promptStyle: s.promptStyle,
  });
}

export function beginSession(config) {
  // A guided run listens to nothing, so it never opens the microphone or asks
  // to be calibrated first.
  if (config.inputMode === 'mic' && !config.guided) {
    const mode = store.settings().calibrateBeforeSession;
    const stale = needsCalibration();
    if (mode === 'always' || (mode === 'auto' && stale)) {
      pendingStart = config;
      renderCalibrate({ thenStart: true });
      showScreen('calibrate');
      return;
    }
    ensureEngine()
      .then(() => runSession(config))
      .catch((err) => {
        toast(err.message, 'bad');
        renderSetup();
        showScreen('setup');
      });
    return;
  }
  runSession(config);
}

function needsCalibration() {
  const c = store.calibration();
  if (!c.gate || !c.at) return true;
  const sixHours = 6 * 60 * 60 * 1000;
  if (Date.now() - c.at > sixHours) return true;
  if (engine.sampleRate && c.sampleRate && engine.sampleRate !== c.sampleRate) return true;
  return false;
}

async function ensureEngine() {
  if (!engine.running) {
    setMicPlate('opening microphone…');
    await engine.start();
    setMicPlate('microphone live', true);
  }
  const c = store.calibration();
  engine.setSensitivity(store.settings().detectionSensitivity);
  engine.setGate(c.gate || undefined);
  engine.setA4(store.settings().a4);
  return engine;
}

/* ---------- calibration screen --------------------------------------- */

export function renderCalibrate({ thenStart = false } = {}) {
  const root = $('#screen-calibrate');
  root.textContent = '';

  const ring = h('div', { class: 'calib-ring' }, [h('span', { text: '3.0' })]);
  const steps = h('div', { class: 'calib-steps' }, [h('i', { class: 'is-on' }), h('i'), h('i')]);
  const levelStrip = h('div', { class: 'level-strip' }, Array.from({ length: 24 }, () => h('i')));
  const status = h('p', { class: 'lede', style: 'margin-inline:auto', text: 'Put the guitar down, stay quiet, and let the room speak for three seconds. FretPro uses this to tell your playing apart from everything else.' });
  const actions = h('div', { class: 'btn-row', style: 'justify-content:center;margin-top:20px' });

  const panel = h('div', { class: 'calib panel' }, [
    steps,
    h('div', { class: 'eyebrow', text: 'Step 1 of 2 · room noise' }),
    h('h1', { text: 'Listening to the room' }),
    ring,
    levelStrip,
    status,
    actions,
  ]);
  root.appendChild(panel);

  const start = async () => {
    actions.textContent = '';
    try {
      await ensureEngine();
    } catch (err) {
      status.textContent = err.message;
      actions.appendChild(h('button', { class: 'btn', onclick: start }, ['Try again']));
      actions.appendChild(h('button', { class: 'btn is-ghost', onclick: () => showScreen('path') }, ['Back']));
      return;
    }

    engine.setGate(0.0001); // hear everything while measuring
    const off = engine.onFrame((frame) => paintStrip(levelStrip, frame.rms * 6));
    const result = await engine.calibrate(3000, (p) => {
      ring.style.setProperty('--p', String(p * 100));
      ring.querySelector('span').textContent = (3 - p * 3).toFixed(1);
    });
    off();
    ring.style.setProperty('--p', '100');
    ring.querySelector('span').textContent = '✓';

    store.setCalibration({
      noiseFloor: result.noiseFloor,
      gate: result.gate,
      sampleRate: result.sampleRate,
    });
    engine.setGate(result.gate);
    renderCalibrateStep2(panel, result, thenStart);
  };

  actions.appendChild(h('button', { class: 'btn is-primary', onclick: start }, ['Start listening']));
  actions.appendChild(
    h('button', { class: 'btn is-ghost', onclick: () => (thenStart && pendingStart ? runSession(pendingStart) : showScreen('path')) }, [
      thenStart ? 'Skip, use last calibration' : 'Back',
    ])
  );
}

function paintStrip(strip, level) {
  const bars = strip.children;
  const on = Math.round(clamp(level, 0, 1) * bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    b.className = i < on ? (i > bars.length * 0.85 ? 'is-peak' : i > bars.length * 0.6 ? 'is-hot' : 'is-on') : '';
  }
}

function renderCalibrateStep2(panel, result, thenStart) {
  panel.textContent = '';
  const db = (v) => `${(20 * Math.log10(Math.max(v, 1e-9))).toFixed(1)} dB`;
  const readout = h('div', { class: 'readout-big', text: '—' }, []);
  const sub = h('small', { text: 'play any note' });
  readout.appendChild(sub);
  const levelStrip = h('div', { class: 'level-strip' }, Array.from({ length: 24 }, () => h('i')));
  const guitarLine = h('div', { class: 'banner', style: 'text-align:left' }, [
    h('b', { text: 'Threshold from the room only' }),
    `Ignoring anything below ${db(result.gate)}. Play a few notes and this gets set properly.`,
  ]);

  // Measure how loud the guitar actually is, then put the threshold in the gap
  // between it and the room. A floor-derived gate alone has no idea how much
  // headroom your playing has, which is what lets stray sounds through.
  let guitarPeak = 0;
  let goodFrames = 0;
  const floorDb = 20 * Math.log10(Math.max(result.noiseFloor, 1e-9));

  function refineFromSignal() {
    const signalDb = 20 * Math.log10(Math.max(guitarPeak, 1e-9));
    const span = signalDb - floorDb;
    if (span < 6) return false; // guitar is barely above the room; leave it alone
    // Sit a third of the way up from the room toward the guitar, and always
    // keep clear air on both sides.
    const targetDb = Math.min(floorDb + Math.max(9, span * 0.35), signalDb - 6);
    const gate = Math.pow(10, targetDb / 20);
    store.setCalibration({ gate, noiseFloor: result.noiseFloor, signal: guitarPeak, sampleRate: result.sampleRate });
    engine.setGate(gate);
    guitarLine.className = 'banner is-good';
    guitarLine.textContent = '';
    guitarLine.append(
      h('b', { text: `Guitar ${db(guitarPeak)} · room ${db(result.noiseFloor)}` }),
      `${Math.round(span)} dB of headroom. Threshold set to ${db(gate)}, between the two.`
    );
    return true;
  }

  panel.append(
    h('div', { class: 'calib-steps' }, [h('i', { class: 'is-on' }), h('i', { class: 'is-on' }), h('i')]),
    h('div', { class: 'eyebrow', text: 'Step 2 of 2 · check the signal' }),
    h('h1', { text: 'Play a note' }),
    h('div', { class: `banner ${result.verdict.level === 'loud' ? 'is-bad' : result.verdict.level === 'quiet' ? 'is-good' : ''}` }, [
      h('b', { text: `Room noise ${db(result.noiseFloor)}` }),
      result.verdict.text,
    ]),
    readout,
    levelStrip,
    guitarLine,
    h('p', { class: 'lede', style: 'margin-inline:auto', text: 'Play a few notes at your normal playing strength. The threshold gets set from the gap between your guitar and the room, which works far better than the room alone.' }),
    h('div', { class: 'btn-row', style: 'justify-content:center;margin-top:20px' }, [
      h(
        'button',
        {
          class: 'btn is-primary',
          onclick: () => {
            if (off) off();
            if (thenStart && pendingStart) runSession(pendingStart);
            else {
              renderSetup();
              showScreen('setup');
            }
          },
        },
        [thenStart ? 'Start the session' : 'Done']
      ),
      h('button', { class: 'btn is-ghost', onclick: () => { if (off) off(); renderCalibrate({ thenStart }); } }, ['Redo calibration']),
    ])
  );

  const off = engine.onFrame((frame) => {
    paintStrip(levelStrip, frame.level);
    if (frame.midi != null && frame.stable) {
      readout.firstChild.textContent = noteName(frame.midi, store.settings().spelling);
      sub.textContent = `${frame.freq.toFixed(1)} Hz · ${frame.cents > 0 ? '+' : ''}${frame.cents} cents`;
      guitarPeak = Math.max(guitarPeak, frame.rms);
      goodFrames += 1;
      // Roughly a quarter-second of solid notes is enough to place the gate.
      if (goodFrames === 15 || (goodFrames > 15 && goodFrames % 30 === 0)) refineFromSignal();
    }
  });
}

/* ---------- session screen ------------------------------------------- */

function runSession(config) {
  pendingStart = null;
  const s = store.settings();
  const root = $('#screen-session');
  root.textContent = '';

  const guided = Boolean(config.guided);
  // Guided runs show notes and move on by themselves — there is nothing to
  // listen to and nothing to tap.
  const micMode = config.inputMode === 'mic' && !guided;

  const pips = h(
    'div',
    { class: 'pips' },
    Array.from({ length: config.prompts }, () => h('i'))
  );
  const counter = h('div', { class: 'eyebrow' }, [h('b', { text: '0' }), ` / ${config.prompts}`]);

  const verb = h('div', { class: 'ask-verb', text: 'get ready' });
  const glyphSlot = h('div', {}, [h('div', { class: 'glyph', text: '·' })]);
  const where = h('div', { class: 'ask-where' }, [h('b', { text: '' }), h('span', { text: '' })]);
  const clock = h('div', { class: 'clock', text: config.timerSeconds ? config.timerSeconds.toFixed(1) : '∞' });
  const clockBar = h('div', { class: 'clock-bar' }, [h('i', { style: 'width:100%' })]);
  const verdict = h('div', { class: 'verdict', text: '' });

  const needle = h('div', { class: 'meter-needle' });
  const meterNote = h('b', { text: '—' });
  const meterHz = h('b', { text: '0 Hz' });
  const levelStrip = h('div', { class: 'level-strip' }, Array.from({ length: 28 }, () => h('i')));
  const meter = h('div', { class: 'meter' }, [
    h('div', { class: 'meter-scale' }, [h('div', { class: 'meter-ticks' }), h('div', { class: 'meter-center' }), needle]),
    h('div', { class: 'meter-readout' }, [h('span', {}, ['heard ', meterNote]), h('span', {}, [meterHz])]),
    levelStrip,
  ]);

  // Metronome, when the drill asked for one: a row of beat lamps, one bar wide.
  const metroConf = config.metronome && config.metronome.bpm ? config.metronome : null;
  const beatsPerBar = metroConf ? clamp(metroConf.beatsPerBar || 4, 1, 12) : 0;
  const beatDots = Array.from({ length: beatsPerBar }, () => h('i'));
  const beatRow = h('div', { class: 'beat-row', hidden: !metroConf }, beatDots);

  const stage = h('div', { class: 'stage' }, [
    h('div', { class: 'ask' }, [
      h('div', { class: 'ask-side ask-left' }, [where]),
      h('div', { class: 'ask-side ask-center' }, [verb, glyphSlot]),
      h('div', { class: 'ask-side ask-right' }, [h('div', { class: 'eyebrow', text: 'clock' }), clock, clockBar, beatRow]),
    ]),
    verdict,
    micMode ? meter : null,
  ]);

  const boardHost = h('div', { class: 'board-wrap' });
  const choices = h('div', { class: 'choices' });
  const seqStrip = h('div', { class: guided ? 'seq is-guided' : 'seq', hidden: true });
  const hint = h('div', {
    class: 'hint-line',
    text: guided ? 'Nothing is being listened to — just play along.' : micMode ? 'Play the note on your guitar.' : 'Tap the fret on the board.',
  });
  const runProgress = h('div', { class: 'run-progress', hidden: true });

  const quitBtn = h('button', { class: 'btn is-ghost', onclick: () => confirmQuit() }, ['Quit']);
  const hearBtn = h('button', { class: 'btn is-ghost', onclick: () => playCurrentTone() }, ['Hear it']);
  const revealBtn = h('button', { class: 'btn is-ghost', onclick: () => activeSession && activeSession.reveal() }, ['Show answer']);

  root.append(
    h('div', { class: 'session-top' }, [
      h('div', {}, [h('div', { class: 'eyebrow', text: config.title }), counter]),
      h('div', { class: 'spacer' }),
      pips,
    ]),
    stage,
    seqStrip,
    choices,
    runProgress,
    hint,
    boardHost,
    h('div', { class: 'session-foot' }, [hearBtn, guided ? null : revealBtn, h('div', { class: 'spacer' }), quitBtn])
  );

  // Board: a scale lesson shows just its shape; a note lesson shows the neck.
  const isScale = Boolean(config.exercise && config.exercise !== 'note');
  let minFret = 0;
  let maxFret = 12;
  if (isScale) {
    const win = boxWindow(config.boxPositions, 1);
    minFret = win.minFret;
    maxFret = win.maxFret;
  } else {
    const frets = config.pool.map((n) => n.fret);
    maxFret = Math.min(MAX_FRET, Math.max(12, Math.max(...frets) + 1));
  }
  sessionBoard = createFretboard(boardHost, {
    minFret,
    maxFret,
    tuning: s.tuning,
    spelling: s.spelling,
    flip: s.flipBoard,
    interactive: !micMode && !guided,
  });

  showScreen('session');

  const session = new Session(config, {
    onCountIn: (n) => {
      verb.textContent = n > 0 ? 'starting' : 'go';
      glyphSlot.textContent = '';
      glyphSlot.appendChild(h('div', { class: 'glyph', text: n > 0 ? String(n) : '·' }));
    },
    onPrompt: (prompt) => paintPrompt(prompt),
    onAdvance: (prompt) => {
      // A guided slot walking itself from one note to the next.
      if (prompt.kind === 'run') paintRunBoard(prompt);
    },
    onTick: (secondsLeft, fraction) => {
      if (secondsLeft == null) {
        clock.textContent = '∞';
        clockBar.firstChild.style.width = '100%';
        return;
      }
      clock.textContent = secondsLeft.toFixed(1);
      const low = fraction < 0.28;
      clock.classList.toggle('is-low', low);
      clockBar.classList.toggle('is-low', low);
      clockBar.firstChild.style.width = pct(clamp(fraction, 0, 1));
    },
    onJudged: (info, sess) => paintJudgement(info, sess),
    onEnd: (summary) => {
      cleanupSession();
      renderResults(summary, config);
      showScreen('results');
      renderRail();
      renderPath();
      renderScales();
    },
  });

  activeSession = session;
  session.attach(micMode ? engine : null);

  // A run — a scale one or a drill sequence — plays notes far faster than a
  // single prompt, so accept each one a frame sooner. Restored from the user's
  // setting when the session ends.
  const runsNotes = isScale ? config.exercise === 'run' : (config.sequenceLength || 1) > 1;
  if (micMode && runsNotes) {
    engine.setStableFrames(3);
  }

  if (micMode) {
    meterUnsub = engine.onFrame((frame) => {
      paintStrip(levelStrip, frame.level);
      const cents = frame.midi != null ? clamp(frame.cents, -50, 50) : 0;
      needle.style.left = `${50 + cents}%`;
      needle.classList.toggle('is-intune', frame.midi != null && Math.abs(frame.cents) < 8);
      if (frame.midi != null && frame.stable) {
        meterNote.textContent = noteName(frame.midi, s.spelling);
        meterHz.textContent = `${frame.freq.toFixed(1)} Hz`;
      } else if (!frame.loud) {
        meterNote.textContent = '—';
        meterHz.textContent = 'quiet';
      }
    });
  }

  if (!micMode && !guided) {
    sessionBoard.onTap(({ string, fret }) => {
      if (!activeSession) return;
      if (activeSession.prompt && activeSession.prompt.style === 'position') return; // answer with the buttons
      activeSession.judge(midiAt(s.tuning, string, fret));
    });
  }

  if (metroConf) {
    // The click is the count-in: one bar of it, then the first slot lands on
    // the downbeat. The app's own count-in is off in this case, so they do not
    // talk over each other.
    let started = false;
    verb.textContent = 'count in';
    activeMetronome = new Metronome({ bpm: metroConf.bpm, beatsPerBar, sound: metroConf.sound !== false });
    activeMetronome.start((beat) => {
      paintBeat(beat);
      if (started) return;
      if (beat.index >= beatsPerBar) {
        started = true;
        session.start();
        return;
      }
      glyphSlot.textContent = '';
      glyphSlot.appendChild(h('div', { class: 'glyph', text: String(beatsPerBar - beat.index) }));
    });
  } else {
    session.start();
  }

  /* --- painters ----------------------------------------------------- */

  function paintPrompt(prompt) {
    stage.className = 'stage';
    verdict.textContent = '';
    verdict.className = 'verdict';
    counter.firstChild.textContent = String(prompt.number);
    updatePips(session);
    choices.textContent = '';
    glyphSlot.textContent = '';

    if (isScale) {
      paintScalePrompt(prompt);
      return;
    }

    if (prompt.kind === 'run') {
      paintSequencePrompt(prompt);
      return;
    }

    if (prompt.style === 'name') {
      verb.textContent = guided ? 'this note' : micMode ? 'play this note' : 'tap this note';
      glyphSlot.appendChild(glyphFor(prompt.name));
      where.firstChild.textContent = `${['1st', '2nd', '3rd', '4th', '5th', '6th'][prompt.note.string - 1]}`;
      where.lastChild.textContent = `string · ${shortName(prompt.note.string, 0)}`;
      sessionBoard.setMarkers([]);
      const place = `the ${prompt.note.string}${ordinalSuffix(prompt.note.string)} string`;
      hint.textContent = guided
        ? `${prompt.name} on ${place}. The clock moves on by itself.`
        : micMode
        ? `Find ${prompt.name} on ${place} and play it.`
        : `Tap ${prompt.name} on ${place}.`;
    } else {
      verb.textContent = micMode ? 'play the marked note' : 'name the marked note';
      glyphSlot.appendChild(h('div', { class: 'glyph', text: '?' }));
      where.firstChild.textContent = `${['1st', '2nd', '3rd', '4th', '5th', '6th'][prompt.note.string - 1]}`;
      where.lastChild.textContent = `string · fret ${prompt.note.fret}`;
      sessionBoard.setMarkers([{ ...prompt.note, kind: 'target', pulse: true }]);
      hint.textContent = micMode ? 'Play the highlighted position.' : 'Which note is this?';
      if (!micMode) buildChoices(prompt);
    }
  }

  function buildChoices(prompt) {
    const pcs = poolPitchClasses(config.pool);
    const options = new Set([prompt.pc]);
    const shuffled = pcs.filter((p) => p !== prompt.pc).sort(() => Math.random() - 0.5);
    for (const p of shuffled) {
      if (options.size >= Math.min(6, pcs.length)) break;
      options.add(p);
    }
    const list = [...options].sort(() => Math.random() - 0.5);
    for (const pc of list) {
      const midi = nearestMidiWithPc(pc, prompt.midi);
      const label = noteName(midi, s.spelling);
      const btn = h('button', { class: 'choice', text: label, onclick: () => {
        if (!activeSession || activeSession.state === 'correct') return;
        btn.classList.add(pc === prompt.pc ? 'is-right' : 'is-wrong');
        activeSession.judge(midi);
      } });
      choices.appendChild(btn);
    }
  }

  /** Ghost the whole shape, so the box is always visible while you work in it. */
  function shapeGhosts() {
    return config.boxPositions.map((p) => ({ string: p.string, fret: p.fret, kind: 'ghost' }));
  }

  function paintScalePrompt(prompt) {
    const scaleName = scaleTitle(config.scaleId, config.rootPc, s.spelling);

    if (prompt.kind === 'run') {
      verb.textContent = 'play in order';
      paintRunBoard(prompt);
      where.firstChild.textContent = scaleName;
      where.lastChild.textContent = `${prompt.steps.length} notes`;
      hint.textContent = config.restartOnError
        ? 'A wrong note sends you back to the start of the run.'
        : 'A wrong note waits for you — find the right one and carry on.';
      return;
    }

    if (prompt.kind === 'membership') {
      verb.textContent = 'stay in key';
      glyphSlot.appendChild(h('div', { class: 'glyph', text: `0/${prompt.needed}` }));
      where.firstChild.textContent = scaleName;
      where.lastChild.textContent = 'your notes, your order';
      sessionBoard.setMarkers(shapeGhosts());
      hint.textContent = `Any note in the shape. Use all ${prompt.distinctNeeded} of them, and no note twice in a row.`;
      return;
    }

    // degree / root
    const label = prompt.style === EXERCISE.ROOT ? shortName(prompt.note.string, prompt.note.fret) : prompt.degree || '?';
    verb.textContent = prompt.style === EXERCISE.ROOT ? 'play the root' : 'play this degree';
    glyphSlot.appendChild(h('div', { class: 'glyph', text: label }));
    where.firstChild.textContent = scaleName;
    where.lastChild.textContent = prompt.style === EXERCISE.ROOT ? 'anywhere in the shape' : 'any octave';
    sessionBoard.setMarkers(shapeGhosts());
    hint.textContent = 'Anywhere in the shape counts.';
  }

  /** A slot of notes drawn from the pool: play them in order, in one clock. */
  function paintSequencePrompt(prompt) {
    const count = prompt.steps.length;
    verb.textContent = guided ? 'play along' : micMode ? 'play these in order' : 'tap these in order';
    where.firstChild.textContent = `${count} notes`;
    where.lastChild.textContent = guided ? 'one after another' : 'in one slot';
    paintRunBoard(prompt);
    hint.textContent = guided
      ? 'Each note gets its share of the slot. Nothing is being judged.'
      : `Play all ${count} in order before the clock runs out. A wrong note waits for you.`;
  }

  function paintRunBoard(prompt) {
    const markers = [];
    prompt.steps.forEach((step, i) => {
      // A guided run marks what has gone by rather than what was got right —
      // nothing here was judged.
      if (i < prompt.stepIndex) markers.push({ ...step, kind: guided ? 'hint' : 'correct' });
      else if (i === prompt.stepIndex) markers.push({ ...step, kind: 'target', pulse: true, label: step.degree });
      else markers.push({ string: step.string, fret: step.fret, kind: 'ghost' });
    });
    sessionBoard.setMarkers(markers);

    const step = prompt.steps[prompt.stepIndex];
    glyphSlot.textContent = '';
    if (step) {
      const g = glyphFor(noteName(step.midi, s.spelling));
      glyphSlot.appendChild(g);
    }
    counter.firstChild.textContent = String(prompt.number);
    runProgress.textContent = `note ${Math.min(prompt.stepIndex + 1, prompt.steps.length)} of ${prompt.steps.length}`;
    runProgress.hidden = false;
    // A scale run already has its whole shape on the board; a drill sequence
    // needs the order spelled out.
    if (!isScale) paintSeqStrip(prompt);
  }

  function paintSeqStrip(prompt) {
    seqStrip.textContent = '';
    seqStrip.hidden = false;
    prompt.steps.forEach((step, i) => {
      const state = i < prompt.stepIndex ? 'is-done' : i === prompt.stepIndex ? 'is-now' : '';
      seqStrip.appendChild(h('i', { class: state, text: noteName(step.midi, s.spelling).split('/')[0] }));
    });
  }

  function paintBeat(beat) {
    for (let i = 0; i < beatDots.length; i++) {
      beatDots[i].className = i === beat.beatInBar ? (beat.accent ? 'is-on is-accent' : 'is-on') : '';
    }
  }

  function paintJudgement(info, sess) {
    const prompt = sess.prompt;

    if (info.verdict === 'advance') {
      // Guided: the slot simply ran its course.
      updatePips(sess);
      return;
    }

    if (info.verdict === 'step') {
      stage.className = 'stage';
      verdict.className = 'verdict is-correct';
      if (prompt.kind === 'run') {
        paintRunBoard(prompt);
        verdict.textContent = '';
      } else {
        glyphSlot.textContent = '';
        glyphSlot.appendChild(h('div', { class: 'glyph', text: `${info.counted}/${info.needed}` }));
        const missing = info.distinctNeeded - info.distinct;
        verdict.textContent = missing > 0 ? `${missing} more of the scale still to use` : 'all notes used — keep going';
        sessionBoard.setMarkers([
          ...shapeGhosts(),
          ...config.boxPositions
            .filter((p) => prompt.distinct.has(pitchClass(p.midi)))
            .map((p) => ({ string: p.string, fret: p.fret, kind: 'correct' })),
        ]);
      }
      return;
    }

    if (info.verdict === 'repeat') {
      verdict.className = 'verdict';
      verdict.textContent = 'Same note again — pick a different one.';
      return;
    }

    if (!isScale && prompt.kind === 'run') {
      paintSequenceJudgement(info, sess);
      return;
    }

    if (isScale) {
      if (info.verdict === 'correct') {
        stage.className = 'stage is-correct';
        const g = glyphSlot.firstChild;
        if (g) g.classList.add('is-correct');
        if (prompt.kind === 'run') {
          sessionBoard.setMarkers(prompt.steps.map((st) => ({ ...st, kind: 'correct' })));
        }
        verdict.className = 'verdict is-correct';
        verdict.textContent = info.firstTry
          ? `Clean — ${(info.ms / 1000).toFixed(1)}s`
          : `Done in ${(info.ms / 1000).toFixed(1)}s, with ${sess.wrongThisPrompt.length} slip${sess.wrongThisPrompt.length === 1 ? '' : 's'}`;
        updatePips(sess);
        return;
      }
      if (info.verdict === 'wrong') {
        stage.className = 'stage is-wrong';
        verdict.className = 'verdict is-wrong';
        if (info.outOfKey) {
          verdict.textContent = `${info.playedName} is not in this scale.`;
        } else if (info.restarted) {
          verdict.textContent = `That was ${info.playedName} — back to the top of the run.`;
          paintRunBoard(prompt);
        } else {
          verdict.textContent = `That was ${info.playedName} — the run wants ${noteName(info.expected.midi, s.spelling)}.`;
        }
        setTimeout(() => {
          if (sess.state === 'awaiting') stage.className = 'stage';
        }, 420);
        return;
      }
      if (info.verdict === 'timeout') {
        stage.className = 'stage is-revealed';
        verdict.className = 'verdict is-wrong';
        verdict.textContent =
          prompt.kind === 'run'
            ? `Time — you got ${prompt.stepIndex} of ${prompt.steps.length} notes.`
            : `Time — ${prompt.counted || 0} of ${prompt.needed} notes.`;
        updatePips(sess);
        return;
      }
    }

    if (info.verdict === 'correct') {
      stage.className = 'stage is-correct';
      const g = glyphSlot.firstChild;
      if (g) g.classList.add('is-correct');
      if (prompt.style === 'position') {
        glyphSlot.textContent = '';
        const el = glyphFor(prompt.name);
        el.classList.add('is-correct');
        glyphSlot.appendChild(el);
      }
      sessionBoard.setMarkers([{ ...prompt.note, kind: 'correct', label: shortName(prompt.note.string, prompt.note.fret) }]);
      const secs = (info.ms / 1000).toFixed(1);
      verdict.className = 'verdict is-correct';
      const drift =
        micMode && Math.abs(info.offCents || 0) >= 35
          ? ` · ${Math.abs(info.offCents)} cents ${info.offCents > 0 ? 'sharp' : 'flat'}, worth a tune`
          : '';
      verdict.textContent = info.firstTry
        ? `Right — ${secs}s${info.octaveNote ? ` (an octave ${info.octaveNote}, but the right note)` : ''}${drift}`
        : `Got it — ${secs}s after ${info.attempts || sess.wrongThisPrompt.length} miss${(sess.wrongThisPrompt.length || 1) > 1 ? 'es' : ''}${drift}`;
    } else if (info.verdict === 'wrong') {
      stage.className = 'stage is-wrong';
      verdict.className = 'verdict is-wrong';
      verdict.textContent = `That was ${info.playedName}${info.playedOctave != null ? info.playedOctave : ''} — try again.`;
      setTimeout(() => {
        if (sess.state === 'awaiting') stage.className = 'stage';
      }, 420);
    } else if (info.verdict === 'timeout') {
      stage.className = 'stage is-revealed';
      verdict.className = 'verdict is-wrong';
      verdict.textContent = `Time — it was ${prompt.name} at fret ${prompt.note.fret}.`;
      if (prompt.style === 'position') {
        glyphSlot.textContent = '';
        glyphSlot.appendChild(glyphFor(prompt.name));
      }
      sessionBoard.setMarkers([{ ...prompt.note, kind: 'wrong', label: shortName(prompt.note.string, prompt.note.fret) }]);
      if (store.settings().sound) playNoteTone(prompt.midi, s.a4, 700);
    }
    updatePips(sess);
  }

  /** The end of a drill sequence: the whole slot, not one note. */
  function paintSequenceJudgement(info, sess) {
    const prompt = sess.prompt;
    if (info.verdict === 'correct') {
      stage.className = 'stage is-correct';
      const g = glyphSlot.firstChild;
      if (g) g.classList.add('is-correct');
      sessionBoard.setMarkers(prompt.steps.map((st) => ({ ...st, kind: 'correct' })));
      for (const chip of seqStrip.children) chip.className = 'is-done';
      verdict.className = 'verdict is-correct';
      const secs = (info.ms / 1000).toFixed(1);
      verdict.textContent = info.firstTry
        ? `Clean — all ${prompt.steps.length} in ${secs}s`
        : `Done in ${secs}s, with ${sess.wrongThisPrompt.length} slip${sess.wrongThisPrompt.length === 1 ? '' : 's'}`;
    } else if (info.verdict === 'wrong') {
      stage.className = 'stage is-wrong';
      verdict.className = 'verdict is-wrong';
      verdict.textContent = `That was ${info.playedName} — the slot wants ${noteName(info.expected.midi, s.spelling)}.`;
      setTimeout(() => {
        if (sess.state === 'awaiting') stage.className = 'stage';
      }, 420);
    } else if (info.verdict === 'timeout') {
      stage.className = 'stage is-revealed';
      verdict.className = 'verdict is-wrong';
      verdict.textContent = `Time — you got ${prompt.stepIndex} of ${prompt.steps.length} notes.`;
      sessionBoard.setMarkers(
        prompt.steps.map((st, i) => ({ ...st, kind: i < prompt.stepIndex ? 'correct' : 'wrong', label: shortName(st.string, st.fret) }))
      );
    }
    updatePips(sess);
  }

  function updatePips(sess) {
    const kids = pips.children;
    for (let i = 0; i < kids.length; i++) {
      if (guided) {
        // Nothing was judged, so a pip only says whether that slot has been.
        kids[i].className = i < sess.slotsShown ? 'is-past' : i === sess.slotsShown ? 'is-now' : '';
        continue;
      }
      const r = sess.results[i];
      kids[i].className = r ? (r.correct ? 'is-ok' : 'is-bad') : i === sess.results.length ? 'is-now' : '';
    }
  }

  function playCurrentTone() {
    if (activeSession && activeSession.prompt) playNoteTone(activeSession.prompt.midi, s.a4, 900);
  }

  function ordinalSuffix(n) {
    return n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  }
}

function nearestMidiWithPc(pc, referenceMidi) {
  const base = referenceMidi - (((referenceMidi % 12) - pc + 12) % 12);
  const options = [base, base + 12, base - 12];
  return options.reduce((best, m) => (Math.abs(m - referenceMidi) < Math.abs(best - referenceMidi) ? m : best), base);
}

function confirmQuit() {
  openSheet('Leave this session?', ['Answers so far are already saved against each note, but the session will not count toward the level.'], [
    h('button', {
      class: 'btn is-danger',
      onclick: () => {
        const wasScale = Boolean(activeSession && activeSession.config.scaleLessonId);
        closeSheet();
        cleanupSession();
        renderRail();
        renderPath();
        renderScales();
        showScreen(wasScale ? 'scales' : 'path');
      },
    }, ['Leave']),
    h('button', { class: 'btn is-ghost', onclick: closeSheet }, ['Keep going']),
  ]);
}

function cleanupSession() {
  if (activeSession) activeSession.stop();
  activeSession = null;
  if (activeMetronome) activeMetronome.stop();
  activeMetronome = null;
  // Undo any per-exercise detection tweak.
  engine.setSensitivity(store.settings().detectionSensitivity);
  if (meterUnsub) meterUnsub();
  meterUnsub = null;
}

/* ---------- results --------------------------------------------------- */

function renderResults(summary, config) {
  const root = $('#screen-results');
  root.textContent = '';
  if (summary.guided) return renderGuidedResults(root, summary, config);
  const s = store.settings();
  const passed = summary.requiredAccuracy == null || summary.accuracy >= summary.requiredAccuracy;

  if (summary.leveledTo && s.sound) playLevelUp();

  // Results are shared by both tracks, so look the lesson up in the right one.
  const onScaleTrack = Boolean(config.scaleLessonId);
  const lesson = summary.lessonId
    ? (onScaleTrack ? SCALE_LESSON_BY_ID.get(summary.lessonId) : LESSON_BY_ID.get(summary.lessonId))
    : null;
  const nextLesson = lesson ? (onScaleTrack ? SCALE_LESSONS[lesson.index + 1] : LESSONS[lesson.index + 1]) : null;
  const nextTitle = nextLesson ? (onScaleTrack ? nextLesson.title : lessonTitle(nextLesson)) : null;

  root.appendChild(
    h('div', {}, [
      h('div', { class: 'eyebrow', text: summary.title }),
      h('h1', { text: summary.leveledTo ? `Level ${summary.leveledTo} cleared` : passed ? 'Session complete' : 'Not quite yet' }),
    ])
  );

  root.appendChild(
    h('div', { class: 'result-grid' }, [
      h('div', { class: `tile ${summary.accuracy >= 0.9 ? 'is-good' : summary.accuracy < 0.6 ? 'is-bad' : ''}` }, [
        h('span', { text: 'First-try accuracy' }),
        h('b', { text: pct(summary.accuracy) }),
        h('small', { text: `${summary.correct} of ${summary.prompts}` }),
      ]),
      h('div', { class: 'tile' }, [
        h('span', { text: 'Average time' }),
        h('b', { text: summary.avgMs ? `${(summary.avgMs / 1000).toFixed(1)}s` : '—' }),
        h('small', { text: 'on correct answers' }),
      ]),
      h('div', { class: 'tile is-accent' }, [h('span', { text: 'XP earned' }), h('b', { text: `+${summary.xp}` })]),
      h('div', { class: 'tile' }, [
        h('span', { text: 'Pool mastery' }),
        h('b', { text: pct(summary.mastery) }),
        h('small', { text: 'these notes' }),
      ]),
    ])
  );

  if (summary.requiredAccuracy != null) {
    root.appendChild(
      h('div', { class: `banner ${summary.leveledTo ? 'is-good' : passed ? '' : 'is-bad'}` }, [
        h('b', { text: summary.leveledTo ? `Unlocked level ${summary.leveledTo}` : passed ? 'Level held' : `Needed ${pct(summary.requiredAccuracy)} to level up` }),
        summary.leveledTo
          ? nextLesson
            ? `Next stop: ${nextTitle}.`
            : 'That is the end of the path — keep reviewing to hold it.'
          : passed
          ? 'Run it again to push the level higher.'
          : 'Run it again — the notes you missed will come up more often.',
      ])
    );
  }

  if (summary.trouble.some((t) => t.note)) {
    root.appendChild(h('div', { class: 'eyebrow', style: 'margin-top:18px', text: 'Notes that fought back' }));
    root.appendChild(
      h(
        'div',
        { class: 'badge-row' },
        summary.trouble.filter((t) => t.note).map((t) => noteBadge(s.tuning, t.note.string, t.note.fret, s.spelling))
      )
    );
  }

  root.appendChild(
    h('div', { class: 'btn-row', style: 'margin-top:24px' }, [
      h('button', { class: 'btn is-primary', onclick: () => beginSession({ ...config }) }, ['Run it again']),
      nextLesson && summary.leveledTo && (onScaleTrack ? scaleLessonState(nextLesson) !== 'locked' : lessonState(nextLesson) !== 'locked')
        ? h('button', {
            class: 'btn',
            onclick: () => (onScaleTrack ? startScaleLesson(nextLesson.id) : startLesson(nextLesson.id)),
          }, ['Next lesson'])
        : null,
      h('button', {
        class: 'btn is-ghost',
        onclick: () => {
          if (config.scaleLessonId) { renderScales(); showScreen('scales'); }
          else { renderPath(); showScreen('path'); }
        },
      }, [config.scaleLessonId ? 'Back to scales' : 'Back to path']),
    ])
  );
}

/** A guided run has no score to show, so it reports what it put in front of you. */
function renderGuidedResults(root, summary, config) {
  const minutes = summary.durationMs / 60000;
  root.append(
    h('div', {}, [h('div', { class: 'eyebrow', text: summary.title }), h('h1', { text: 'Run complete' })]),
    h('div', { class: 'result-grid' }, [
      h('div', { class: 'tile is-accent' }, [
        h('span', { text: 'Notes shown' }),
        h('b', { text: String(summary.notesShown) }),
        h('small', { text: `${summary.slots} slot${summary.slots === 1 ? '' : 's'} of ${summary.sequenceLength}` }),
      ]),
      h('div', { class: 'tile' }, [
        h('span', { text: 'Time played' }),
        h('b', { text: minutes >= 1 ? `${minutes.toFixed(1)}m` : `${Math.round(summary.durationMs / 1000)}s` }),
        h('small', { text: `${summary.secondsPerSlot}s per slot` }),
      ]),
      h('div', { class: 'tile' }, [
        h('span', { text: 'Tempo' }),
        h('b', { text: summary.bpm ? `${summary.bpm}` : '—' }),
        h('small', { text: summary.bpm ? 'bpm' : 'no metronome' }),
      ]),
    ]),
    h('div', { class: 'banner' }, [
      h('b', { text: 'Nothing was scored' }),
      'A guided run listens to nothing, so it earns no XP and moves no note up or down its schedule. Turn the toggle off when you want it to count.',
    ]),
    h('div', { class: 'btn-row', style: 'margin-top:24px' }, [
      h('button', { class: 'btn is-primary', onclick: () => beginSession({ ...config }) }, ['Run it again']),
      h('button', {
        class: 'btn',
        onclick: () => beginSession({ ...config, guided: false, inputMode: store.settings().inputMode }),
      }, ['Same drill, for real']),
      h('button', { class: 'btn is-ghost', onclick: () => { renderDrill(); showScreen('drill'); } }, ['Back to drills']),
    ])
  );
}

/* ---------- progress screen ------------------------------------------ */

export function renderProgress() {
  const root = $('#screen-progress');
  root.textContent = '';
  const s = store.settings();
  const st = store.stats();
  const lvl = store.levelFromXp(st.xp);
  const overall = overallMastery();
  const mastered = ALL_POSITIONS.filter((n) => masteryFor(n.string, n.fret) >= 0.85).length;
  const seen = seenPositions().length;
  const lifetimeAcc = st.prompts ? st.correct / st.prompts : 0;

  root.append(
    h('div', { class: 'eyebrow', text: 'Where you actually are' }),
    h('h1', { text: 'Progress' }),
    h('div', { class: 'result-grid' }, [
      h('div', { class: 'tile is-accent' }, [
        h('span', { text: 'Fretboard mastered' }),
        h('b', { text: pct(overall) }),
        h('small', { text: `${mastered} of ${ALL_POSITIONS.length} positions solid` }),
      ]),
      h('div', { class: 'tile' }, [h('span', { text: 'Notes met' }), h('b', { text: String(seen) }), h('small', { text: 'seen at least once' })]),
      h('div', { class: 'tile' }, [
        h('span', { text: 'Lifetime accuracy' }),
        h('b', { text: pct(lifetimeAcc) }),
        h('small', { text: `${st.prompts} prompts` }),
      ]),
      h('div', { class: 'tile' }, [
        h('span', { text: 'Level' }),
        h('b', { text: `L${lvl.level}` }),
        h('small', { text: `${lvl.into}/${lvl.need} XP` }),
      ]),
      h('div', { class: 'tile' }, [
        h('span', { text: 'Streak' }),
        h('b', { text: String(store.currentStreak()) }),
        h('small', { text: `best ${st.longestStreak}` }),
      ]),
      h('div', { class: 'tile' }, [h('span', { text: 'Sessions' }), h('b', { text: String(st.sessions) })]),
    ])
  );

  const boardHost = h('div', { class: 'board-wrap' });
  const heatPanel = h('div', { class: 'panel', style: 'margin-top:22px' }, [
    h('div', { class: 'eyebrow', text: 'Every position, coloured by how well you know it' }),
    boardHost,
  ]);
  root.appendChild(heatPanel);

  progressBoard = createFretboard(boardHost, {
    minFret: 0,
    maxFret: MAX_FRET,
    tuning: s.tuning,
    spelling: s.spelling,
    flip: s.flipBoard,
    interactive: false,
  });

  const heat = {};
  for (const n of ALL_POSITIONS) heat[posKey(n.string, n.fret)] = masteryFor(n.string, n.fret);
  progressBoard.setHeatmap(heat);

  heatPanel.appendChild(
    h('div', { class: 'mastery-legend' }, [
      h('span', { class: 'legend-swatch' }, [h('i', { style: `background:${progressBoard.heatColor(0)}` }), 'not met']),
      h('span', { class: 'legend-swatch' }, [h('i', { style: `background:${progressBoard.heatColor(0.35)}` }), 'learning']),
      h('span', { class: 'legend-swatch' }, [h('i', { style: `background:${progressBoard.heatColor(0.7)}` }), 'getting there']),
      h('span', { class: 'legend-swatch' }, [h('i', { style: `background:${progressBoard.heatColor(1)}` }), 'mastered']),
    ])
  );

  // Per-string mastery
  const bars = h('div', { class: 'bars' });
  for (let str = 6; str >= 1; str--) {
    const positions = ALL_POSITIONS.filter((n) => n.string === str);
    const value = positions.reduce((a, n) => a + masteryFor(n.string, n.fret), 0) / Math.max(1, positions.length);
    bars.appendChild(
      h('div', { class: 'bar-row' }, [
        h('span', { text: `${str} · ${shortName(str, 0)}` }),
        h('div', { class: 'bar-track' }, [h('i', { style: `width:${pct(value)}` })]),
        h('em', { text: pct(value) }),
      ])
    );
  }
  root.appendChild(h('div', { class: 'panel', style: 'margin-top:22px' }, [h('div', { class: 'eyebrow', text: 'Mastery by string' }), bars]));

  // Weakest notes
  const weak = seenPositions()
    .map((n) => ({ n, m: masteryFor(n.string, n.fret), rec: store.noteRecord(posKey(n.string, n.fret)) }))
    .filter((x) => x.rec && x.rec.reps >= 2)
    .sort((a, b) => a.m - b.m)
    .slice(0, 10);

  if (weak.length) {
    root.appendChild(
      h('div', { class: 'panel', style: 'margin-top:22px' }, [
        h('div', { class: 'eyebrow', text: 'Weakest notes right now' }),
        h(
          'div',
          { class: 'badge-row' },
          weak.map((x) => noteBadge(s.tuning, x.n.string, x.n.fret, s.spelling))
        ),
        h('div', { class: 'btn-row', style: 'margin-top:16px' }, [
          h(
            'button',
            {
              class: 'btn',
              onclick: () =>
                beginSession({
                  pool: weak.map((x) => x.n),
                  prompts: 15,
                  title: 'Drill · weakest notes',
                  timerSeconds: s.timerSeconds,
                  inputMode: s.inputMode,
                  promptStyle: s.promptStyle,
                }),
            },
            ['Drill these 10']
          ),
        ]),
      ])
    );
  }

  // History
  if (st.history.length) {
    const list = h('div', { class: 'history' });
    for (const entry of st.history.slice(0, 12)) {
      list.appendChild(
        h('div', { class: 'history-row' }, [
          h('b', { text: entry.title }),
          h('em', { text: pct(entry.accuracy) }),
          h('em', { text: entry.avgMs ? `${(entry.avgMs / 1000).toFixed(1)}s` : '—' }),
          h('em', { text: new Date(entry.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }),
        ])
      );
    }
    root.appendChild(h('div', { class: 'panel', style: 'margin-top:22px' }, [h('div', { class: 'eyebrow', text: 'Recent sessions' }), list]));
  }
}

/* ---------- drill screen ---------------------------------------------- */

export function renderDrill() {
  const root = $('#screen-drill');
  root.textContent = '';
  const s = store.settings();

  root.append(
    h('div', { class: 'eyebrow', text: 'Practice outside the path' }),
    h('h1', { text: 'Drills' }),
    h('p', { class: 'lede', text: 'Free practice. Nothing here unlocks lessons, but every answer still feeds the same spaced-repetition schedule.' })
  );

  const due = duePositions();
  const seen = seenPositions();

  const quick = h('div', { class: 'result-grid' }, [
    drillCard('Review', `${due.length} due`, 'Notes the schedule says are ready to come back.', () => startReview(), due.length === 0),
    drillCard('Everything met', `${seen.length} notes`, 'Every position you have seen at least once.', () =>
      beginSession({
        pool: seen,
        prompts: 20,
        title: 'Drill · everything met',
        timerSeconds: s.timerSeconds,
        inputMode: s.inputMode,
        promptStyle: s.promptStyle,
      }), seen.length === 0),
    drillCard('Speed run', '3s clock', 'Same notes, tighter clock. Good for the last mile.', () =>
      beginSession({
        pool: seen.length ? seen : ALL_POSITIONS.filter((n) => n.string === 6),
        prompts: 20,
        title: 'Drill · speed run',
        timerSeconds: 3,
        inputMode: s.inputMode,
        promptStyle: s.promptStyle,
      })),
  ]);
  root.appendChild(quick);

  // Custom drill builder
  const stringBoxes = h(
    'div',
    { class: 'checkgrid' },
    [6, 5, 4, 3, 2, 1].map((n) =>
      h('label', {}, [
        h('input', { type: 'checkbox', value: String(n), checked: true, class: 'drill-string' }),
        `${n} · ${shortName(n, 0)}`,
      ])
    )
  );

  const minFret = h('input', { type: 'number', min: '0', max: String(MAX_FRET), value: '0', style: 'max-width:100px' });
  const maxFret = h('input', { type: 'number', min: '0', max: String(MAX_FRET), value: '12', style: 'max-width:100px' });
  const naturalsOnly = h('input', { type: 'checkbox', checked: true });
  const promptCount = h('input', { type: 'number', min: '5', max: '60', value: '20', style: 'max-width:100px' });
  const customClock = clockSlider(s.timerSeconds, 'Time per slot');

  /* --- pacing: how many notes a slot holds, and what moves it along --- */
  const sequence = sequenceSlider(1, () => syncPacing());
  const guidedOn = h('input', { type: 'checkbox', onchange: () => syncPacing() });
  const metroOn = h('input', { type: 'checkbox', onchange: () => syncPacing() });
  const bpm = h('input', {
    type: 'number',
    min: String(MIN_BPM),
    max: String(MAX_BPM),
    value: '80',
    style: 'max-width:100px',
    oninput: () => syncPacing(),
  });
  const beatsPerNote = select([['1', 'one beat'], ['2', 'two beats'], ['4', 'four beats']], '1', () => syncPacing());
  const beatsPerBar = select([['4', 'every 4'], ['3', 'every 3'], ['2', 'every 2'], ['6', 'every 6']], '4', () => syncPacing());
  const metroRows = h('div', { hidden: true }, [
    h('div', { class: 'field' }, [h('label', { text: 'Tempo (bpm)' }), bpm]),
    h('div', { class: 'field' }, [h('label', { text: 'Each note gets' }), beatsPerNote]),
    h('div', { class: 'field' }, [h('label', { text: 'Accent the click' }), beatsPerBar]),
  ]);
  const paceNote = h('div', { class: 'help' });

  /** Seconds a slot lasts, from whichever control is currently in charge. */
  function slotSeconds() {
    if (!metroOn.checked) return customClock.seconds();
    const tempo = clamp(Number(bpm.value) || 80, MIN_BPM, MAX_BPM);
    const beats = Number(beatsPerNote.value) || 1;
    return Math.round(((60 / tempo) * beats * sequence.length() * 100)) / 100;
  }

  function syncPacing() {
    metroRows.hidden = !metroOn.checked;
    customClock.field.hidden = metroOn.checked;
    const notes = sequence.length();
    const seconds = slotSeconds();
    const per = notes > 1 ? ` · ${(seconds / notes).toFixed(2)}s a note` : '';
    if (metroOn.checked) {
      paceNote.textContent = `${notes} note${notes > 1 ? 's' : ''} a slot at ${clamp(Number(bpm.value) || 80, MIN_BPM, MAX_BPM)} bpm — ${seconds.toFixed(2)}s per slot${per}. The click sits above the range the detector listens in, so it cannot answer for you.`;
    } else if (!seconds) {
      paceNote.textContent = guidedOn.checked
        ? 'A guided run has nothing but the clock to move it along, so it needs one — raise the slider or switch the metronome on.'
        : 'No clock: each slot waits for you.';
    } else {
      paceNote.textContent = `${notes} note${notes > 1 ? 's' : ''} in ${seconds}s${per}.`;
    }
  }
  syncPacing();

  root.appendChild(scaleDrillPanel());

  root.appendChild(
    h('div', { class: 'panel', style: 'margin-top:22px' }, [
      h('div', { class: 'eyebrow', text: 'Build your own' }),
      h('h2', { text: 'Custom drill', style: 'margin:6px 0 16px' }),
      h('div', { class: 'cols' }, [
        h('div', {}, [
          h('div', { class: 'field' }, [h('label', { text: 'Strings' }), stringBoxes]),
          h('div', { class: 'field' }, [
            h('label', { text: 'Fret range' }),
            h('div', { style: 'display:flex;gap:10px;align-items:center' }, [minFret, h('span', { text: 'to' }), maxFret]),
          ]),
          h('div', { class: 'field' }, [
            h('label', { text: 'Note set' }),
            h('label', { class: 'switch' }, [naturalsOnly, 'Natural notes only (no sharps or flats)']),
          ]),
          h('div', { class: 'field' }, [
            h('label', { text: 'Slots' }),
            promptCount,
            h('div', { class: 'help', text: 'How many times it asks. One slot holds the whole sequence.' }),
          ]),
        ]),
        h('div', {}, [
          sequence.field,
          h('div', { class: 'field' }, [
            h('label', { text: 'Metronome' }),
            h('label', { class: 'switch' }, [metroOn, 'Click the beat, and pace the slots by it']),
          ]),
          metroRows,
          customClock.field,
          h('div', { class: 'field' }, [
            h('label', { text: 'Guided run' }),
            h('label', { class: 'switch' }, [guidedOn, 'Just show me notes — no microphone, no score']),
            h('div', {
              class: 'help',
              text: 'The notes go by on the clock and nothing is judged, counted or scheduled. Good for warming up, or for playing along to a tempo.',
            }),
          ]),
          h('div', { class: 'field' }, [paceNote]),
        ]),
      ]),
      h('div', { class: 'btn-row' }, [
        h(
          'button',
          {
            class: 'btn is-primary',
            onclick: () => {
              const strings = [...root.querySelectorAll('.drill-string')].filter((b) => b.checked).map((b) => Number(b.value));
              const lo = clamp(Number(minFret.value) || 0, 0, MAX_FRET);
              const hi = clamp(Number(maxFret.value) || 12, lo, MAX_FRET);
              const pool = [];
              for (const str of strings) {
                for (let f = lo; f <= hi; f++) {
                  if (naturalsOnly.checked && !isNatural(midiAt(s.tuning, str, f))) continue;
                  pool.push({ string: str, fret: f });
                }
              }
              if (pool.length < 2) {
                toast('That leaves fewer than two notes — widen the range.', 'bad');
                return;
              }
              const notes = sequence.length();
              const seconds = slotSeconds();
              const guided = guidedOn.checked;
              if (guided && !seconds) {
                toast('A guided run needs a clock — nothing else would move it along.', 'bad');
                return;
              }
              const metronome = metroOn.checked
                ? {
                    bpm: clamp(Number(bpm.value) || 80, MIN_BPM, MAX_BPM),
                    beatsPerNote: Number(beatsPerNote.value) || 1,
                    beatsPerBar: Number(beatsPerBar.value) || 4,
                    sound: true,
                  }
                : null;
              const parts = [`${strings.length} string${strings.length > 1 ? 's' : ''}, frets ${lo}–${hi}`];
              if (notes > 1) parts.push(`runs of ${notes}`);
              if (metronome) parts.push(`${metronome.bpm} bpm`);
              if (guided) parts.push('guided');
              beginSession({
                pool,
                prompts: clamp(Number(promptCount.value) || 20, 5, 60),
                title: `Drill · ${parts.join(' · ')}`,
                timerSeconds: seconds,
                inputMode: s.inputMode,
                // A guided run shows the name and never asks you to name a
                // marked fret, which there would be no way to answer.
                promptStyle: guided ? 'name' : s.promptStyle,
                sequenceLength: notes,
                guided,
                metronome,
                // The click is its own count-in; two at once is a mess.
                countIn: metronome ? false : undefined,
              });
            },
          },
          ['Start drill']
        ),
      ]),
    ])
  );
}

/** A labelled clock slider. Returns the element plus a live value getter. */
function clockSlider(initialSeconds, label = 'Time per note') {
  const value = h('b', { text: initialSeconds ? `${initialSeconds}s` : 'no clock', style: 'font-family:var(--font-mono)' });
  const input = h('input', {
    type: 'range',
    min: '0',
    max: '60',
    step: '1',
    value: String(initialSeconds),
    oninput: (e) => {
      const v = Number(e.target.value);
      value.textContent = v ? `${v}s` : 'no clock';
    },
  });
  const field = h('div', { class: 'field' }, [
    h('label', {}, [`${label} · `, value]),
    input,
    h('div', { class: 'help', text: 'Slide to zero to practise with no clock at all.' }),
  ]);
  return { field, seconds: () => Number(input.value) };
}

/** How many notes one slot asks for. 1 is the ordinary one-note-at-a-time drill. */
function sequenceSlider(initial = 1, onInput) {
  const value = h('b', { text: describeSequence(initial), style: 'font-family:var(--font-mono)' });
  const input = h('input', {
    type: 'range',
    min: '1',
    max: String(MAX_SEQUENCE),
    step: '1',
    value: String(initial),
    oninput: () => {
      value.textContent = describeSequence(Number(input.value));
      if (onInput) onInput(Number(input.value));
    },
  });
  const field = h('div', { class: 'field' }, [
    h('label', {}, ['Notes per slot · ', value]),
    input,
    h('div', {
      class: 'help',
      text: 'Above one, each slot is a short run: A, then E, then G, played in that order inside the one clock.',
    }),
  ]);
  return { field, length: () => Number(input.value) };
}

function describeSequence(n) {
  return n === 1 ? 'one at a time' : `${n} in a row`;
}

/** Free scale practice — any shape, any key, no effect on the scales path. */
function startScaleDrill({ scaleId, rootPc, boxIndex, exercise, direction, octaveOnly, seconds, prompts }) {
  const s = store.settings();
  const pseudo = { scaleId, rootPc, boxIndex, exercise, direction, octaveOnly };
  const positions = boxPositions(scaleId, rootPc, boxIndex);
  if (!positions.length) {
    toast('That shape does not fit on the neck. Try a lower root or box.', 'bad');
    return;
  }

  const config = {
    exercise,
    title: `Drill · ${scaleTitle(scaleId, rootPc, s.spelling)} box ${boxIndex + 1}`,
    prompts,
    timerSeconds: seconds,
    inputMode: s.inputMode,
    promptStyle: 'name',
    boxPositions: positions,
    scaleId,
    rootPc,
    restartOnError: false,
  };

  if (exercise === EXERCISE.RUN) config.steps = runSteps(pseudo);
  else if (exercise === EXERCISE.KEY) {
    config.allowedPcs = scalePitchSet(pseudo);
    config.notesNeeded = 12;
  } else config.pool = lessonPositions(pseudo);

  if (config.steps && config.steps.length < 2) {
    toast('That shape came out too short to run.', 'bad');
    return;
  }
  beginSession(config);
}

/** Scale drill builder: any shape, any key, any of the four exercises. */
function scaleDrillPanel() {
  const s = store.settings();
  const scaleIds = Object.keys(SCALES);
  const roots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  const scaleSel = select(scaleIds.map((id) => [id, SCALES[id].name]), 'minorPentatonic', () => syncBoxes());
  const rootSel = select(roots.map((pc) => [String(pc), rootName(pc, s.spelling)]), '9', () => syncBoxes());
  const boxSel = h('select', {});
  const exerciseSel = select(
    [
      ['run-up', 'Run — ascending'],
      ['run-down', 'Run — descending'],
      ['run-oct', 'Run — one octave'],
      [EXERCISE.ROOT, 'Find the roots'],
      [EXERCISE.DEGREE, 'Name the degrees'],
      [EXERCISE.KEY, 'Stay in key'],
    ],
    'run-up',
    () => {}
  );
  const rounds = h('input', { type: 'number', min: '1', max: '30', value: '4', style: 'max-width:100px' });
  const clock = clockSlider(20, 'Clock per round');
  const fitNote = h('div', { class: 'help' });

  function syncBoxes() {
    const scaleId = scaleSel.value;
    const rootPc = Number(rootSel.value);
    const count = boxCount(SCALES[scaleId]);
    const previous = Number(boxSel.value) || 0;
    boxSel.textContent = '';
    let fits = 0;
    for (let i = 0; i < count; i++) {
      const ok = boxFits(scaleId, rootPc, i);
      if (ok) fits += 1;
      boxSel.appendChild(
        h('option', { value: String(i), selected: i === previous && ok, disabled: !ok, text: ok ? `Box ${i + 1}` : `Box ${i + 1} — runs off the neck` })
      );
    }
    fitNote.textContent = `${fits} of ${count} shapes fit on the neck in ${rootName(rootPc, s.spelling)}. Higher roots push the upper boxes past the last fret.`;
  }
  syncBoxes();

  return h('div', { class: 'panel', style: 'margin-top:22px' }, [
    h('div', { class: 'eyebrow', text: 'Free scale practice' }),
    h('h2', { text: 'Scale drill', style: 'margin:6px 0 4px' }),
    h('p', { class: 'help', style: 'margin-bottom:16px', text: 'Any shape in any key, outside the scales path. Nothing here unlocks lessons, but every note still feeds your fretboard schedule.' }),
    h('div', { class: 'cols' }, [
      h('div', {}, [
        h('div', { class: 'field' }, [h('label', { text: 'Scale' }), scaleSel]),
        h('div', { class: 'field' }, [h('label', { text: 'Root' }), rootSel]),
        h('div', { class: 'field' }, [h('label', { text: 'Shape' }), boxSel, fitNote]),
      ]),
      h('div', {}, [
        h('div', { class: 'field' }, [h('label', { text: 'Exercise' }), exerciseSel]),
        h('div', { class: 'field' }, [h('label', { text: 'Rounds' }), rounds]),
        clock.field,
      ]),
    ]),
    h('div', { class: 'btn-row' }, [
      h(
        'button',
        {
          class: 'btn is-primary',
          onclick: () => {
            const choice = exerciseSel.value;
            const isRun = choice.startsWith('run');
            startScaleDrill({
              scaleId: scaleSel.value,
              rootPc: Number(rootSel.value),
              boxIndex: Number(boxSel.value) || 0,
              exercise: isRun ? EXERCISE.RUN : choice,
              direction: choice === 'run-down' ? 'down' : 'up',
              octaveOnly: choice === 'run-oct',
              seconds: clock.seconds(),
              prompts: clamp(Number(rounds.value) || 4, 1, 30),
            });
          },
        },
        ['Start scale drill']
      ),
    ]),
  ]);
}

function drillCard(title, stat, blurb, onclick, disabled = false) {
  return h('div', { class: 'tile' }, [
    h('span', { text: title }),
    h('b', { text: stat }),
    h('small', { text: blurb, style: 'margin:6px 0 12px' }),
    h('button', { class: 'btn is-ghost', onclick, disabled, style: 'width:100%' }, ['Start']),
  ]);
}

/* ---------- setup screen ---------------------------------------------- */

export function renderSetup() {
  const root = $('#screen-setup');
  root.textContent = '';
  const s = store.settings();
  const c = store.calibration();

  root.append(h('div', { class: 'eyebrow', text: 'Signal and preferences' }), h('h1', { text: 'Setup' }));

  root.appendChild(renderAccountPanel());

  /* --- microphone panel --- */
  const micStatus = h('p', {
    class: 'lede',
    text: engine.running ? 'Microphone is live.' : 'Microphone is closed. It opens when a session starts.',
  });
  const calibLine = h('p', {
    class: 'help',
    text: c.gate
      ? `Last calibrated ${new Date(c.at).toLocaleString()} · gate at ${(20 * Math.log10(c.gate)).toFixed(1)} dB`
      : 'Not calibrated yet.',
  });

  const tunerNote = h('div', { class: 'readout-big', text: '—' });
  const tunerSub = h('small', { text: 'open the tuner and play' });
  tunerNote.appendChild(tunerSub);
  const tunerNeedle = h('div', { class: 'meter-needle' });
  const tunerStrip = h('div', { class: 'level-strip' }, Array.from({ length: 28 }, () => h('i')));
  const tunerMeter = h('div', { class: 'meter' }, [
    h('div', { class: 'meter-scale' }, [h('div', { class: 'meter-ticks' }), h('div', { class: 'meter-center' }), tunerNeedle]),
    tunerStrip,
  ]);
  let tunerOff = null;

  const tunerBtn = h('button', { class: 'btn' }, ['Open tuner']);
  tunerBtn.addEventListener('click', async () => {
    if (tunerOff) {
      tunerOff();
      tunerOff = null;
      tunerBtn.textContent = 'Open tuner';
      tunerNote.firstChild.textContent = '—';
      tunerSub.textContent = 'tuner closed';
      return;
    }
    try {
      await ensureEngine();
    } catch (err) {
      toast(err.message, 'bad');
      return;
    }
    tunerBtn.textContent = 'Close tuner';
    tunerOff = engine.onFrame((frame) => {
      paintStrip(tunerStrip, frame.level);
      const cents = frame.midi != null ? clamp(frame.cents, -50, 50) : 0;
      tunerNeedle.style.left = `${50 + cents}%`;
      tunerNeedle.classList.toggle('is-intune', frame.midi != null && Math.abs(frame.cents) < 5);
      if (frame.midi != null && frame.stable) {
        tunerNote.firstChild.textContent = noteName(frame.midi, s.spelling);
        tunerSub.textContent = `${frame.freq.toFixed(1)} Hz · ${frame.cents > 0 ? '+' : ''}${frame.cents} cents`;
      }
    });
  });

  root.appendChild(
    h('div', { class: 'panel', style: 'margin-top:18px' }, [
      h('div', { class: 'eyebrow', text: 'Microphone' }),
      h('h2', { text: 'Signal', style: 'margin:6px 0 10px' }),
      micStatus,
      calibLine,
      tunerMeter,
      tunerNote,
      h('div', { class: 'btn-row', style: 'margin-top:16px' }, [
        h('button', { class: 'btn is-primary', onclick: () => { if (tunerOff) { tunerOff(); tunerOff = null; } renderCalibrate({ thenStart: false }); showScreen('calibrate'); } }, ['Calibrate room noise']),
        tunerBtn,
      ]),
    ])
  );

  /* --- practice settings --- */
  const timerValue = h('b', { text: s.timerSeconds ? `${s.timerSeconds}s` : 'no clock' , style: 'font-family:var(--font-mono)'});
  const timerInput = h('input', {
    type: 'range',
    min: '0',
    max: '20',
    step: '0.5',
    value: String(s.timerSeconds),
    oninput: (e) => {
      const v = Number(e.target.value);
      store.setSetting('timerSeconds', v);
      timerValue.textContent = v ? `${v}s` : 'no clock';
    },
  });

  const toleranceValue = h('b', { text: `±${s.pitchTolerance} cents`, style: 'font-family:var(--font-mono)' });
  const toleranceInput = h('input', {
    type: 'range',
    min: '20',
    max: '85',
    step: '5',
    value: String(s.pitchTolerance),
    oninput: (e) => {
      const v = Number(e.target.value);
      store.setSetting('pitchTolerance', v);
      toleranceValue.textContent = `±${v} cents`;
      const help = document.getElementById('toleranceHelp');
      if (help) help.textContent = toleranceHelpText(v);
    },
  });

  const panel = h('div', { class: 'panel', style: 'margin-top:22px' }, [
    h('div', { class: 'eyebrow', text: 'Practice' }),
    h('h2', { text: 'How sessions run', style: 'margin:6px 0 18px' }),
    h('div', { class: 'cols' }, [
      h('div', {}, [
        h('div', { class: 'field' }, [
          h('label', {}, ['Time per note · ', timerValue]),
          timerInput,
          h('div', { class: 'help', text: 'How long you get to find and play each note. Slide to zero to remove the clock entirely.' }),
        ]),
        segField('Input', s.inputMode, [['mic', 'Guitar (mic)'], ['tap', 'Tap the board']], (v) => store.setSetting('inputMode', v)),
        segField('Prompt', s.promptStyle, [['name', 'Note name'], ['position', 'Marked fret'], ['mixed', 'Mixed']], (v) =>
          store.setSetting('promptStyle', v)
        ),
        h('div', { class: 'field' }, [
          h('label', { class: 'switch' }, [
            checkbox(s.lessonsTightenTimer, (v) => store.setSetting('lessonsTightenTimer', v)),
            'Higher levels tighten the clock',
          ]),
          h('div', { class: 'help', text: 'Level 2 runs at 80% of your time, level 3 at 65%.' }),
        ]),
      ]),
      h('div', {}, [
        segField('Note spelling', s.spelling, [['sharps', 'Sharps'], ['flats', 'Flats'], ['both', 'Both']], (v) => {
          store.setSetting('spelling', v);
          renderSetup();
        }),
        segField(
          'Right note, wrong octave',
          s.octaveStrictness,
          [['lenient', 'Counts as correct'], ['strict', 'Must be exact']],
          (v) => store.setSetting('octaveStrictness', v)
        ),
        h('div', { class: 'field' }, [
          h('label', {}, ['How far off still counts · ', toleranceValue]),
          toleranceInput,
          h('div', { class: 'help', id: 'toleranceHelp', text: toleranceHelpText(s.pitchTolerance) }),
        ]),
        h('div', { class: 'field' }, [
          h('label', { text: 'What counts as a played note' }),
          h(
            'div',
            { class: 'seg' },
            Object.entries(SENSITIVITY).map(([key, preset]) =>
              h('button', {
                type: 'button',
                class: s.detectionSensitivity === key ? 'is-on' : '',
                text: preset.label,
                onclick: (e) => {
                  e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('is-on'));
                  e.currentTarget.classList.add('is-on');
                  store.setSetting('detectionSensitivity', key);
                  engine.setSensitivity(key);
                  const help = document.getElementById('sensitivityHelp');
                  if (help) help.textContent = sensitivityHelpText(key);
                },
              })
            )
          ),
          h('div', { class: 'help', id: 'sensitivityHelp', text: sensitivityHelpText(s.detectionSensitivity) }),
        ]),
        segField('Calibrate before sessions', s.calibrateBeforeSession, [['auto', 'When stale'], ['always', 'Every time'], ['never', 'Never']], (v) =>
          store.setSetting('calibrateBeforeSession', v)
        ),
        h('div', { class: 'field' }, [
          h('label', { text: 'Tuning' }),
          select(
            Object.entries(TUNINGS).map(([k, v]) => [k, v.label]),
            s.tuning,
            (v) => {
              store.setSetting('tuning', v);
              renderSetup();
              renderPath();
            }
          ),
          h('div', { class: 'help', text: 'Everything follows the tuning you pick. The path itself was laid out for standard tuning, so in an alternate tuning a lesson may include a sharp where a natural used to be.' }),
        ]),
        h('div', { class: 'field' }, [
          h('label', { class: 'switch' }, [checkbox(s.countIn, (v) => store.setSetting('countIn', v)), 'Count in before the first note']),
          h('label', { class: 'switch' }, [checkbox(s.sound, (v) => store.setSetting('sound', v)), 'Sound feedback']),
          h('label', { class: 'switch' }, [
            checkbox(s.flipBoard, (v) => {
              store.setSetting('flipBoard', v);
              renderSetup();
            }),
            'Flip the board (low E on top)',
          ]),
        ]),
        h('div', { class: 'field' }, [
          h('label', { text: 'Daily goal (sessions)' }),
          h('input', {
            type: 'number',
            min: '1',
            max: '20',
            value: String(s.dailyGoal),
            style: 'max-width:110px',
            onchange: (e) => store.setSetting('dailyGoal', clamp(Number(e.target.value) || 1, 1, 20)),
          }),
        ]),
        h('div', { class: 'field' }, [
          h('label', { text: 'Reference pitch (A4)' }),
          h('input', {
            type: 'number',
            min: '415',
            max: '466',
            value: String(s.a4),
            style: 'max-width:110px',
            onchange: (e) => {
              const v = clamp(Number(e.target.value) || 440, 415, 466);
              store.setSetting('a4', v);
              engine.setA4(v);
            },
          }),
        ]),
      ]),
    ]),
  ]);
  root.appendChild(panel);

  /* --- data --- */
  root.appendChild(
    h('div', { class: 'panel', style: 'margin-top:22px' }, [
      h('div', { class: 'eyebrow', text: 'Data' }),
      h('h2', { text: 'Your progress lives in this browser', style: 'margin:6px 0 10px' }),
      h('p', { class: 'help', text: 'Nothing is uploaded anywhere. Export a backup before clearing site data.' }),
      h('div', { class: 'btn-row', style: 'margin-top:14px' }, [
        h('button', { class: 'btn is-ghost', onclick: exportProgress }, ['Export backup']),
        h('button', { class: 'btn is-ghost', onclick: importProgress }, ['Import backup']),
        h('button', { class: 'btn is-danger', onclick: confirmReset }, ['Reset everything']),
      ]),
    ])
  );
}

/** The neighbouring fret is 100 cents away, so what is left is the margin. */
function toleranceHelpText(cents) {
  const margin = 100 - cents;
  const flavour =
    cents <= 35
      ? 'Tight — your guitar needs to be well in tune.'
      : cents <= 55
      ? 'Normal.'
      : cents <= 75
      ? 'Forgiving of a guitar that has drifted a little.'
      : 'Very forgiving. Bends and heavy fretting still pass.';
  return `${flavour} A note this far off the target still counts, leaving ${margin} cents of margin before the next fret would be accepted too.`;
}

/* ---------- account panel --------------------------------------------- */

function renderAccountPanel() {
  const panel = h('div', { class: 'panel', id: 'accountPanel', style: 'margin-top:18px' });
  const configured = cloud.isCloudConfigured();
  const user = cloud.currentUser();

  panel.append(h('div', { class: 'eyebrow', text: 'Account' }), h('h2', { text: 'Cloud saves', style: 'margin:6px 0 10px' }));

  if (!configured) {
    panel.append(
      h('p', { class: 'lede', text: 'Not connected. Progress is saved in this browser only, which is all you need on one machine.' }),
      h('div', { class: 'banner' }, [
        h('b', { text: 'To turn it on' }),
        'Create a Supabase project, run supabase/schema.sql in its SQL editor, then paste the project URL and anon key into js/config.js — or below, to try it without redeploying.',
      ]),
      connectForm()
    );
    return panel;
  }

  if (!user) {
    const input = h('input', {
      type: 'text',
      placeholder: 'e.g. az',
      autocomplete: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
      maxlength: '24',
      style: 'max-width:260px',
    });
    const message = h('div', { class: 'help' });
    const button = h('button', { class: 'btn is-primary' }, ['Sign in']);

    const submit = async () => {
      const check = cloud.validateUsername(input.value);
      if (!check.ok) {
        message.textContent = check.reason;
        return;
      }
      button.disabled = true;
      button.textContent = 'Signing in…';
      message.textContent = '';
      try {
        const { username, outcome } = await cloud.signIn(input.value);
        toast(
          outcome === 'created'
            ? `Created @${username} — this device's progress is now saved to it.`
            : outcome === 'pulled'
            ? `Welcome back, @${username}. Progress restored.`
            : `Signed in as @${username}. Progress from this device was merged in.`,
          'good'
        );
        renderAll();
        showScreen('setup');
      } catch (err) {
        message.textContent = err.message;
        button.disabled = false;
        button.textContent = 'Sign in';
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    button.addEventListener('click', submit);

    panel.append(
      h('p', { class: 'lede', text: 'Pick a username and your progress follows you to any device. No password, no email.' }),
      h('div', { class: 'field' }, [
        h('label', { text: 'Username' }),
        h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, [input, button]),
        message,
        h('div', { class: 'help', text: 'A name nobody has used yet becomes yours, starting from whatever is already on this device. An existing name loads its progress and merges this device into it.' }),
      ]),
      h('div', { class: 'btn-row', style: 'margin:-6px 0 16px' }, [testConnectionButton()]),
      h('div', { class: 'banner is-bad' }, [
        h('b', { text: 'No password means no privacy' }),
        'Anyone who guesses your username can load and overwrite this profile. That is the trade for signing in without one, so keep it to practice progress and pick a name that is not obvious if that matters to you.',
      ]),
      connectForm()
    );
    return panel;
  }

  const status = cloud.syncStatus();
  const look = SYNC_LOOK[status.state] || SYNC_LOOK.idle;
  const statusLine = h('div', { class: 'help', id: 'accountStatus' }, [
    h('span', { class: `sync-dot ${look.dot}` }),
    ` ${status.message || look.title}`,
  ]);

  panel.append(
    h('div', { class: 'result-grid', style: 'margin:8px 0 4px' }, [
      h('div', { class: 'tile is-accent' }, [h('span', { text: 'Signed in as' }), h('b', { text: `@${user}` })]),
      h('div', { class: 'tile' }, [
        h('span', { text: 'Last sync' }),
        h('b', { text: status.at ? new Date(status.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—' }),
        h('small', { text: look.label }),
      ]),
    ]),
    statusLine,
    h('div', { class: 'btn-row', style: 'margin-top:16px' }, [
      h(
        'button',
        {
          class: 'btn',
          onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            b.textContent = 'Syncing…';
            await cloud.pullNow();
            renderAll();
            showScreen('setup');
            toast('Synced.', 'good');
          },
        },
        ['Sync now']
      ),
      h(
        'button',
        {
          class: 'btn is-ghost',
          onclick: () =>
            openSheet(
              `Sign out of @${user}?`,
              ['Progress stays on this device and stays on the server. Sign back in with the same username to pick it up anywhere.'],
              [
                h('button', { class: 'btn is-danger', onclick: () => { cloud.signOut(); closeSheet(); renderAll(); showScreen('setup'); toast('Signed out.'); } }, ['Sign out']),
                h('button', { class: 'btn is-ghost', onclick: closeSheet }, ['Cancel']),
              ]
            ),
        },
        ['Sign out']
      ),
    ])
  );
  return panel;
}

/** Says which part is wrong — URL, key, or missing schema — without guessing. */
function testConnectionButton() {
  const result = h('div', { class: 'help', style: 'flex-basis:100%' });
  const button = h(
    'button',
    {
      class: 'btn is-ghost',
      onclick: async () => {
        button.disabled = true;
        button.textContent = 'Testing…';
        result.textContent = '';
        const outcome = await cloud.testConnection();
        result.textContent = outcome.message;
        result.style.color = outcome.ok ? 'var(--green-deep)' : 'var(--red)';
        button.disabled = false;
        button.textContent = 'Test connection';
      },
    },
    ['Test connection']
  );
  return h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' }, [button, result]);
}

/** Lets you point the app at a Supabase project without editing config.js. */
function connectForm() {
  const cfg = supabaseConfig();
  const urlInput = h('input', { type: 'text', placeholder: 'https://xxxx.supabase.co', value: cfg.fromOverride ? cfg.url : '' });
  const keyInput = h('input', { type: 'text', placeholder: 'anon / publishable key', value: cfg.fromOverride ? cfg.key : '' });

  return h('details', { style: 'margin-top:18px' }, [
    h('summary', { class: 'eyebrow', style: 'cursor:pointer', text: cfg.fromOverride ? 'Connection (set on this device)' : 'Connect a project from here' }),
    h('div', { style: 'margin-top:12px' }, [
      h('div', { class: 'field' }, [h('label', { text: 'Project URL' }), urlInput]),
      h('div', { class: 'field' }, [h('label', { text: 'Anon key' }), keyInput]),
      h('div', { class: 'help', style: 'margin-bottom:12px', text: 'Stored in this browser only. Putting the same values in js/config.js makes them apply everywhere the site is deployed.' }),
      h('div', { class: 'btn-row' }, [
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              writeOverride(urlInput.value, keyInput.value);
              toast('Connection saved. Reloading.', 'good');
              setTimeout(() => location.reload(), 600);
            },
          },
          ['Save and reload']
        ),
        cfg.fromOverride
          ? h(
              'button',
              {
                class: 'btn is-ghost',
                onclick: () => {
                  writeOverride(null, null);
                  toast('Connection cleared. Reloading.');
                  setTimeout(() => location.reload(), 600);
                },
              },
              ['Clear']
            )
          : null,
      ]),
    ]),
  ]);
}

function sensitivityHelpText(key) {
  const preset = SENSITIVITY[key] || SENSITIVITY.normal;
  const hold = Math.round((preset.stableFrames / 60) * 1000);
  const base =
    key === 'strict'
      ? 'Only clean, well-sustained notes register. Use this if stray sounds are answering for you.'
      : key === 'relaxed'
      ? 'Picks up light or short notes, and more of everything else with them.'
      : 'A good default for a laptop microphone in a normal room.';
  return `${base} A sound must hold a steady pitch for about ${hold}ms to count.`;
}

function segField(label, value, options, onChange) {
  const seg = h(
    'div',
    { class: 'seg' },
    options.map(([val, text]) =>
      h('button', {
        type: 'button',
        class: value === val ? 'is-on' : '',
        text,
        onclick: (e) => {
          seg.querySelectorAll('button').forEach((b) => b.classList.remove('is-on'));
          e.currentTarget.classList.add('is-on');
          onChange(val);
        },
      })
    )
  );
  return h('div', { class: 'field' }, [h('label', { text: label }), seg]);
}

function checkbox(checked, onChange) {
  return h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
}

function select(options, value, onChange) {
  return h(
    'select',
    { onchange: (e) => onChange(e.target.value) },
    options.map(([val, text]) => h('option', { value: val, selected: val === value, text }))
  );
}

function exportProgress() {
  const blob = new Blob([store.exportJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `fretpro-backup-${store.todayKey()}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Backup downloaded.', 'good');
}

function importProgress() {
  const input = h('input', { type: 'file', accept: 'application/json', style: 'display:none' });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      store.importJson(await file.text());
      toast('Progress restored.', 'good');
      renderAll();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  document.body.appendChild(input);
  input.click();
  input.remove();
}

function confirmReset() {
  openSheet(
    'Reset everything?',
    ['Every level, streak and note record is deleted. This cannot be undone — export a backup first if you want one.'],
    [
      h('button', { class: 'btn is-danger', onclick: () => { store.resetAll(); closeSheet(); renderAll(); showScreen('path'); toast('Progress cleared.', ''); } }, ['Delete it all']),
      h('button', { class: 'btn is-ghost', onclick: closeSheet }, ['Cancel']),
    ]
  );
}

/* ---------- boot ------------------------------------------------------- */

export function renderAll() {
  renderRail();
  renderPath();
  renderScales();
  renderDrill();
  renderProgress();
  renderSetup();
}

export function boot() {
  renderAll();
  showScreen('path');

  // Keep the rail's account chip honest as sync comes and goes.
  cloud.onStatus(() => {
    renderRail();
    const line = document.getElementById('accountStatus');
    if (line && currentScreen === 'setup') renderSetup();
  });
  cloud.startSync();

  document.querySelectorAll('.navbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.screen;
      if (activeSession) {
        confirmQuit();
        return;
      }
      if (target === 'scales') renderScales();
      if (target === 'progress') renderProgress();
      if (target === 'drill') renderDrill();
      if (target === 'setup') renderSetup();
      if (target === 'path') renderPath();
      showScreen(target);
    });
  });

  document.querySelectorAll('[data-close-sheet]').forEach((el) => el.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#sheet').hidden) closeSheet();
      else if (activeSession) confirmQuit();
    }
    // Space replays the target note during a session.
    if (e.code === 'Space' && activeSession && activeSession.prompt && currentScreen === 'session') {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag !== 'INPUT' && tag !== 'BUTTON' && tag !== 'SELECT') {
        e.preventDefault();
        playNoteTone(activeSession.prompt.midi, store.settings().a4, 900);
      }
    }
  });

  window.addEventListener('beforeunload', () => store.saveNow());
  setMicPlate('microphone idle');
}
