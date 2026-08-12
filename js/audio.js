/* Microphone capture, room calibration and pitch detection.

   Detection is YIN (cumulative-mean-normalised difference) run on a 2x
   decimated buffer — guitar fundamentals top out around 900 Hz, so half the
   sample rate is plenty and it makes each frame roughly four times cheaper.

   Two things matter as much as the pitch itself:
   - the noise gate, set from a few seconds of the actual room, and
   - arming: after an answer is judged, a still-ringing string must not answer
     the next prompt. The engine re-arms on silence or on a fresh attack. */

import { freqToMidiFloat, midiToFreq } from './theory.js';

const FFT_SIZE = 4096;
const FMIN = 62; // below drop-D's open string
const FMAX = 1250; // above the 17th fret on the high E
const YIN_THRESHOLD = 0.12;
const UNVOICED_CMND = 0.62;
const MIN_GATE = 0.006;

/** A note must differ from the last judged one by this much to count as new. */
const NEW_NOTE_SEMITONES = 0.6;

/**
 * How hard it is for a sound to register as a played note. Room noise sets the
 * floor; these decide whether what is above the floor is actually a note.
 */
export const SENSITIVITY = {
  relaxed: { label: 'Relaxed', minClarity: 0.7, stableFrames: 3, gateBoost: 1.0 },
  normal: { label: 'Normal', minClarity: 0.84, stableFrames: 4, gateBoost: 1.25 },
  strict: { label: 'Strict', minClarity: 0.91, stableFrames: 5, gateBoost: 1.8 },
};

/* The app's own beeps come out of the speakers and back into the microphone.
   Anything that makes a sound announces it here so the engine can stop
   listening for exactly as long as it lasts. */
let selfNoiseHandler = null;

export function onSelfNoise(fn) {
  selfNoiseHandler = fn;
}

function announceSelfNoise(ms) {
  if (selfNoiseHandler) selfNoiseHandler(ms);
}

