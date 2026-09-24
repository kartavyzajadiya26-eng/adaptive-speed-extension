// Offline benchmark for voice detection and the speed controller.
//
//   python3 eval/fetch_data.py                       # once: download + convert clips
//   npm run bench                                    # all sets, all detectors
//   npm run bench -- --detectors=silero --sets=music # subset
//
// Part 1 scores each detector frame by frame (60 fps, like the extension)
// on continuous streams built from real recordings, against labels derived
// from the clean speech. Part 2 plays four simulated 3-minute talks through
// the real SpeedController with playback speed changing as it decides, and
// reports what a viewer would experience: speech heard sped up, time saved,
// and how often the speed lurches.
import { readdirSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { SR, readWav, writeWav, rng, pinkNoise, activeRmsDb, rmsDb, gain, fit, addInto, fade } from "./lib/audio";
import { AnalyserSim } from "./lib/analyserSim";
import { HeuristicVad as HeuristicV1 } from "./baselines/heuristicV1";
import { HeuristicVad as HeuristicCurrent } from "../src/audio/voiceActivity";
import { computeRmsDb, computeVoiceBandRatio, computeZeroCrossingRate } from "../src/audio/audioAnalyzer";
import { parseSileroWeights, SILERO_SAMPLE_RATE, type SileroWeights } from "../src/audio/sileroVad";
import { NeuralVoiceStream } from "../src/audio/neuralVad";
import { StreamingResampler } from "../src/audio/resampler";
import { SpeedController } from "../src/core/speedController";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "../src/types";
import { readFileSync } from "fs";

const ROOT = process.cwd();
const DATA = join(ROOT, "eval", "data", "wav48");
const HOP = 480; // label resolution: 10 ms
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k!, v ?? "true"];
  })
);
const settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
if (args.minVoiceMs) settings.minVoiceMs = Number(args.minVoiceMs);
if (args.minSilenceMs) settings.minSilenceMs = Number(args.minSilenceMs);
if (args.replay) settings.replaySentenceStarts = args.replay === "true";
if (args.bandBias) settings.voiceBandBias = args.bandBias === "true";
if (args.silenceDb) settings.silenceThresholdDb = Number(args.silenceDb);
if (args.pause) settings.pauseHandling = args.pause as ExtensionSettings["pauseHandling"];

// ------------------------------------------------------------------ labels

/** Speech labels from the clean utterance: 10 ms frames above (95th
 *  percentile - 30 dB), word gaps under 250 ms closed, 20 ms margins. */
function oracleLabels(clean: Float32Array): Uint8Array {
  const n = Math.ceil(clean.length / HOP);
  const db = new Float64Array(n);
  for (let f = 0; f < n; f++) db[f] = rmsDb(clean, f * HOP, Math.min(clean.length, (f + 1) * HOP));
  const sorted = Array.from(db).sort((a, b) => a - b);
  const thr = Math.max(sorted[Math.floor(n * 0.95)]! - 30, -70);
  const lab = new Uint8Array(n);
  for (let f = 0; f < n; f++) lab[f] = db[f]! > thr ? 1 : 0;
  // close gaps < 250 ms
  let last = -1;
  for (let f = 0; f < n; f++) {
    if (lab[f]) {
      if (last >= 0 && f - last - 1 < 25) for (let g = last + 1; g < f; g++) lab[g] = 1;
      last = f;
    }
  }
  // drop islands < 50 ms
  for (let f = 0; f < n; ) {
    if (!lab[f]) { f++; continue; }
    let e = f;
    while (e < n && lab[e]) e++;
    if (e - f < 5) for (let g = f; g < e; g++) lab[g] = 0;
    f = e;
  }
  // 20 ms margins
  const out = lab.slice();
  for (let f = 0; f < n; f++) if (lab[f]) for (let d = -2; d <= 2; d++) if (f + d >= 0 && f + d < n) out[f + d] = 1;
  return out;
}

// ------------------------------------------------------------------ data

interface Segment { name: string; group: string; start: number; end: number }
interface Stream { name: string; signal: Float32Array; labels: Uint8Array; segments: Segment[] }

