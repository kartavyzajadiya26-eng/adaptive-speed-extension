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