export class PitchEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.source = null;
    this.raw = null;
    this.decimated = null;
    this.diff = null;
    this.cmnd = null;
    this.running = false;
    this.rafId = null;
    this.listeners = new Set();

    this.baseGate = MIN_GATE;
    this.gateBoost = SENSITIVITY.normal.gateBoost;
    this.gate = MIN_GATE;
    this.minClarity = SENSITIVITY.normal.minClarity;
    this.stableFrames = SENSITIVITY.normal.stableFrames;
    this.noiseFloor = 0;
    this.a4 = 440;

    this.env = 0;
    this.armed = true;
    this.armReference = null; // pitch of the last judged note, if it may still ring
    this.suppressedUntil = 0;
    this.history = [];
    this.lastFrame = null;
    this.error = null;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : null;
  }

  get decimatedRate() {
    return this.ctx ? this.ctx.sampleRate / 2 : null;
  }

  onFrame(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Opens the mic. Throws a friendly Error the UI can show as-is. */
  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser has no microphone access. Open the site over http://localhost in Chrome, Edge or Firefox.');
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Every one of these would fight the pitch detector.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      throw new Error(describeMicError(err));
    }

    this.stream = stream;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    this.source.connect(this.analyser);

    this.raw = new Float32Array(FFT_SIZE);
    this.decimated = new Float32Array(FFT_SIZE / 2);
    const tauMax = Math.floor(this.decimatedRate / FMIN) + 2;
    this.diff = new Float32Array(tauMax + 1);
    this.cmnd = new Float32Array(tauMax + 1);

    this.running = true;
    this.error = null;
    this.#loop();
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.history = [];
  }

  setGate(gate) {
    this.baseGate = Math.max(MIN_GATE, gate || MIN_GATE);
    this.gate = Math.max(MIN_GATE, this.baseGate * this.gateBoost);
  }

  setSensitivity(name) {
    const preset = SENSITIVITY[name] || SENSITIVITY.normal;
    this.minClarity = preset.minClarity;
    this.stableFrames = preset.stableFrames;
    this.gateBoost = preset.gateBoost;
    this.setGate(this.baseGate);
  }

  setA4(a4) {
    this.a4 = a4 || 440;
  }

  /**
   * Stop accepting answers until the string is released, freshly plucked, or a
   * clearly different note arrives.
   * @param {number|null} [ringingPitch] pitch that may still be sounding, so it
   *   is not mistaken for the next answer
   */
  disarm(ringingPitch = null) {
    this.armed = false;
    this.armReference = ringingPitch;
    this.history = [];
  }

  arm() {
    this.armed = true;
    this.armReference = null;
    this.history = [];
  }

  /** Ignore the microphone for `ms` — used while the app makes its own noise. */
  suppress(ms) {
    this.suppressedUntil = Math.max(this.suppressedUntil, performance.now() + ms);
    this.armed = false;
    this.history = [];
  }

  #loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.#loop);
    if (!this.analyser) return;

    this.analyser.getFloatTimeDomainData(this.raw);
    const rms = computeRms(this.raw);
    const suppressed = performance.now() < this.suppressedUntil;
    const envBefore = this.env;
    // While the app is making noise, let the envelope decay rather than
    // tracking our own beep — otherwise the next real pluck looks quiet.
    if (!suppressed) this.env = Math.max(rms, this.env * 0.92);
    else this.env = this.env * 0.92;

    // A fresh attack, or a released string, makes the engine listen again.
    const attack = !suppressed && rms > this.gate && rms > Math.max(envBefore * 1.6, this.gate * 1.2);
    const released = !suppressed && rms < this.gate * 0.8;
    if (!this.armed && (attack || released)) {
      this.armed = true;
      this.armReference = null;
    }

    let frame = {
      rms,
      db: 20 * Math.log10(Math.max(rms, 1e-9)),
      level: levelFromRms(rms, this.gate),
      loud: rms >= this.gate,
      armed: this.armed,
      attack,
      suppressed,
      freq: null,
      midiFloat: null,
      midi: null,
      cents: 0,
      clarity: 0,
      stable: false,
    };

    if (rms >= this.gate && !suppressed) {
      decimate(this.raw, this.decimated);
      const result = detectPitch(this.decimated, this.decimatedRate, this.diff, this.cmnd);
      if (result) {
        const midiFloat = freqToMidiFloat(result.freq, this.a4);
        const midi = Math.round(midiFloat);
        frame.freq = result.freq;
        frame.midiFloat = midiFloat;
        frame.midi = midi;
        frame.cents = Math.round((midiFloat - midi) * 100);
        frame.clarity = result.clarity;
        // Track the un-rounded pitch: a note sitting near a semitone boundary
        // would flicker between two names and never look settled otherwise.
        this.history.push(midiFloat);
        if (this.history.length > 6) this.history.shift();
        frame.stable = isPitchStable(this.history, 0.35, this.stableFrames) && result.clarity >= this.minClarity;

        // Playing a clearly different note means you have moved on, even if the
        // previous string is still ringing underneath.
        if (!this.armed && frame.stable && this.armReference != null) {
          if (Math.abs(midiFloat - this.armReference) > NEW_NOTE_SEMITONES) {
            this.armed = true;
            this.armReference = null;
          }
        }
      } else {
        this.history.length = 0;
      }
    } else {
      this.history.length = 0;
    }

    frame.armed = this.armed;
    this.lastFrame = frame;
    for (const fn of this.listeners) {
      try {
        fn(frame);
      } catch (err) {
        console.error('Frame listener failed', err);
      }
    }
  };

  /**
   * Listen to the room for `ms` and derive a noise gate from it.
   * Resolves with { noiseFloor, gate, peak, frames, verdict }.
   */
  calibrate(ms = 3000, onProgress) {
    return new Promise((resolve) => {
      const samples = [];
      const started = performance.now();
      const off = this.onFrame((frame) => {
        samples.push(frame.rms);
        const elapsed = performance.now() - started;
        if (onProgress) onProgress(Math.min(1, elapsed / ms), frame);
        if (elapsed >= ms) {
          off();
          const sorted = [...samples].sort((a, b) => a - b);
          const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0;
          const noiseFloor = p(0.9);
          const peak = sorted[sorted.length - 1] || 0;
          const gate = Math.max(MIN_GATE, noiseFloor * 4.5, peak * 1.6);
          resolve({
            noiseFloor,
            gate,
            peak,
            frames: samples.length,
            sampleRate: this.sampleRate,
            verdict: verdictFor(noiseFloor),
          });
        }
      });
    });
  }
}

function verdictFor(noiseFloor) {
  const db = 20 * Math.log10(Math.max(noiseFloor, 1e-9));
  if (db < -60) return { level: 'quiet', text: 'Quiet room. Detection should be crisp.' };
  if (db < -45) return { level: 'ok', text: 'Normal room noise. Good to go.' };
  if (db < -32) return { level: 'noisy', text: 'Fairly noisy — play a little firmer than usual.' };
  return { level: 'loud', text: 'Very noisy. Close a window or move the mic, then calibrate again.' };
}

function describeMicError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was blocked. Allow it in the address bar, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone found. Connect one and try again.';
  }
  if (name === 'NotReadableError') {
    return 'Another app is holding the microphone. Close it and try again.';
  }
  return `Microphone could not start: ${err && err.message ? err.message : 'unknown error'}`;
}

export function computeRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