const list = (sub: string) => readdirSync(join(DATA, sub)).filter((f) => f.endsWith(".wav")).sort();
const cache = new Map<string, Float32Array>();
const load = (sub: string, f: string) => {
  const k = `${sub}/${f}`;
  if (!cache.has(k)) cache.set(k, readWav(join(DATA, sub, f)));
  return cache.get(k)!;
};

interface Utt { name: string; audio: Float32Array; labels: Uint8Array; activeDb: number }
let utts: Utt[] | null = null;
function utterances(): Utt[] {
  if (!utts) {
    utts = list("speech").map((f) => {
      const audio = load("speech", f);
      const labels = oracleLabels(audio);
      return { name: f, audio, labels, activeDb: activeRmsDb(audio, labels, HOP) };
    });
  }
  return utts;
}

/** Loudest 100 ms window, used to level sparse clips (ESC-50 has gaps). */
function peakWindowDb(x: Float32Array): number {
  let best = -200;
  for (let i = 0; i + 4800 <= x.length; i += 2400) best = Math.max(best, rmsDb(x, i, i + 4800));
  return best;
}

class StreamBuilder {
  private parts: { x: Float32Array; lab: Uint8Array; seg?: Omit<Segment, "start" | "end"> }[] = [];
  add(x: Float32Array, lab: Uint8Array | 0 | 1, seg?: Omit<Segment, "start" | "end">): void {
    const n = Math.ceil(x.length / HOP);
    const l = typeof lab === "number" ? new Uint8Array(n).fill(lab) : lab;
    this.parts.push({ x, lab: l, seg });
  }
  build(name: string, bedDb: number | null, seed: number): Stream {
    // Every part is padded to whole 10 ms frames so labels line up.
    const total = this.parts.reduce((a, p) => a + Math.ceil(p.x.length / HOP) * HOP, 0);
    const signal = new Float32Array(total);
    const labels = new Uint8Array(total / HOP);
    const segments: Segment[] = [];
    let at = 0;
    for (const p of this.parts) {
      addInto(signal, p.x, at);
      labels.set(p.lab.subarray(0, Math.ceil(p.x.length / HOP)), at / HOP);
      const end = at + Math.ceil(p.x.length / HOP) * HOP;
      if (p.seg) segments.push({ ...p.seg, start: at, end });
      at = end;
    }
    if (bedDb !== null) addInto(signal, gain(pinkNoise(total, seed), bedDb - rmsDb(pinkNoise(48000, seed))));
    return { name, signal, labels, segments };
  }
}

const silenceSec = (s: number) => new Float32Array(Math.round(s * SR));

function speechSet(name: string, levelDb: number, roomDb: number): Stream {
  const b = new StreamBuilder();
  for (const u of utterances()) {
    b.add(silenceSec(1), 0);
    b.add(gain(u.audio, levelDb - u.activeDb), u.labels, { name: u.name, group: "speech" });
  }
  b.add(silenceSec(1), 0);
  return b.build(name, roomDb, 11);
}

function speechOverSet(name: string, snr: number, beds: { name: string; audio: Float32Array; group: string }[], bedLevelDb: number): Stream {
  const b = new StreamBuilder();
  const us = utterances().filter((_, i) => i % 3 === 0);
  us.forEach((u, i) => {
    const bed = beds[i % beds.length]!;
    const bedAudio = gain(bed.audio, bedLevelDb - rmsDb(bed.audio));
    const pad = Math.round(2 * SR);
    const len = pad + u.audio.length + pad;
    const mix = fit(bedAudio, len, (i * 7919) % bedAudio.length);
    addInto(mix, gain(u.audio, bedLevelDb + snr - u.activeDb), pad);
    const lab = new Uint8Array(Math.ceil(len / HOP));
    lab.set(u.labels, pad / HOP);
    b.add(fade(mix), lab, { name: `${u.name}+${bed.name}`, group: bed.group });
  });
  return b.build(name, -70, 12);
}

function nonSpeechSet(name: string, sub: string, groupOf: (f: string) => string, level: (x: Float32Array) => number, targetDb: number): Stream {
  const b = new StreamBuilder();
  for (const f of list(sub)) {
    const x = load(sub, f);
    b.add(silenceSec(0.5), 0);
    b.add(fade(gain(x, targetDb - level(x))), 0, { name: f, group: groupOf(f) });
  }
  b.add(silenceSec(0.5), 0);
  return b.build(name, -65, 13);
}

