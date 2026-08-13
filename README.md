# FretPro

Learn every note on the guitar fretboard, three at a time, using your guitar as the input device.

Three notes on one string, then three more, then the whole string, then two strings
together — widening until the whole neck is one map. Play the note it asks for and it
moves on; play the wrong one and it goes red until you find the right one.

## Running it

```bash
npm start
```

Then open **http://localhost:5173**.

The microphone only works on a secure origin. `http://localhost` counts as one;
double-clicking `index.html` does not, so use the server. Any static server works —
`python -m http.server 5173` is equivalent.

Progress lives in the browser's localStorage. Connect Supabase (below) and it
follows you between devices instead. Setup → Data still has export and import.

## Cloud saves (optional)

Sign in with a username, no password, and progress syncs everywhere.

**1. Make a Supabase project** at supabase.com — the free tier is plenty.

**2. Run the schema.** SQL Editor → New query → paste all of `supabase/schema.sql`
→ Run. This creates the `profiles` table and the two functions the app calls.

**3. Connect it.** Project Settings → API, then either paste the Project URL and
the `anon` key into `js/config.js`, or paste them into Setup → Account → *Connect
a project from here* to try it on one device without redeploying.

Then Setup → Account → pick a username. A name nobody has used becomes yours,
starting from whatever is already on this device. An existing name loads its
progress and merges this device into it.

### What syncing does and does not do

localStorage stays the source of truth while you practise, so sessions never
block on the network and everything works offline; the server is a sync target
that gets a debounced push after changes and a flush when the tab closes.

Two devices used offline both keep their work — merging takes the better value
per field rather than letting the last device to sync overwrite the other. Levels
never go down, XP never shrinks, and each note's schedule comes from whichever
device saw it most recently. **Microphone calibration never syncs**: a noise gate
measured on one laptop's mic is wrong on another.

### The security trade

Signing in with a username and no password means exactly what it sounds like:
**anyone who knows your username can load and overwrite that profile.** There is
no way around that while keeping passwordless sign-in, so keep it to practice
progress and pick a name that is not obvious if that matters to you.

What the schema does prevent is bulk access. The `profiles` table has row level
security on with no policies, so the anon key cannot read or write it directly at
all. The only way in is `get_profile` and `save_profile`, both of which need an
exact username — nobody can list who exists or dump every row. Deletes are not
exposed at all.

The anon key belongs in client code; it identifies the project and grants nothing
on its own. The SQL is what guards the data.

## Deploying

The repo is already a static site with no build step, so any host works.

**Vercel, from the GitHub repo** — import `azkrebs1/fretpro` at vercel.com/new and
deploy. `vercel.json` already tells it there is no build. Pushes to `main` then
redeploy automatically.

**Vercel, from the CLI** — `npx vercel` in this folder, then `npx vercel --prod`.

Microphone access needs HTTPS, which any Vercel URL gives you. If you use the
Setup → Account connect form rather than `js/config.js`, remember it is per
browser, so the deployed site needs its own connection or the values committed.

## How practice works

**Calibration.** Before a session it listens to three seconds of your room, then asks
you to play. The threshold lands in the gap between the two — a third of the way up
from the room toward your guitar — because the noise floor on its own says nothing
about how much headroom your playing actually has. Recalibrate when you move rooms or
change mics; Setup chooses whether that happens every session, only when the last one
is stale (default), or never.

**What counts as a played note.** A gate only rejects things that are *quiet*. Telling
a note from a chair creak, a voice or a knock takes more than loudness, so a sound must
also hold a steady pitch, clearly enough, for long enough. Setup → *What counts as a
played note* has three settings; go to Strict if stray sounds are answering for you.

**The app never answers its own prompts.** Feedback beeps and the "Hear it" button come
out of the speakers and straight back into the microphone, so every sound the app makes
holds detection off until it has died away.

**Judging.** Pitch detection is YIN, running about 60 times a second on a 2× decimated
buffer. A note has to hold steady across several frames before it counts, which keeps
string squeaks and fret noise from answering for you. Steadiness is measured on the
raw pitch rather than the note name, so a note sitting between two frets still settles
instead of flickering.

A guitar note rings for seconds, so after each answer the engine closes and will not
reopen until the string is released, a fresh attack arrives, or a clearly different
pitch settles. A new prompt never forces it open — otherwise the note you just played
would answer the next question for you.

**How close you have to be.** Setup has a *How far off still counts* slider, ±20 to
±85 cents, default ±70. Judging works on the un-rounded pitch, so the window can be
wider than the ±50 cents you would get from snapping to the nearest semitone first —
a guitar that has drifted well flat still passes. The next fret is 100 cents away, so
at the default there are 30 cents of margin before a wrong fret could sneak through.
When an accepted note is more than 35 cents off, the session says so, which is usually
the first sign the guitar needs tuning.

