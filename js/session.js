/* One practice session: choose a prompt, listen, judge, advance.

   A wrong answer never advances the prompt — it flashes red and you try again
   until you get it or the clock runs out. Only first-try answers count toward
   accuracy and toward moving a note up its spaced-repetition box. */

import { midiAt, noteName, pitchClass, posKey, octaveOf, matchesTarget, octaveReducedDistance } from './theory.js';
import { pickNext, grade, mastery, isNew } from './srs.js';
import { levelSpec, MAX_LEVEL } from './curriculum.js';
import * as store from './store.js';
import { playCorrect, playWrong, playStep } from './audio.js';

const REVEAL_MS = 1500;
const CORRECT_HOLD_MS = 520;

export class Session {
  /**
   * @param {object} config
   * @param {Array<{string:number,fret:number}>} config.pool positions to drill
   * @param {number} config.prompts how many prompts in the session
   * @param {string} config.title shown in the session header
   * @param {string} [config.lessonId] set for path lessons; omitted for free drills
   * @param {number} [config.targetLevel]
   * @param {number} config.timerSeconds 0 disables the clock
   * @param {'mic'|'tap'} config.inputMode
   * @param {'name'|'position'|'mixed'} config.promptStyle
   */
  constructor(config, handlers = {}) {
    this.config = config;
    this.handlers = handlers;
    this.settings = store.settings();

    this.index = 0;
    this.prompt = null;
    this.state = 'idle'; // idle | countIn | awaiting | wrong | correct | revealed | done
    this.lastKey = null;
    this.results = [];
    this.startedAt = null;
    this.timerId = null;
    this.deadline = null;
    this.tickId = null;
    this.unsubscribe = null;
    this.wrongThisPrompt = [];
    this.finished = false;
  }

  get total() {
    return this.config.prompts;
  }

  get answered() {
    return this.results.length;
  }

  get firstTryCorrect() {
    return this.results.filter((r) => r.correct).length;
  }

  get accuracy() {
    return this.results.length ? this.firstTryCorrect / this.results.length : 0;
  }

  /** Attach to a running PitchEngine. Safe to call for tap mode too. */
  attach(engine) {
    this.engine = engine;
    if (engine && this.config.inputMode === 'mic') {
      this.unsubscribe = engine.onFrame((frame) => this.#onFrame(frame));
    }
    return this;
  }

  start() {
    this.startedAt = Date.now();
    if (this.settings.countIn) {
      this.state = 'countIn';
      let n = 3;
      this.handlers.onCountIn?.(n);
      const step = () => {
        n -= 1;
        if (n <= 0) {
          this.handlers.onCountIn?.(0);
          this.#nextPrompt();
        } else {
          this.handlers.onCountIn?.(n);
          this.timerId = setTimeout(step, 650);
        }
      };
      this.timerId = setTimeout(step, 650);
    } else {
      this.#nextPrompt();
    }
  }

  stop() {
    clearTimeout(this.timerId);
    clearInterval(this.tickId);
    this.timerId = null;
    this.tickId = null;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.state = 'done';
  }

  #record(key) {
    return store.noteRecord(key);
  }

  #nextPrompt() {
    clearTimeout(this.timerId);
    clearInterval(this.tickId);
    if (this.index >= this.total) return this.#finish();

    // The note just answered may still be ringing into this prompt.
    const previous = this.prompt;
    this.index += 1;
    this.wrongThisPrompt = [];

