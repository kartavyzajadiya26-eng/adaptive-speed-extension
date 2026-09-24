that trulry good 
# Adaptive Speed — test run history

All runs below happened in one earlier Claude Code session on **21 Sep 2026** (India time, 23:32 on 20 Sep to 00:39 on 21 Sep).
Each run loaded the built extension from `dist/` into a test Chrome browser driven by Playwright.

The scripts only printed results to the terminal. These numbers were recovered from that session's transcript:
`~/.claude/projects/-Users-kartavyas--adaptive-speed-extension/796b87c7-b5d0-474a-9939-4d9d5a3f3c58.jsonl`

The test scripts, test videos and screenshots are still here (temporary folder, may be deleted on reboot):
`/private/tmp/claude-501/-Users-kartavyas--adaptive-speed-extension/796b87c7-b5d0-474a-9939-4d9d5a3f3c58/scratchpad/e2e/`

These runs were all on the code **before** the lag fixes of 23 Sep 2026. None have been re-run since.

## 1. Local test page (drive.js), 23:32 to 23:45

A synthetic video alternating 3s loud / 3s silent.

| Time  | Speeds seen  | Result |
|-------|--------------|--------|
| 23:32 | 1.00 only    | Failed: never sped up |
| 23:34 | 1.00 only    | Failed: never sped up |
| 23:35 | 1.00 only    | Failed: audio read as silence (-100 dB) everywhere |
| 23:36 | 1.00 only    | Failed: decided 2.5x but the rate was not applied |
| 23:39 | 2.50 only    | Failed: stuck fast, audio still read as silence |
| 23:43 | 2.50 only    | Failed: loud audio not recognised as voice |
| 23:44 | 1.00 and 2.50 | Working |
| 23:45 | 1.00 and 2.50 | Working |

## 2. Reaction time on the local test page (lag_measure*.js)

How long after the audio changed until the speed changed.

| Time  | Loud to silent, speeds up after | Silent to loud, slows down after |
|-------|------------------|------------------|
| 23:51 | 668 to 679 ms    | 167 to 168 ms    |
| 23:52 (default settings) | 606 to 631 ms | 146 to 152 ms |
| 00:22 (default settings) | 647 to 649 ms | 115 to 116 ms |
| 00:37 (default settings) | 0 ms (see note) | 107 to 127 ms |

Note: the 0 ms readings in the last run are not explained in the transcript. Treat them as a measurement artifact until re-run.

## 3. Real YouTube videos (drive_youtube.js, drive_ted.js)

| Time  | Video      | Speeds seen    |
|-------|------------|----------------|
| 23:48 | YouTube    | 2.50 and 1.00  |
| 23:49 | YouTube    | 2.50 and 1.00  |
| 23:54 | YouTube    | 1.00 only      |
| 23:56 | YouTube    | 1.00 only      |
| 00:14 | TED talk   | 1.00 and 2.50  |
| 00:25 | TED talk   | 2.50 and 1.00  |
| 00:39 | TED talk   | 2.50 and 1.00  |

## 4. Steady background noise (noise_drive.js), 00:21

18s of constant white noise with no voice.
The extension first treated it as voice, then adapted and sped up after **7.9 s**. Result: success.

## 5. Simon Sinek talk on YouTube, 60 s each (drive_sinek.js)

| Measure | 00:28 | 00:29 | 00:31 |
|---------|-------|-------|-------|
| Time to find the video      | 7.3 s  | 6.7 s  | 6.9 s  |
| Speed changes               | 1      | 3      | 3      |
| Time at 1x                  | 51.3 % | 56.4 % | 92.3 % |
| Time at 2.5x                | 48.7 % | 43.6 % | 7.7 %  |
| Average fast segment        | 28.6 s | 12.8 s | 2.3 s  |
| Average normal segment      | 30.2 s | 16.6 s | 27.2 s |
| Badge disagreed with actual speed | 21 of 40 | 22 of 40 | 0 of 40 |
| Samples where video was unexpectedly paused | 21 | 22 | 18 |
| Samples where video was stalled or buffering | 27 | 27 | 18 |

Video time moved backwards by about 15 s in every run, so the video was likely rewinding or reloading during the test.
The high paused and stalled counts match the lag you reported. Buffering read as silence was one of the causes fixed on 23 Sep.
Console errors in these runs came from YouTube itself (ads, 401/403), not from the extension.

## 6. Real-video monitoring with CPU and memory (24 Sep 2026)

Each video was played for 60 s in a fresh test browser, once with the extension and once without, on the build with the lag fixes and pause learning.
CPU is the share of one CPU core, averaged over the 60 s. "Page script" is JavaScript time on the page's main thread.
Memory is the peak resident memory of all page processes (renderers), which includes the extension's own process when it's loaded.

