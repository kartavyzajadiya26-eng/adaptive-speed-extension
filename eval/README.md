# Detection benchmark

Tools for measuring how well the extension tells speech from everything else,
and what a viewer experiences as a result. Every change to detection or the
speed controller should be checked against these before and after.

## Setup (once)

```sh
python3 eval/fetch_data.py        # ~60 MB of public clips -> eval/data/ (git-ignored)
```

Sources: LibriSpeech (read speech), GTZAN (music, 10 genres) and ESC-50
(laughter, applause, noise, alarms, animals). Conversion to 48 kHz WAV uses
macOS `afconvert`; see the script for the `ffmpeg` equivalent.

## Offline benchmark (Node, ~2 min)

```sh
npm run bench                                   # everything
npm run bench -- --detectors=silero --sets=music
npm run bench -- --skipFrames --pause=relaxed   # controller experiments
```

**Part 1** scores each detector 60 times a second against labels derived from
the clean speech: *speech kept* (higher is better) and *false speech* on
music, noise and silence (lower is better). The DSP detectors run on an exact
emulation of Chrome's AnalyserNode (`lib/analyserSim.ts`).

**Part 2** plays four simulated 3-minute talks (quiet room, music bed with
applause, noisy vlog, quiet voice) through the real `SpeedController`, with the
playback speed changing as it decides. It reports speech the viewer never
heard at normal speed, time saved against an oracle that fast-forwards every
pause of 1 s or more, speed switches, and replays.

Detectors: `rules-v1` (the original heuristic, `baselines/heuristicV1.ts`),
`rules-now` (current backup detector), `silero` (the neural model).
Options: `--minVoiceMs`, `--minSilenceMs`, `--replay=true|false`,
`--pause=relaxed|balanced|aggressive`, `--silenceDb`, `--bandBias`, `--fps`,
`--export` (writes the talks as WAV for the browser test).

## Real-browser test (~25 min)

```sh
npm run bench -- --skipFrames --export   # once, writes eval/results/talks/
npm run build
node eval/browserTalk.js [--talks=quiet-room] [--modes=neural,rules] [--seconds=60] [--trace]
```

Plays the exported talks in real Chrome with the built extension, in real
time, and reports the same viewer metrics plus CPU per Chrome process, which
detector and capture path were active, and how long replay seeks stalled.
Speech that a replay played again at normal speed counts as heard
(`speechOnlyFastPerMin`); speech inside any forward jump in the playhead is
reported as skipped (`speechSkippedSec`), and every jump is listed
(`seekJumps`, `oddSteps`). `--trace` also writes each 100 ms sample and seek
to `eval/results/trace-*.json`.

## Model checks

```sh
python3 eval/export_silero.py   # re-export weights (needs: pip install onnx onnxruntime numpy)
npm run check:silero            # TypeScript model vs onnxruntime, and speed
npm run check:motion            # motion detector on synthetic scenes
```

## Debugging on a real site

In the page's DevTools console:

```js
localStorage.adaptiveSpeedDebug = "1"    // log detector state once a second
localStorage.adaptiveSpeedVad = "rules"  // force the backup detector
```