const ENV_GROUP: Record<string, string> = {
  laughing: "human sounds", clapping: "human sounds", crying_baby: "human sounds", coughing: "human sounds",
  sneezing: "human sounds", breathing: "human sounds",
  footsteps: "everyday noises", keyboard_typing: "everyday noises", mouse_click: "everyday noises", door_wood_knock: "everyday noises",
  vacuum_cleaner: "steady noise", washing_machine: "steady noise", rain: "steady noise", wind: "steady noise", engine: "steady noise", airplane: "steady noise",
  church_bells: "tones & alarms", siren: "tones & alarms", clock_alarm: "tones & alarms", car_horn: "tones & alarms",
  dog: "animals", rooster: "animals", chirping_birds: "animals",
};
const envCategory = (f: string) => f.replace(/_\d+\.wav$/, "");

function noiseBeds(): { name: string; audio: Float32Array; group: string }[] {
  const picks = ["vacuum_cleaner_0.wav", "washing_machine_0.wav", "rain_0.wav", "engine_0.wav", "airplane_0.wav"];
  const beds = picks.map((f) => ({ name: envCategory(f), audio: load("env", f), group: envCategory(f) }));
  beds.push({ name: "pink", audio: pinkNoise(SR * 10, 5), group: "pink" });
  return beds;
}
function musicBeds(): { name: string; audio: Float32Array; group: string }[] {
  return list("music").map((f) => ({ name: f.replace(".wav", ""), audio: load("music", f), group: f.replace(/_\d+\.wav$/, "") }));
}

// ------------------------------------------------------------------ talks (end-to-end)

function talk(name: string, seed: number, opts: {
  speechDb: number; roomDb: number; bed?: { audio: Float32Array; db: number };
  interludes?: { audio: Float32Array; db: number; every: number }[];
}): Stream {
  const r = rng(seed);
  const b = new StreamBuilder();
  const us = utterances();
  let t = 0;
  let i = Math.floor(r() * us.length);
  let n = 0;
  while (t < 180 * SR) {
    const u = us[i % us.length]!;
    const x = gain(u.audio, opts.speechDb - u.activeDb);
    b.add(x, u.labels);
    t += x.length;
    const q = r();
    const pause = q < 0.6 ? 0.3 + r() * 0.6 : q < 0.85 ? 0.9 + r() * 1.1 : 2.5 + r() * 5.5;
    const inter = opts.interludes?.find((it) => n % it.every === it.every - 1);
    if (inter && pause > 2) {
      const len = Math.round(Math.min(pause, 6) * SR);
      b.add(fade(gain(fit(inter.audio, len), inter.db - peakWindowDb(inter.audio))), 0);
      t += len;
    } else {
      b.add(silenceSec(pause), 0);
      t += Math.round(pause * SR);
    }
    i += 1 + Math.floor(r() * 3);
    n++;
  }
  const s = b.build(name, opts.roomDb, seed);
  if (opts.bed) {
    const bed = gain(opts.bed.audio, opts.bed.db - rmsDb(opts.bed.audio));
    addInto(s.signal, fit(bed, s.signal.length));
  }
  return s;
}

// ------------------------------------------------------------------ detectors

interface Detector {
  name: string;
  /** Output is already debounced (tells the controller to skip smoothing). */
  debounced?: boolean;
  reset(): void;
  /** Decision with the playhead at content sample `pos`; dtMs is wall time since the last call. */
  frame(signal: Float32Array, pos: number, dtMs: number): boolean;
}

function rulesDetector(name: string, make: () => { isVoice: (f: any, s: ExtensionSettings, dtMs?: number) => boolean }): Detector {
  const an = new AnalyserSim();
  let vad = make();
  return {
    name,
    reset() { an.reset(); vad = make(); },
    frame(signal, pos, dtMs) {
      an.read(signal, pos);
      const features = {
        rmsDb: computeRmsDb(an.timeData),
        voiceBandRatio: computeVoiceBandRatio(an.freqData, SR, an.fftSize),
        zeroCrossingRate: computeZeroCrossingRate(an.timeData),
      };
      return vad.isVoice(features, settings, dtMs);
    },
  };
}