| Video | Extension | CPU, all Chrome | CPU, page process | Page script | Page memory, peak | Time at 2.5x | Speed switches |
|-------|-----------|-----------------|-------------------|-------------|-------------------|--------------|----------------|
| YouTube: Julian Treasure (TED) | with | 32.8% | 26.7% | 1.4% | 1159 MB | 11.9% | 3 |
| YouTube: Julian Treasure (TED) | without | 30.2% | 24.8% | 0.5% | 955 MB | 0% | 0 |
| YouTube: Simon Sinek | with | 37.3% | 30.9% | 1.3% | 1172 MB | 21.4% | 12 |
| YouTube: Simon Sinek | without | 30.1% | 24.2% | 0.8% | 1051 MB | 0% | 0 |
| YouTube: Brené Brown (TEDx) | with | 24.6% | 20.4% | 0.6% | 878 MB | 0% | 0 |
| YouTube: Brené Brown (TEDx) | without | 32.0% | 26.2% | 0.6% | 1120 MB | 0% | 0 |
| TED.com player: Julian Treasure | with | 43.3% | 28.3% | 7.6% | 3621 MB | 0% | 0 |
| TED.com player: Julian Treasure | without | 39.9% | 26.2% | 7.3% | 3265 MB | 0% | 0 |
| Vimeo 76979871 | both | failed: no video found within 30 s | | | | | |

What this shows:
- **Extension cost:** about 1 percentage point of page script time and 2 to 7 points of total CPU, part of which is decoding video faster at 2.5x. Page memory was 100 to 200 MB higher with the extension, mostly from the extension's own process.
- **No lag added:** zero long tasks and no frames over 50 ms from the extension in any run. The frame time 99th percentile stayed at about 17.6 ms, the same as without it.
- **Badge accuracy:** the on-video badge matched the real playback speed in every sample.
- **Pause learning:** Julian Treasure switched speed 3 times, compared with 9 in the same window before the fix.
- **Brené Brown with extension:** paused by itself after 8 s with no error shown, so there is no speed data. It needs a re-run.
- **TED.com:** the page autoplays muted, so the extension stays at 1x on purpose. It can't hear muted audio.
- **YouTube cut-off:** in the automated test browser, YouTube stops every video after about 45 to 60 s of content, with or without the extension.

## 7. Detection quality (24 to 25 Sep 2026)

The rule-based voice detector was replaced by the Silero speech model (v5, MIT licence, from the Silero team), run in TypeScript on the browser's audio thread. The old rules stay as the backup. Everything below comes from the benchmark in `eval/`: `npm run bench` for the offline numbers and `node eval/browserTalk.js` for real Chrome.

### Frame by frame: is this moment speech?
"Kept" is the share of speech detected as speech (higher is better). "False" is the share of non-speech called speech (lower is better). Before = the original rules at the original -45 dB threshold.

| Test set | Before: kept / false | Now (model): kept / false | Backup rules now: kept / false |
|---|---|---|---|
| Clean speech | 67.2% / 0.0% | 93.4% / 5.9% | 68.8% / 1.3% |
| Quiet speech | 44.7% / 0.0% | 92.6% / 5.6% | 61.9% / 0.0% |
| Speech over music, 10 dB | 46.1% / 14.4% | 92.0% / 9.5% | 45.4% / 14.5% |
| Speech over music, 0 dB | 20.6% / 15.9% | 88.8% / 15.7% | 19.4% / 15.8% |
| Speech in noise, 5 dB | 12.6% / 0.1% | 91.4% / 3.6% | 12.6% / 0.1% |
| Music only (false) | 23.9% | 2.3% | 23.8% |
| Everyday sounds only (false) | 22.1% | 0.1% | 22.9% |

The model's "false" on speech sets is mostly the ~100 ms tail it holds after each word, which the energy-based labels count as silence. Blues is its weak genre (23% false), probably because the clips have vocals.

### Simulated 3-minute talks through the speed controller
"Speech only heard fast" = seconds of speech per minute never heard at normal speed (lower is better). Time saved is out of what an ideal oracle would save.

| Talk | Before: fast-only / saved / switches per min | Now: fast-only / saved / switches per min |
|---|---|---|
| Quiet room | 1.37 / 12.2 of 26.8 s / 7.8 | 0.27 / 9.3 of 26.8 s / 6.5 |
| Music bed + applause | 1.55 / 13.1 of 31.8 s / 9.2 | 0.50 / 11.6 of 31.8 s / 7.7 |
| Noisy vlog | 2.06 / 17.1 of 30.8 s / 10.2 | 0.21 / 10.2 of 30.8 s / 9.5 |
| Quiet voice | 4.34 / 25.0 of 37.4 s / 15.3 | 0.34 / 13.0 of 37.4 s / 10.0 |