/** 3-tap average then take every second sample: cheap anti-alias before decimating. */
function decimate(src, dst) {
  for (let i = 0, j = 0; j < dst.length; i += 2, j++) {
    const a = src[i - 1] || 0;
    const b = src[i];
    const c = src[i + 1] || 0;
    dst[j] = (a + 2 * b + c) / 4;
  }
}

/** Meter position: gate sits at ~15%, so you can see headroom above it. */
function levelFromRms(rms, gate) {
  const db = 20 * Math.log10(Math.max(rms, 1e-9));
  const floor = 20 * Math.log10(Math.max(gate, 1e-9)) - 12;
  return Math.max(0, Math.min(1, (db - floor) / (0 - floor)));
}

/**
 * Has the pitch settled? Measured as the spread of the last few readings in
 * semitones, so it does not care where the note falls between two frets.
 */
export function isPitchStable(history, spreadSemitones = 0.35, frames = 3) {
  const need = Math.max(2, frames);
  if (history.length < need) return false;
  const recent = history.slice(-need);
  return Math.max(...recent) - Math.min(...recent) <= spreadSemitones;
}

/**
 * YIN pitch detection.
 * @returns {{freq:number, clarity:number}|null}
 */
export function detectPitch(buf, sampleRate, diffBuf, cmndBuf) {
  const tauMin = Math.max(2, Math.floor(sampleRate / FMAX));
  const tauMax = Math.min(Math.floor(sampleRate / FMIN), Math.floor(buf.length / 2) - 1);
  if (tauMax <= tauMin) return null;

  const window = buf.length - tauMax;
  const diff = diffBuf && diffBuf.length > tauMax ? diffBuf : new Float32Array(tauMax + 1);
  const cmnd = cmndBuf && cmndBuf.length > tauMax ? cmndBuf : new Float32Array(tauMax + 1);

  diff[0] = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < window; j++) {
      const d = buf[j] - buf[j + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau];
    cmnd[tau] = running === 0 ? 1 : (diff[tau] * tau) / running;
  }

  // First dip under the threshold, walked down to its local minimum.
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < YIN_THRESHOLD) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }

  if (tau < 0) {
    // Nothing convincing: fall back to the best dip, and bail if it is weak.
    let best = tauMin;
    for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
    if (cmnd[best] > UNVOICED_CMND) return null;
    tau = best;
  }

  const refined = parabolic(cmnd, tau, tauMax);
  const freq = sampleRate / refined;
  if (!isFinite(freq) || freq < FMIN || freq > FMAX) return null;
  return { freq, clarity: Math.max(0, Math.min(1, 1 - cmnd[tau])) };
}

function parabolic(cmnd, tau, tauMax) {
  const x0 = tau > 1 ? tau - 1 : tau;
  const x2 = tau + 1 <= tauMax ? tau + 1 : tau;
  if (x0 === tau) return cmnd[tau] <= cmnd[x2] ? tau : x2;
  if (x2 === tau) return cmnd[tau] <= cmnd[x0] ? tau : x0;
  const s0 = cmnd[x0];
  const s1 = cmnd[tau];
  const s2 = cmnd[x2];
  const denom = 2 * (2 * s1 - s2 - s0);
  if (denom === 0) return tau;
  return tau + (s2 - s0) / denom;
}

/* ---- Feedback tones -------------------------------------------------- */

let toneCtx = null;
function toneContext() {
  if (!toneCtx || toneCtx.state === 'closed') {
    toneCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (toneCtx.state === 'suspended') toneCtx.resume();
  return toneCtx;
}

/** A short plucked-ish tone, used for "hear this note" and for feedback. */
export function playTone(freq, ms = 700, { type = 'triangle', gain = 0.16 } = {}) {
  // Speakers feed the microphone; hold detection off until this has died away.
  announceSelfNoise(ms + 320);
  try {
    const ctx = toneContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(gain, now + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);
    osc.connect(amp).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + ms / 1000 + 0.05);
  } catch (err) {
    /* audio is a nicety; never let it break a session */
  }
}

export function playNoteTone(midi, a4 = 440, ms = 900) {
  playTone(midiToFreq(midi, a4), ms, { type: 'triangle', gain: 0.18 });
}

export function playCorrect() {
  announceSelfNoise(90 + 160 + 320);
  playTone(880, 120, { type: 'sine', gain: 0.1 });
  setTimeout(() => playTone(1320, 160, { type: 'sine', gain: 0.08 }), 90);
}

export function playWrong() {
  playTone(150, 220, { type: 'sawtooth', gain: 0.07 });
}

export function playLevelUp() {
  announceSelfNoise(3 * 90 + 260 + 320);
  [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => playTone(f, 260, { type: 'sine', gain: 0.09 }), i * 90));
}