By default a right note in the wrong octave counts as correct, and the app says so.
Setup can tighten that to exact-string-only.

**The clock.** One slider in Setup, from 20 seconds down to no clock at all. Higher
lesson levels tighten it — level 2 runs at 80% of your setting, level 3 at 65% — which
you can switch off. When the clock runs out the answer is revealed and the note is
marked as missed.

**Scheduling.** Every position on the neck carries its own record. Answer it quickly
and correctly and it moves up a box, coming back in minutes, then hours, then days,
then weeks. Miss it and it drops two boxes and starts turning up much more often.
Nothing you have learned is ever dropped from rotation.

**Levels.** Each lesson has three: Learn (12 prompts, 75% to pass), Practice (15
prompts, 85%), Master (20 prompts, 90%). Clearing level 1 unlocks the next lesson.
Only first-try answers count toward accuracy.

## Without a guitar

Setup → Input → *Tap the board* swaps the microphone for the on-screen fretboard.
Same lessons, same scheduling, same progress — useful on a train.

## Scales

A second track, unlocked once the note path clears "All six strings" — shapes only
mean something once you know what the notes are called. There is an *Open it anyway*
button on the locked screen if you disagree.

Each unit takes one shape and works it four ways:

- **Runs** — play the shape in order, root to root, then the whole box, ascending and
  descending. Wrong notes wait for you at levels 1 and 2; at level 3 a slip restarts
  the run, the way you would actually practise it.
- **Find the roots** — every root in the shape. This is what lets you move it.
- **Name the degrees** — "play the ♭3", accepted in any octave.
- **Stay in key** — improvise: play N notes from the scale in any order, using every
  note of it at least once, with no note twice in a row. Anything outside the scale
  shows red.

Order: A minor pentatonic box 1, then box 2, then the same shape moved to E, G and D,
then major pentatonic, the blues scale, and the major scale in three-notes-per-string.

The Drill tab has a **scale drill** for free practice: any scale, any of the twelve
roots, any shape, any of the four exercises, with its own clock. Shapes that would run
off the end of the neck in the chosen key are marked and cannot be picked. Nothing
there unlocks lessons, but the notes still feed your fretboard schedule. Both drill
builders have their own clock slider, independent of the one in Setup.

**Shapes are generated, not typed in.** A box is one unbroken climb through the scale:
each string picks up at the next scale tone above where the previous string stopped.
That is the actual definition of both the CAGED boxes and the three-notes-per-string
system, so the awkward parts — box 2 dipping below its start on the A string, the
B-string shift — fall out on their own rather than needing special cases. The tests
check the generated fingerings against the shapes guitarists actually play.

Runs feed the same spaced-repetition schedule as the note track, so practising scales
also fills in your fretboard heat map.

## The path

13 units, 108 positions, frets 0 to 17:

1–2. Low E and A strings, natural notes, three at a time
3. E and A together
4–5. D and G strings
6. The bass four together
7–8. B and high E strings
9. All six strings, naturals
10–11. Sharps and flats, bass strings then treble
12. Every note, frets 0–12, by position
13. Past the octave, frets 12–17

## Layout

```
index.html            shell and screen containers
css/app.css           the whole visual system
js/theory.js          tuning, note naming, fretboard math
js/curriculum.js      the note track's unit/lesson path
js/scales.js          scale formulas and generated box shapes
js/scaleCurriculum.js the scales track
js/srs.js             spaced repetition and mastery scoring
js/store.js           persistence, and the two-device merge
js/config.js          Supabase URL and key
js/cloud.js           sign-in and sync
js/audio.js           mic capture, calibration, YIN pitch detection
js/fretboard.js       SVG board: prompts, tap input, heat map
js/session.js         the prompt/judge/advance loop
js/ui.js              screens and wiring
js/main.js            boot
supabase/schema.sql   table, functions and grants
server.js             zero-dependency static server for local use
vercel.json           static deploy config
test/logic.test.js    node --test
```

## Tests

```bash
npm test
```

Covers the fretboard math, the shape of the path, the scheduling rules, and pitch
detection against synthesised plucks at all 108 positions — including a weak
fundamental, a missing fundamental, and a noisy room.

## Notes

- The path is laid out for standard tuning. Other tunings are supported and everything
  follows them, but a lesson built around natural notes may include a sharp once the
  strings move.
- Sound feedback and the count-in can be turned off in Setup.
- Space replays the target note during a session.