Part of the old "time saved" came from rushing through speech the old detector took for silence. The quiet-voice talk lost 4.3 s of every minute of speech that way. The "aggressive" pause setting saves 12.8 to 16.9 s on these talks, at 15 to 18 switches a minute.

### Bug found and fixed on 25 Sep
To save CPU, the model was skipped for chunks quieter than -70 dB. On a quiet recording whose room noise hovered around that level, each skip froze the model's memory at the last word, so the next faint noise read as speech. That caused 24 false speech starts in the pauses of the quiet-voice talk, each one cancelling a speed-up. Now only digital silence (-90 dB, e.g. a muted video) is skipped, and only after 256 ms, by which time the model's memory has settled. The result: 0 false starts, and quiet-voice time saved rose from 8.1 s to 13.0 s. After any length of silence the output stays within 0.03 of a model that never skips.

### Motion detector (`npm run check:motion`, synthetic scenes)
The old detector judged exposure flicker as motion 74% of the time and a camera pan 64%, and it missed a moving cursor and a hand gesture entirely. The new one gets all 9 scenes right: 0% on every still scene, and 72 to 97% on moving ones.

### Real sites, 25 Sep (40 s each, fixed build)
- **YouTube (Julian Treasure):** the model runs on the audio thread at 1.2 ms per chunk. Three sentence-start replays jumped back 0.16 to 0.18 s, and each stalled 22 to 29 ms.
- **TED.com:** the model runs on the audio thread. One extra video without readable audio (probably an ad) stayed at 1x, as designed.
- **Vimeo:** no video element found, as in section 6.
- **YouTube, Class 10 poetry lecture (EYnivEGGXoA, 55 s, run twice):** the opening ~19 s had speech probability 0 to 0.07 and played at 2.5x, probably an intro. From 20 s the lecture stayed at 1x throughout; the short gaps between phrases were correctly left at normal speed. The model was on the audio thread in 55 of 56 samples. One or two sentence-start replays per run jumped back 0.14 to 0.17 s and stalled 8 to 30 ms. After about 55 s YouTube reset the player (its automated-browser cut-off).

### Real Chrome, full talks played in real time (25 Sep)
Each talk was played end to end in Chrome with the built extension (`eval/browserTalk.js`). "Speech heard fast" = seconds per minute of speech crossed at more than 1x, whether or not a replay repeated it. Model rows use the fixed build. Backup rows use the first run of 25 Sep; that code path didn't change afterwards.

| Talk | Detector | Time saved | Speech heard fast | Switches/min | Replays/min | Replay stall, avg / max | Page process CPU |
|---|---|---|---|---|---|---|---|
| Quiet room | model | 8.4 s | 0.45 s/min | 8.1 | 2.9 | 10 / 82 ms | 10.9% |
| Quiet room | backup | 7.3 s | 0.21 s/min | 8.4 | 2.3 | 1 / 2 ms | 6.1% |
| Music bed + applause | model | 10.1 s | 0.61 s/min | 9.9 | 2.5 | 7 / 35 ms | 10.2% |
| Music bed + applause | backup | 9.7 s | 1.53 s/min | 13.6 | 2.9 | 1 / 3 ms | 6.2% |
| Noisy vlog | model | 9.0 s | 0.45 s/min | 12.5 | 3.6 | 0 / 2 ms | 10.8% |
| Noisy vlog | backup | 11.7 s | 0.79 s/min | 13.4 | 3.6 | 1 / 2 ms | 4.9% |
| Quiet voice | model | 12.0 s | 0.85 s/min | 14.9 | 4.0 | 0 / 2 ms | 12.8% |
| Quiet voice | backup | 13.4 s | 0.82 s/min | 18.8 | 5.6 | 0 / 1 ms | 2.3% |

- The model ran on the audio thread in every run, at 0.4 to 1.4 ms per 32 ms chunk, with none of it on the page's main thread. It costs about 4 to 10 points more page-process CPU than the backup rules.
- On the quiet-voice talk, the model-memory fix raised time saved in Chrome from 10.8 s to 12.0 s. Switching went from 13.3 to 14.9 a minute, because more pauses now get sped up.
- In the first run of 25 Sep, the quiet-room talk with the backup rules reported an impossible 76.7 s saved. A traced re-run gave 7.3 s with no playhead jumps. The harness now flags jumps and skipped speech, so a repeat of that glitch would be visible.