function sileroDetector(weights: SileroWeights): Detector {
  const stream = new NeuralVoiceStream(weights);
  let rs = new StreamingResampler(SR, SILERO_SAMPLE_RATE, 512, (c) => stream.push(c));
  let fed = 0;
  return {
    name: "silero",
    debounced: args.smooth !== "true",
    reset() { stream.reset(); rs = new StreamingResampler(SR, SILERO_SAMPLE_RATE, 512, (c) => stream.push(c)); fed = 0; },
    frame(signal, pos) {
      if (pos < fed) fed = pos; // a replay jumped back: audio continues from there
      if (pos > fed) {
        rs.process(signal.subarray(fed, Math.min(pos, signal.length)));
        fed = pos;
      }
      return stream.isVoice;
    },
  };
}

// ------------------------------------------------------------------ scoring

interface FrameScore { speech: number; speechHit: number; non: number; nonHit: number }
const emptyScore = (): FrameScore => ({ speech: 0, speechHit: 0, non: 0, nonHit: 0 });

function scoreStream(s: Stream, det: Detector, fps: number) {
  det.reset();
  const total = emptyScore();
  const byGroup = new Map<string, FrameScore>();
  const step = SR / fps;
  let segIdx = 0;
  const t0 = performance.now();
  for (let k = 1; ; k++) {
    const pos = Math.round(k * step);
    if (pos > s.signal.length) break;
    const v = det.frame(s.signal, pos, 1000 / fps);
    const lab = s.labels[Math.min(s.labels.length - 1, Math.floor((pos - 1) / HOP))]!;
    while (segIdx < s.segments.length && s.segments[segIdx]!.end < pos) segIdx++;
    const seg = s.segments[segIdx];
    const inSeg = seg && pos > seg.start && pos <= seg.end;
    for (const sc of [total, inSeg ? (byGroup.get(seg!.group) ?? byGroup.set(seg!.group, emptyScore()).get(seg!.group)!) : null]) {
      if (!sc) continue;
      if (lab) { sc.speech++; if (v) sc.speechHit++; } else { sc.non++; if (v) sc.nonHit++; }
    }
  }
  const cpuMsPerMin = ((performance.now() - t0) / (s.signal.length / SR)) * 60;
  return { total, byGroup, cpuMsPerMin };
}

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "  -  ");

interface TalkResult { replays: number; replayedSec: number; lostSpeechSec: number; speechFastSec: number; speechSec: number; savedSec: number; idealSavedSec: number; switches: number; flaps: number; minutes: number }

function simulateTalk(s: Stream, det: Detector, fps = 60): TalkResult {
  det.reset();
  const ctrl = new SpeedController(settings.normalSpeed);
  const frameMs = 1000 / fps;
  let content = 0;
  let wall = 0;
  let rate = settings.normalSpeed;
  let speechFast = 0;
  let speech = 0;
  let switches = 0;
  let flaps = 0;
  let fastStart = 0;
  // Speech 10 ms slices ever heard at normal speed (a rewind can replay a
  // slice first heard fast, so "lost" = never heard at normal speed).
  const heardNormal = new Uint8Array(s.labels.length);
  let replays = 0;
  let replayedSec = 0;
  while (content < s.signal.length) {
    const before = content;
    content += rate * frameMs * (SR / 1000);
    wall += frameMs;
    for (let p = Math.floor(before); p < Math.min(Math.floor(content), s.signal.length); p += HOP / 4) {
      const lab = s.labels[Math.floor(p / HOP)];
      const dur = Math.min(HOP / 4, Math.floor(content) - p) / SR;
      if (lab) {
        speech += dur;
        if (rate > settings.normalSpeed + 0.01) speechFast += dur;
        else heardNormal[Math.floor(p / HOP)] = 1;
      }
    }
    const pos = Math.min(Math.floor(content), s.signal.length);
    const v = det.frame(s.signal, pos, frameMs);
    const r = ctrl.update({ isVoice: v, isMotion: false, motionEnabled: false, debounced: det.debounced }, settings, wall, (pos / SR) * 1000);
    if (Math.abs(r - rate) > 0.001) {
      const wasNormal = rate <= settings.normalSpeed + 0.001;
      const isNormal = r <= settings.normalSpeed + 0.001;
      if (wasNormal !== isNormal) {
        // Count normal <-> fast transitions, not the steps of a ramp.
        switches++;
        if (!isNormal) fastStart = pos;
        else if (((pos - fastStart) / SR) * (1 - settings.normalSpeed / settings.quietSpeed) < 1) flaps++;
      }
      rate = r;
    }
    const back = ctrl.takeReplayTarget();
    if (back !== null) {
      const target = Math.floor((back / 1000) * SR);
      replays++;
      replayedSec += (content - target) / SR;
      content = target;
      wall += Number(args.seekCostMs ?? 60); // player pause while seeking
    }
  }
  // Ideal: every non-speech gap of 1 s or more played at quietSpeed.
  let ideal = 0;
  for (let f = 0; f < s.labels.length; ) {
    if (s.labels[f]) { f++; continue; }
    let e = f;
    while (e < s.labels.length && !s.labels[e]) e++;
    const len = ((e - f) * HOP) / SR;
    if (len >= 1) ideal += len * (1 - settings.normalSpeed / settings.quietSpeed);
    f = e;
  }
  let lost = 0;
  for (let f = 0; f < s.labels.length; f++) if (s.labels[f] && !heardNormal[f]) lost += HOP / SR;
  const contentSec = s.signal.length / SR;
  return { replays, replayedSec, lostSpeechSec: lost, speechFastSec: speechFast, speechSec: speech, savedSec: contentSec - wall / 1000, idealSavedSec: ideal, switches, flaps, minutes: contentSec / 60 };
}

