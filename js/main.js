import { boot, openSheet, closeSheet, showScreen, renderCalibrate, h } from './ui.js';
import * as store from './store.js';

function firstRunWelcome() {
  const seen = store.getState().settings.deviceId;
  if (seen) return;
  store.setSetting('deviceId', Math.random().toString(36).slice(2));

  openSheet(
    'Before you start',
    [
      h('p', { class: 'lede', text: 'Plug in or point your laptop mic at the guitar. FretPro listens for one note at a time, so play cleanly and let it ring.' }),
      h('ul', { style: 'color:var(--ink-dim);font-size:13.5px;padding-left:18px;line-height:1.7' }, [
        h('li', { text: 'Every session starts by listening to three seconds of your room, so it can tell your guitar from the fan and the fridge.' }),
        h('li', { text: 'Right note: it moves on. Wrong note: it flashes red and you try again until the clock runs out.' }),
        h('li', { text: 'The clock is yours to set — Setup has a slider from 20 seconds down to none at all.' }),
      ]),
    ],
    [
      h('button', { class: 'btn is-primary', onclick: () => { closeSheet(); renderCalibrate({ thenStart: false }); showScreen('calibrate'); } }, [
        'Calibrate the mic',
      ]),
      h('button', { class: 'btn is-ghost', onclick: closeSheet }, ['Later']),
    ]
  );
}

function start() {
  boot();
  firstRunWelcome();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
