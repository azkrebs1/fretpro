/* SVG fretboard: prompt display, tap input, and mastery heat map.

   Fret spacing follows real scale-length geometry (each fret at
   1 - 2^(-n/12) of the scale) blended slightly toward even spacing so the
   upper frets stay big enough to tap. */

import { midiAt, noteName, posKey, splitName } from './theory.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const INLAY_SINGLE = [3, 5, 7, 9, 15, 17, 21];
const INLAY_DOUBLE = [12, 24];

const GEOMETRY_BLEND = 0.62; // 1 = true scale spacing, 0 = even spacing

/* Markers sit on dark rosewood, so these run brighter and more saturated than
   the page palette and carry a light ring to separate them from the wood. */
const PALETTE = {
  target: '#3B7DDD',
  correct: '#49A85B',
  wrong: '#D2492F',
  ghost: '#B4A995',
  hint: '#5AA9E6',
};

const MARKER_RING = '#F6F2E7';

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

export function createFretboard(container, options = {}) {
  const opts = {
    minFret: 0,
    maxFret: 12,
    tuning: 'standard',
    spelling: 'sharps',
    flip: false,
    interactive: false,
    showOpenColumn: true,
    ...options,
  };

  let svg = null;
  let markerLayer = null;
  let heatLayer = null;
  let hitLayer = null;
  let labelLayer = null;
  let tapHandler = null;
  let geom = null;

  container.classList.add('fretboard-host');

  function computeGeometry() {
    const { minFret, maxFret } = opts;
    const span = maxFret - minFret;
    const padLeft = 96; // room for string labels plus the open-string cell
    const padRight = 26;
    const width = 1040;
    const stringGap = 27;
    const topPad = 30;
    const boardTop = topPad;
    const boardHeight = stringGap * 5 + 34;
    const boardBottom = boardTop + boardHeight;
    const height = boardBottom + 34;

    const nutX = padLeft;
    const endX = width - padRight;

    // Position of fret n measured from the nut, as a fraction of the drawn span.
    const scaleFrac = (n) => 1 - Math.pow(2, -n / 12);
    const fracAt = (n) => {
      const real = (scaleFrac(n) - scaleFrac(minFret)) / (scaleFrac(maxFret) - scaleFrac(minFret));
      const even = (n - minFret) / span;
      return real * GEOMETRY_BLEND + even * (1 - GEOMETRY_BLEND);
    };

    const fretX = (n) => nutX + fracAt(n) * (endX - nutX);

    const stringY = (stringNumber) => {
      // Tab layout by default: string 1 (high E) on top. Flip puts low E on top.
      const idx = opts.flip ? 6 - stringNumber : stringNumber - 1;
      return boardTop + 17 + idx * stringGap;
    };

    /** Centre of the playable cell for a fret (open notes sit left of the nut). */
    const cellCenterX = (fret) => {
      if (fret <= opts.minFret && opts.minFret === 0 && fret === 0) return nutX - 30;
      const prev = fretX(Math.max(opts.minFret, fret - 1));
      return (prev + fretX(fret)) / 2;
    };

    return { width, height, nutX, endX, boardTop, boardBottom, boardHeight, stringGap, fretX, stringY, cellCenterX };
  }

  function render() {
    container.textContent = '';
    geom = computeGeometry();
    const g = geom;

    svg = el('svg', {
      viewBox: `0 0 ${g.width} ${g.height}`,
      class: 'fretboard',
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': `Guitar fretboard, frets ${opts.minFret} to ${opts.maxFret}`,
    });
    container.appendChild(svg);

    const defs = el('defs', {}, svg);

    const wood = el('linearGradient', { id: uid('wood'), x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    el('stop', { offset: '0', 'stop-color': '#54341F' }, wood);
    el('stop', { offset: '0.45', 'stop-color': '#3E2618' }, wood);
    el('stop', { offset: '1', 'stop-color': '#2C1B11' }, wood);

    const nickel = el('linearGradient', { id: uid('nickel'), x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    el('stop', { offset: '0', 'stop-color': '#F2EFE6' }, nickel);
    el('stop', { offset: '0.5', 'stop-color': '#A9A398' }, nickel);
    el('stop', { offset: '1', 'stop-color': '#6E685D' }, nickel);

    const pearl = el('radialGradient', { id: uid('pearl'), cx: '0.35', cy: '0.3', r: '0.8' }, defs);
    el('stop', { offset: '0', 'stop-color': '#FBF7EC' }, pearl);
    el('stop', { offset: '0.6', 'stop-color': '#D9D2C2' }, pearl);
    el('stop', { offset: '1', 'stop-color': '#ADA595' }, pearl);

    // Open-string lane, so the area left of the nut reads as playable
    if (opts.minFret === 0) {
      el(
        'rect',
        {
          x: g.nutX - 50,
          y: g.boardTop,
          width: 44,
          height: g.boardHeight,
          rx: 4,
          fill: 'rgba(62, 48, 28, 0.05)',
          stroke: 'rgba(62, 48, 28, 0.13)',
          'stroke-width': 1,
        },
        svg
      );
    }

    // Board
    el(
      'rect',
      {
        x: g.nutX,
        y: g.boardTop,
        width: g.endX - g.nutX,
        height: g.boardHeight,
        rx: 3,
        fill: `url(#${wood.id})`,
      },
      svg
    );

    // Grain
    const grain = el('g', { opacity: '0.16' }, svg);
    for (let i = 0; i < 26; i++) {
      const y = g.boardTop + 4 + (i / 26) * (g.boardHeight - 8);
      el(
        'path',
        {
          d: `M ${g.nutX} ${y} Q ${(g.nutX + g.endX) / 2} ${y + (i % 3 === 0 ? 3.5 : -2.5)} ${g.endX} ${y + (i % 2 ? 1 : -1)}`,
          stroke: i % 4 === 0 ? '#7A4E2E' : '#241509',
          'stroke-width': i % 5 === 0 ? 1.1 : 0.6,
          fill: 'none',
        },
        grain
      );
    }

    // Inlays
    const inlays = el('g', { class: 'fb-inlays' }, svg);
    const midY = g.boardTop + g.boardHeight / 2;
    for (let f = Math.max(1, opts.minFret + 1); f <= opts.maxFret; f++) {
      const cx = (g.fretX(f - 1) + g.fretX(f)) / 2;
      if (INLAY_DOUBLE.includes(f)) {
        el('circle', { cx, cy: midY - g.stringGap * 1.2, r: 7, fill: `url(#${pearl.id})`, opacity: '0.9' }, inlays);
        el('circle', { cx, cy: midY + g.stringGap * 1.2, r: 7, fill: `url(#${pearl.id})`, opacity: '0.9' }, inlays);
      } else if (INLAY_SINGLE.includes(f)) {
        el('circle', { cx, cy: midY, r: 7, fill: `url(#${pearl.id})`, opacity: '0.85' }, inlays);
      }
    }

    // Fret wires
    const fretGroup = el('g', { class: 'fb-frets' }, svg);
    for (let f = Math.max(opts.minFret, 1); f <= opts.maxFret; f++) {
      const x = g.fretX(f);
      el(
        'rect',
        { x: x - 1.6, y: g.boardTop, width: 3.2, height: g.boardHeight, fill: `url(#${nickel.id})`, rx: 1.4 },
        fretGroup
      );
    }

    // Nut (or a heavier wire if the view starts up the neck)
    if (opts.minFret === 0) {
      el(
        'rect',
        {
          x: g.nutX - 7,
          y: g.boardTop - 2,
          width: 8,
          height: g.boardHeight + 4,
          rx: 2,
          fill: '#EDE4CC',
          stroke: '#A79B80',
          'stroke-width': 1,
        },
        svg
      );
      el('rect', { x: g.nutX - 6, y: g.boardTop - 1, width: 3, height: g.boardHeight + 2, rx: 2, fill: '#FFFAEC', opacity: '0.75' }, svg);
    } else {
      el('rect', { x: g.nutX - 3, y: g.boardTop - 2, width: 6, height: g.boardHeight + 4, rx: 2, fill: '#CFC8B8' }, svg);
    }

    // Strings — thicker toward the low E
    const strings = el('g', { class: 'fb-strings' }, svg);
    for (let s = 1; s <= 6; s++) {
      const y = g.stringY(s);
      const thickness = 0.9 + (s - 1) * 0.48;
      el('line', { x1: g.nutX - 40, y1: y, x2: g.endX, y2: y, stroke: '#0C0906', 'stroke-width': thickness + 1.6, opacity: '0.45' }, strings);
      el(
        'line',
        { x1: g.nutX - 40, y1: y, x2: g.endX, y2: y, stroke: s <= 2 ? '#D9D3C4' : '#B6A98C', 'stroke-width': thickness },
        strings
      );
    }

    // Fret numbers
    const numbers = el('g', { class: 'fb-numbers' }, svg);
    for (let f = opts.minFret === 0 ? 0 : opts.minFret; f <= opts.maxFret; f++) {
      const x = f === 0 ? g.nutX - 30 : (g.fretX(Math.max(opts.minFret, f - 1)) + g.fretX(f)) / 2;
      el(
        'text',
        {
          x,
          y: g.boardBottom + 22,
          'text-anchor': 'middle',
          class: 'fb-fretnum' + (INLAY_SINGLE.includes(f) || INLAY_DOUBLE.includes(f) ? ' is-marked' : ''),
        },
        numbers
      ).textContent = String(f);
    }

    // String labels
    labelLayer = el('g', { class: 'fb-stringlabels' }, svg);
    drawStringLabels();

    heatLayer = el('g', { class: 'fb-heat' }, svg);
    markerLayer = el('g', { class: 'fb-markers' }, svg);
    hitLayer = el('g', { class: 'fb-hits' }, svg);

    if (opts.interactive) drawHitAreas();
    return svg;
  }

  function drawStringLabels() {
    labelLayer.textContent = '';
    for (let s = 1; s <= 6; s++) {
      const y = geom.stringY(s);
      const open = noteName(midiAt(opts.tuning, s, 0), opts.spelling).split('/')[0];
      const t = el('text', { x: 16, y: y + 4, 'text-anchor': 'middle', class: 'fb-stringlabel' }, labelLayer);
      t.textContent = open;
      const n = el('text', { x: 36, y: y + 4, 'text-anchor': 'middle', class: 'fb-stringnum' }, labelLayer);
      n.textContent = s;
    }
  }

  function drawHitAreas() {
    hitLayer.textContent = '';
    for (let s = 1; s <= 6; s++) {
      const y = geom.stringY(s);
      for (let f = opts.minFret; f <= opts.maxFret; f++) {
        const isOpen = f === 0;
        const left = isOpen ? geom.nutX - 46 : geom.fretX(Math.max(opts.minFret, f - 1));
        const right = isOpen ? geom.nutX - 8 : geom.fretX(f);
        const rect = el(
          'rect',
          {
            x: left,
            y: y - geom.stringGap / 2,
            width: Math.max(10, right - left),
            height: geom.stringGap,
            fill: 'transparent',
            class: 'fb-hit',
            tabindex: '0',
            role: 'button',
            'data-string': s,
            'data-fret': f,
            'aria-label': `String ${s}, fret ${f}`,
          },
          hitLayer
        );
        const fire = (evt) => {
          evt.preventDefault();
          if (tapHandler) tapHandler({ string: s, fret: f });
        };
        rect.addEventListener('click', fire);
        rect.addEventListener('keydown', (evt) => {
          if (evt.key === 'Enter' || evt.key === ' ') fire(evt);
        });
      }
    }
  }

  let uidCount = 0;
  function uid(prefix) {
    uidCount += 1;
    return `${prefix}-${Math.random().toString(36).slice(2, 7)}-${uidCount}`;
  }

  /** markers: [{string, fret, kind, label, pulse}] */
  function setMarkers(markers = []) {
    if (!markerLayer) return;
    markerLayer.textContent = '';
    for (const m of markers) {
      if (m.fret < opts.minFret || m.fret > opts.maxFret) continue;
      const cx = m.fret === 0 ? geom.nutX - 30 : (geom.fretX(Math.max(opts.minFret, m.fret - 1)) + geom.fretX(m.fret)) / 2;
      const cy = geom.stringY(m.string);
      const color = PALETTE[m.kind] || PALETTE.target;
      const group = el('g', { class: `fb-marker is-${m.kind}${m.pulse ? ' is-pulsing' : ''}` }, markerLayer);
      if (m.kind !== 'ghost') {
        el('circle', { cx, cy, r: 17, fill: color, opacity: '0.18', class: 'fb-marker-halo' }, group);
      }
      el(
        'circle',
        {
          cx,
          cy,
          r: m.kind === 'ghost' ? 8 : 12.5,
          fill: m.kind === 'ghost' ? 'none' : color,
          stroke: m.kind === 'ghost' ? color : MARKER_RING,
          'stroke-width': m.kind === 'ghost' ? 2 : 1.6,
          'stroke-dasharray': m.kind === 'ghost' ? '3 3' : null,
        },
        group
      );
      if (m.label) {
        const text = el('text', { x: cx, y: cy + 4.5, 'text-anchor': 'middle', class: 'fb-marker-label' }, group);
        text.textContent = m.label;
      }
    }
  }

  /** heat: Map or object of posKey -> 0..1 */
  function setHeatmap(heat) {
    if (!heatLayer) return;
    heatLayer.textContent = '';
    if (!heat) return;
    const get = (k) => (heat instanceof Map ? heat.get(k) : heat[k]);
    for (let s = 1; s <= 6; s++) {
      for (let f = opts.minFret; f <= opts.maxFret; f++) {
        const value = get(posKey(s, f));
        if (value == null) continue;
        const cx = f === 0 ? geom.nutX - 30 : (geom.fretX(Math.max(opts.minFret, f - 1)) + geom.fretX(f)) / 2;
        const cy = geom.stringY(s);
        const color = heatColor(value);
        el('circle', { cx, cy, r: 11.5, fill: color, opacity: 0.25 + value * 0.65, class: 'fb-heatdot' }, heatLayer);
        if (value >= 0.999) {
          el('circle', { cx, cy, r: 14.5, fill: 'none', stroke: PALETTE.correct, 'stroke-width': 1.2, opacity: '0.7' }, heatLayer);
        }
      }
    }
  }

  function heatColor(value) {
    // unseen → warm grey, learning → sapphire, mastered → green
    if (value <= 0.02) return '#6B6152';
    const stops = [
      [0.0, [107, 97, 82]],
      [0.35, [46, 106, 200]],
      [0.7, [72, 158, 226]],
      [1.0, [96, 190, 110]],
    ];
    let lo = stops[0];
    let hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (value >= stops[i][0] && value <= stops[i + 1][0]) {
        lo = stops[i];
        hi = stops[i + 1];
        break;
      }
    }
    const t = hi[0] === lo[0] ? 0 : (value - lo[0]) / (hi[0] - lo[0]);
    const rgb = lo[1].map((c, i) => Math.round(c + (hi[1][i] - c) * t));
    return `rgb(${rgb.join(',')})`;
  }

  function setOptions(patch) {
    Object.assign(opts, patch);
    render();
  }

  function onTap(fn) {
    tapHandler = fn;
  }

  function setInteractive(on) {
    opts.interactive = on;
    if (hitLayer) {
      hitLayer.textContent = '';
      if (on) drawHitAreas();
    }
  }

  render();

  return {
    render,
    setMarkers,
    setHeatmap,
    setOptions,
    setInteractive,
    onTap,
    get options() {
      return { ...opts };
    },
    heatColor,
  };
}

/** Small standalone note badge used in lists and results. */
export function noteBadge(tuning, string, fret, spelling) {
  const name = noteName(midiAt(tuning, string, fret), spelling);
  const { letter, accidental } = splitName(name);
  const span = document.createElement('span');
  span.className = 'note-badge';
  span.innerHTML = `<b>${letter}${accidental}</b><i>${string}·${fret}</i>`;
  return span;
}