// ------------------------------------------------------------------ main

function main(): void {
  const bin = readFileSync(join(ROOT, "src", "models", "silero_vad_16k.bin"));
  const weights = parseSileroWeights(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const all: Detector[] = [
    rulesDetector("rules-v1", () => new HeuristicV1()),
    rulesDetector("rules-now", () => new HeuristicCurrent()),
    sileroDetector(weights),
  ];
  const detWanted = args.detectors ? String(args.detectors).split(",") : null;
  const dets = all.filter((d) => !detWanted || detWanted.includes(d.name));
  const fps = Number(args.fps ?? 60);
  const setWanted = args.sets ? String(args.sets).split(",") : null;
  const want = (n: string) => !setWanted || setWanted.some((w) => n.startsWith(w));
  const results: Record<string, unknown> = { fps, date: new Date().toISOString() };

  const sets: [string, () => Stream][] = [
    ["speech-clean", () => speechSet("speech-clean", -26, -62)],
    ["speech-quiet", () => speechSet("speech-quiet", -42, -75)],
    ["speech+music 10dB", () => speechOverSet("speech+music 10dB", 10, musicBeds(), -30)],
    ["speech+music 5dB", () => speechOverSet("speech+music 5dB", 5, musicBeds(), -30)],
    ["speech+music 0dB", () => speechOverSet("speech+music 0dB", 0, musicBeds(), -30)],
    ["speech+noise 20dB", () => speechOverSet("speech+noise 20dB", 20, noiseBeds(), -40)],
    ["speech+noise 10dB", () => speechOverSet("speech+noise 10dB", 10, noiseBeds(), -35)],
    ["speech+noise 5dB", () => speechOverSet("speech+noise 5dB", 5, noiseBeds(), -32)],
    ["music", () => nonSpeechSet("music", "music", (f) => f.replace(/_\d+\.wav$/, ""), rmsDb, -20)],
    ["env", () => nonSpeechSet("env", "env", (f) => ENV_GROUP[envCategory(f)] ?? "other", peakWindowDb, -20)],
  ];

  if (!args.skipFrames) {
    console.log(`\n=== Part 1: frame-level detection (${fps} fps) ===`);
    console.log("speech kept = % of speech frames detected as speech (higher is better)");
    console.log("false speech = % of non-speech frames detected as speech (lower is better)\n");
    const header = ["set".padEnd(20), ...dets.map((d) => `${d.name}: kept / false`.padStart(26))].join(" ");
    console.log(header);
    const frameRes: Record<string, unknown> = {};
    for (const [name, make] of sets) {
      if (!want(name)) continue;
      const s = make();
      const rows = dets.map((d) => ({ d: d.name, ...scoreStream(s, d, fps) }));
      frameRes[name] = rows.map((r) => ({ detector: r.d, ...r.total, cpuMsPerMin: r.cpuMsPerMin, groups: Object.fromEntries(r.byGroup) }));
      const cells = rows.map((r) => `${pct(r.total.speechHit, r.total.speech).padStart(6)}% / ${pct(r.total.nonHit, r.total.non).padStart(5)}%`.padStart(26));
      console.log([name.padEnd(20), ...cells].join(" "));
      if (name === "music" || name === "env") {
        const groups = [...rows[0]!.byGroup.keys()].sort();
        for (const g of groups) {
          const gc = rows.map((r) => { const sc = r.byGroup.get(g)!; return `false ${pct(sc.nonHit, sc.non).padStart(5)}%`.padStart(26); });
          console.log(["  " + g.padEnd(18), ...gc].join(" "));
        }
      }
    }
    results.frames = frameRes;
  }

  if (!args.skipTalks) {
    console.log(`\n=== Part 2: simulated 3-minute talks through the speed controller ===`);
    const music = musicBeds();
    const env = (f: string) => load("env", f);
    const talks: Stream[] = [
      talk("quiet room", 101, { speechDb: -26, roomDb: -62 }),
      talk("music bed + applause", 202, {
        speechDb: -24, roomDb: -65, bed: { audio: music.find((m) => m.name === "jazz_0")!.audio, db: -34 },
        interludes: [{ audio: env("clapping_0.wav"), db: -22, every: 4 }, { audio: env("laughing_0.wav"), db: -24, every: 7 }],
      }),
      talk("noisy vlog", 303, {
        speechDb: -24, roomDb: -60, bed: { audio: env("rain_0.wav"), db: -40 },
        interludes: [{ audio: env("keyboard_typing_0.wav"), db: -30, every: 3 }, { audio: env("footsteps_0.wav"), db: -30, every: 5 }],
      }),
      talk("quiet voice", 404, { speechDb: -44, roomDb: -72 }),
    ];
    console.log("speech only heard fast = seconds of speech never heard at normal speed, per minute of speech (lower is better)");
    console.log("time saved     = seconds saved vs. an oracle that fast-forwards every non-speech gap of 1 s+ (higher is better)");
    console.log("lurches        = speed switches per minute, and fast stretches that saved under 1 s\n");
    const talkRes: Record<string, unknown> = {};
    if (args.export) {
      mkdirSync(join(ROOT, "eval", "results", "talks"), { recursive: true });
      for (const t of talks) {
        const slug = t.name.replace(/[^a-z0-9]+/gi, "-");
        writeWav(join(ROOT, "eval", "results", "talks", `${slug}.wav`), t.signal);
        writeFileSync(join(ROOT, "eval", "results", "talks", `${slug}.json`), JSON.stringify({ hopMs: 10, labels: Array.from(t.labels) }));
      }
      console.log("exported talks to eval/results/talks/");
    }
    for (const t of talks) {
      console.log(`-- ${t.name} (${(t.signal.length / SR / 60).toFixed(1)} min)`);
      talkRes[t.name] = {};
      for (const d of dets) {
        const r = simulateTalk(t, d, fps);
        (talkRes[t.name] as Record<string, unknown>)[d.name] = r;
        console.log(
          `   ${d.name.padEnd(10)} speech only heard fast ${((60 * r.lostSpeechSec) / Math.max(1, r.speechSec)).toFixed(2).padStart(5)} s/min | ` +
            `time saved ${r.savedSec.toFixed(1).padStart(5)} of ${r.idealSavedSec.toFixed(1)} s | ` +
            `lurches ${(r.switches / r.minutes).toFixed(1).padStart(4)}/min, ${r.flaps} short | ` +
            `replays ${(r.replays / r.minutes).toFixed(1)}/min (${r.replayedSec.toFixed(1)} s)`
        );
      }
    }
    results.talks = talkRes;
  }

  mkdirSync(join(ROOT, "eval", "results"), { recursive: true });
  const out = join(ROOT, "eval", "results", `bench-${args.tag ?? "latest"}.json`);
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${out}`);
}

main();