    if (this.config.exercise && this.config.exercise !== 'note') {
      this.prompt = this.#buildScalePrompt(this.index);
    } else {
      const note = pickNext(this.config.pool, (k) => this.#record(k), this.lastKey);
      const midi = midiAt(this.settings.tuning, note.string, note.fret);
      const style =
        this.config.promptStyle === 'mixed'
          ? Math.random() < 0.65
            ? 'name'
            : 'position'
          : this.config.promptStyle;
      this.prompt = {
        kind: 'single',
        note,
        key: posKey(note.string, note.fret),
        midi,
        pc: pitchClass(midi),
        name: noteName(midi, this.settings.spelling),
        style,
        number: this.index,
        shownAt: performance.now(),
        isNew: isNew(this.#record(posKey(note.string, note.fret))),
      };
    }

    this.lastKey = this.prompt.key;
    this.state = 'awaiting';
    // Do NOT force-arm here. A guitar note rings for seconds, so the note you
    // just played would otherwise be picked up as the answer to this prompt.
    // The engine re-arms itself on silence, a fresh attack, or a new pitch.
    if (this.engine && previous) this.engine.disarm(previous.midi);
    else if (this.engine) this.engine.arm();

    this.handlers.onPrompt?.(this.prompt, this);
    this.#startClock();
  }

  #startClock() {
    const seconds = this.config.timerSeconds;
    if (!seconds) {
      this.handlers.onTick?.(null, null);
      return;
    }
    this.deadline = performance.now() + seconds * 1000;
    const tick = () => {
      const remaining = Math.max(0, this.deadline - performance.now());
      this.handlers.onTick?.(remaining / 1000, remaining / (seconds * 1000));
      if (remaining <= 0) {
        clearInterval(this.tickId);
        this.#timeout();
      }
    };
    tick();
    this.tickId = setInterval(tick, 50);
  }

  /**
   * Scale prompts. A run walks an ordered list of positions; stay-in-key
   * accepts anything from a pitch-class set; degree and root are ordinary
   * single-note prompts wearing a different label.
   */
  #buildScalePrompt(number) {
    const c = this.config;
    const shownAt = performance.now();

    if (c.exercise === 'run') {
      const steps = c.steps;
      return {
        kind: 'run',
        steps,
        stepIndex: 0,
        note: steps[0],
        midi: steps[0].midi,
        pc: pitchClass(steps[0].midi),
        name: noteName(steps[0].midi, this.settings.spelling),
        key: posKey(steps[0].string, steps[0].fret),
        style: 'run',
        number,
        shownAt,
        stepShownAt: shownAt,
        cleanSteps: 0,
        stepErrorsSeen: 0,
      };
    }

    if (c.exercise === 'membership') {
      return {
        kind: 'membership',
        allowed: c.allowedPcs,
        needed: c.notesNeeded || 12,
        distinctNeeded: c.distinctNeeded || c.allowedPcs.size,
        counted: 0,
        distinct: new Set(),
        lastPc: null,
        key: null,
        style: 'membership',
        number,
        shownAt,
      };
    }

    // degree / root: pick a target position, match by pitch class.
    const note = pickNext(c.pool, (k) => this.#record(k), this.lastKey);
    const midi = midiAt(this.settings.tuning, note.string, note.fret);
    return {
      kind: 'single',
      note,
      midi,
      pc: pitchClass(midi),
      name: noteName(midi, this.settings.spelling),
      degree: note.degree || null,
      key: posKey(note.string, note.fret),
      style: c.exercise,
      matchByPitchClass: true,
      number,
      shownAt,
      isNew: isNew(this.#record(posKey(note.string, note.fret))),
    };
  }

  #onFrame(frame) {
    if (this.state !== 'awaiting' && this.state !== 'wrong') return;
    // The engine already applies the clarity and steadiness bar for the chosen
    // sensitivity, and refuses to arm while a previous note is still ringing.
    if (!frame.armed || !frame.stable || frame.midi == null) return;
    this.judge(frame.midi, { midiFloat: frame.midiFloat, cents: frame.cents, freq: frame.freq });
  }

  /**
   * Judge a played or tapped note.
   * @param {number} playedMidi nearest whole MIDI note, used for naming
   * @param {object} [meta] `midiFloat` carries the un-rounded pitch when it came
   *   from the microphone; a tap has no detuning, so it falls back to the integer.
   */
  judge(playedMidi, meta = {}) {
    if (this.state !== 'awaiting' && this.state !== 'wrong') return;
    const playedFloat = meta.midiFloat != null ? meta.midiFloat : playedMidi;

    if (this.prompt && this.prompt.kind === 'run') return this.#judgeRunStep(playedMidi, playedFloat, meta);
    if (this.prompt && this.prompt.kind === 'membership') return this.#judgeMembership(playedMidi, playedFloat, meta);

    // A degree or root is asked for by interval, so any octave of it is right.
    const strict = this.prompt && this.prompt.matchByPitchClass ? false : this.settings.octaveStrictness === 'strict';
    const toleranceCents = this.settings.pitchTolerance;
    const ok = matchesTarget(playedFloat, this.prompt.midi, { strict, toleranceCents });
    const samePc = pitchClass(playedMidi) === this.prompt.pc;
    const exact = playedMidi === this.prompt.midi;
    // How far off the target the accepted note actually was, for tuning hints.
    const offCents = Math.round(octaveReducedDistance(playedFloat, this.prompt.midi) * 100);

    if (this.engine) this.engine.disarm(playedFloat);

    if (ok) {
      const ms = performance.now() - this.prompt.shownAt;
      const firstTry = this.wrongThisPrompt.length === 0;
      this.state = 'correct';
      clearInterval(this.tickId);
      if (this.settings.sound) playCorrect();

      const octaveNote = !exact && samePc ? (playedMidi > this.prompt.midi ? 'up' : 'down') : null;
      const result = {
        key: this.prompt.key,
        note: this.prompt.note,
        midi: this.prompt.midi,
        name: this.prompt.name,
        correct: firstTry,
        ms: Math.round(ms),
        attempts: this.wrongThisPrompt.length + 1,
        wrong: [...this.wrongThisPrompt],
        timedOut: false,
      };
      this.results.push(result);
      store.putNoteRecord(this.prompt.key, grade(this.#record(this.prompt.key), firstTry, ms));

      this.handlers.onJudged?.(
        {
          verdict: 'correct',
          firstTry,
          playedMidi,
          ms,
          octaveNote,
          exact,
          offCents,
          cents: meta.cents ?? null,
        },
        this
      );

      this.timerId = setTimeout(() => this.#nextPrompt(), CORRECT_HOLD_MS);
      return;
    }

    // Wrong: stay on the same prompt.
    this.wrongThisPrompt.push(playedMidi);
    this.state = 'wrong';
    if (this.settings.sound) playWrong();
    this.handlers.onJudged?.(
      {
        verdict: 'wrong',
        playedMidi,
        playedName: noteName(playedMidi, this.settings.spelling),
        playedOctave: octaveOf(playedMidi),
        attempts: this.wrongThisPrompt.length,
        cents: meta.cents ?? null,
      },
      this
    );
    // Back to listening; a new attack re-arms the engine.
    this.state = 'awaiting';
  }

  /** One note of an ordered run. Wrong notes retry the step, or restart it. */
  #judgeRunStep(playedMidi, playedFloat, meta) {
    const prompt = this.prompt;
    const step = prompt.steps[prompt.stepIndex];
    // A run is about hitting specific positions, so the octave has to be right.
    // It also stops a run that ends on A from being restarted by that same A
    // ringing on into the next run's opening note.
    const ok = matchesTarget(playedFloat, step.midi, { strict: true, toleranceCents: this.settings.pitchTolerance });

    if (this.engine) this.engine.disarm(playedFloat);

    if (!ok) {
      this.wrongThisPrompt.push(playedMidi);
      if (this.settings.sound) playWrong();
      const restarted = Boolean(this.config.restartOnError) && prompt.stepIndex > 0;
      if (restarted) {
        prompt.stepIndex = 0;
        prompt.cleanSteps = 0;
      }
      prompt.stepShownAt = performance.now();
      this.handlers.onJudged?.(
        {
          verdict: 'wrong',
          playedMidi,
          playedName: noteName(playedMidi, this.settings.spelling),
          playedOctave: octaveOf(playedMidi),
          expected: step,
          restarted,
          attempts: this.wrongThisPrompt.length,
        },
        this
      );
      this.state = 'awaiting';
      return;
    }

    // Right note: credit this position in the same schedule the note track uses.
    const stepMs = performance.now() - prompt.stepShownAt;
    const cleanStep = this.wrongThisPrompt.length === prompt.stepErrorsSeen;
    const key = posKey(step.string, step.fret);
    store.putNoteRecord(key, grade(this.#record(key), cleanStep, stepMs));
    prompt.stepErrorsSeen = this.wrongThisPrompt.length;
    prompt.cleanSteps += cleanStep ? 1 : 0;
    prompt.stepIndex += 1;
    prompt.stepShownAt = performance.now();

    if (prompt.stepIndex < prompt.steps.length) {
      const next = prompt.steps[prompt.stepIndex];
      prompt.note = next;
      prompt.midi = next.midi;
      prompt.name = noteName(next.midi, this.settings.spelling);
      prompt.key = posKey(next.string, next.fret);
      if (this.settings.sound) playStep();
      this.handlers.onJudged?.({ verdict: 'step', stepIndex: prompt.stepIndex, total: prompt.steps.length, played: step }, this);
      this.state = 'awaiting';
      return;
    }

    this.#completePrompt(performance.now() - prompt.shownAt);
  }

  /** Stay in key: any note from the scale, no immediate repeats. */
  #judgeMembership(playedMidi, playedFloat, meta) {
    const prompt = this.prompt;
    const pc = pitchClass(Math.round(playedFloat));
    const inScale = prompt.allowed.has(pc);

    if (this.engine) this.engine.disarm(playedFloat);

    if (!inScale) {
      this.wrongThisPrompt.push(playedMidi);
      if (this.settings.sound) playWrong();
      this.handlers.onJudged?.(
        {
          verdict: 'wrong',
          playedMidi,
          playedName: noteName(playedMidi, this.settings.spelling),
          playedOctave: octaveOf(playedMidi),
          outOfKey: true,
          attempts: this.wrongThisPrompt.length,
        },
        this
      );
      this.state = 'awaiting';
      return;
    }

    if (pc === prompt.lastPc) {
      // Not wrong, just not progress — otherwise one note repeated would pass.
      this.handlers.onJudged?.({ verdict: 'repeat', playedMidi }, this);
      this.state = 'awaiting';
      return;
    }

    prompt.lastPc = pc;
    prompt.counted += 1;
    prompt.distinct.add(pc);
    if (this.settings.sound) playStep();

    const done = prompt.counted >= prompt.needed && prompt.distinct.size >= prompt.distinctNeeded;
    this.handlers.onJudged?.(
      {
        verdict: done ? 'complete' : 'step',
        counted: prompt.counted,
        needed: prompt.needed,
        distinct: prompt.distinct.size,
        distinctNeeded: prompt.distinctNeeded,
        playedMidi,
      },
      this
    );

    if (done) this.#completePrompt(performance.now() - prompt.shownAt);
    else this.state = 'awaiting';
  }

  /** Shared finish for run and stay-in-key prompts. */
  #completePrompt(ms) {
    const prompt = this.prompt;
    const firstTry = this.wrongThisPrompt.length === 0;
    this.state = 'correct';
    clearInterval(this.tickId);
    if (this.settings.sound) playCorrect();

    this.results.push({
      key: prompt.key,
      note: prompt.note || null,
      midi: prompt.midi || null,
      name: prompt.name || prompt.style,
      correct: firstTry,
      ms: Math.round(ms),
      attempts: this.wrongThisPrompt.length + 1,
      wrong: [...this.wrongThisPrompt],
      timedOut: false,
    });

    this.handlers.onJudged?.({ verdict: 'correct', firstTry, ms, complete: true }, this);
    this.timerId = setTimeout(() => this.#nextPrompt(), CORRECT_HOLD_MS);
  }

  #timeout() {
    if (this.state === 'correct' || this.state === 'revealed' || this.state === 'done') return;
    this.state = 'revealed';
    clearInterval(this.tickId);
    if (this.engine) this.engine.disarm(this.prompt.midi);
    if (this.settings.sound) playWrong();

    const result = {
      key: this.prompt.key,
      note: this.prompt.note || null,
      midi: this.prompt.midi || null,
      name: this.prompt.name || this.prompt.style,
      correct: false,
      ms: this.config.timerSeconds * 1000,
      attempts: this.wrongThisPrompt.length,
      wrong: [...this.wrongThisPrompt],
      timedOut: true,
    };
    this.results.push(result);
    if (this.prompt.key) {
      store.putNoteRecord(this.prompt.key, grade(this.#record(this.prompt.key), false, this.config.timerSeconds * 1000));
    }

    this.handlers.onJudged?.({ verdict: 'timeout' }, this);
    this.timerId = setTimeout(() => this.#nextPrompt(), REVEAL_MS);
  }

  /** Give up on this prompt and show the answer. */
  reveal() {
    if (this.state === 'awaiting' || this.state === 'wrong') this.#timeout();
  }

  #finish() {
    if (this.finished) return;
    this.finished = true;
    this.state = 'done';
    clearTimeout(this.timerId);
    clearInterval(this.tickId);
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;

    const summary = this.#buildSummary();
    this.handlers.onEnd?.(summary, this);
  }

  #buildSummary() {
    const correctResults = this.results.filter((r) => r.correct);
    const avgMs = correctResults.length
      ? Math.round(correctResults.reduce((a, r) => a + r.ms, 0) / correctResults.length)
      : null;
    const accuracy = this.accuracy;
    const spec = this.config.targetLevel ? levelSpec(this.config.targetLevel - 1) : null;

    // Level up only for path lessons that hit the accuracy bar.
    let leveledTo = null;
    if (this.config.lessonId && spec) {
      const prog = store.lessonProgress(this.config.lessonId);
      const passed = accuracy >= spec.minAccuracy;
      const nextLevel = passed ? Math.min(MAX_LEVEL, Math.max(prog.level, this.config.targetLevel)) : prog.level;
      if (passed && nextLevel > prog.level) leveledTo = nextLevel;
      store.setLessonProgress(this.config.lessonId, {
        level: nextLevel,
        bestAccuracy: Math.max(prog.bestAccuracy || 0, accuracy),
        sessions: (prog.sessions || 0) + 1,
        lastAt: Date.now(),
      });
    }

    const baseXp = spec ? spec.xp : 15;
    const xp = Math.round(baseXp * (0.5 + accuracy) + (avgMs && avgMs < 2500 ? 8 : 0));
    store.addXp(xp);
    store.touchStreak();
    store.recordDayActivity(this.results.length);
    const s = store.stats();
    s.sessions += 1;
    s.prompts += this.results.length;
    s.correct += this.firstTryCorrect;

    // Weakest notes in this session, worst first.
    const byKey = new Map();
    for (const r of this.results) {
      const entry = byKey.get(r.key) || { ...r, seen: 0, misses: 0, totalMs: 0 };
      entry.seen += 1;
      entry.misses += r.correct ? 0 : 1;
      entry.totalMs += r.ms;
      byKey.set(r.key, entry);
    }
    const trouble = [...byKey.values()]
      .filter((e) => e.misses > 0)
      .sort((a, b) => b.misses - a.misses || b.totalMs - a.totalMs)
      .slice(0, 6);

    const summary = {
      title: this.config.title,
      lessonId: this.config.lessonId || null,
      targetLevel: this.config.targetLevel || null,
      leveledTo,
      requiredAccuracy: spec ? spec.minAccuracy : null,
      prompts: this.results.length,
      correct: this.firstTryCorrect,
      accuracy,
      avgMs,
      xp,
      streak: store.currentStreak(),
      trouble,
      results: this.results,
      durationMs: Date.now() - this.startedAt,
      at: Date.now(),
      mastery: poolMastery(this.config),
    };

    store.pushHistory({
      at: summary.at,
      title: summary.title,
      lessonId: summary.lessonId,
      accuracy: summary.accuracy,
      prompts: summary.prompts,
      avgMs: summary.avgMs,
      xp: summary.xp,
    });
    store.saveNow();
    return summary;
  }
}

/**
 * Average mastery of whatever the session covered. A run or stay-in-key session
 * has no `pool` — it works from a shape — so fall back to that rather than
 * throwing on the last note and killing the session before it can finish.
 */
function poolMastery(config) {
  const positions = config.pool || config.boxPositions || config.steps || [];
  if (!positions.length) return 0;
  const seen = new Map();
  for (const n of positions) seen.set(posKey(n.string, n.fret), n);
  let total = 0;
  for (const key of seen.keys()) total += mastery(store.noteRecord(key));
  return total / seen.size;
}

/** Effective clock for a lesson attempt, honouring the per-level tightening. */
export function effectiveTimer(baseSeconds, targetLevel) {
  const s = store.settings();
  if (!baseSeconds) return 0;
  if (!s.lessonsTightenTimer || !targetLevel) return baseSeconds;
  const scale = levelSpec(targetLevel - 1).timerScale;
  return Math.max(1.5, Math.round(baseSeconds * scale * 10) / 10);
}
