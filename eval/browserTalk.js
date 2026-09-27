// Plays the exported talks (eval/results/talks/*.wav, from `npm run bench -- --export`)
// in real Chrome with the built extension, in real time, and measures what a
// viewer experiences: speech heard sped up, time saved, speed switches.
// Unlike the offline bench this includes Chrome's real time-stretching, the
// audio thread, and page timing.
//
//   npm run build && node eval/browserTalk.js [--talks=quiet-room,noisy-vlog] [--modes=neural,rules] [--seconds=60]
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "dist");
const TALKS = path.join(ROOT, "eval", "results", "talks");
const { execFileSync } = require("child_process");

/** CPU seconds used so far by each Chrome process type of one test profile. */
function cpuByType(profile) {
  const out = execFileSync("ps", ["-Ao", "pid=,time=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  const acc = {};
  for (const line of out.split("\n")) {
    if (!line.includes(profile)) continue;
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const secs = m[2].split(":").map(Number).reduce((a, p) => a * 60 + p, 0);
    const t = /--extension-process/.test(m[3]) ? "extension" : (m[3].match(/--type=([\w-]+)/) || [, "browser"])[1];
    acc[t] = (acc[t] || 0) + secs;
  }
  return acc;
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"]; }));

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split("?")[0]);
      if (url === "/player.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>talk</title><body style="margin:0;background:#111">
<video id="v" width="640" height="360" controls></video>
<script>const q=new URLSearchParams(location.search);const v=document.getElementById("v");v.src=q.get("src");
window.__seeks=[];window.__jumps=[];let s0=0,lastT=0,from=0;
v.addEventListener("seeking",()=>{s0=performance.now();from=lastT;});
v.addEventListener("seeked",()=>{window.__seeks.push(performance.now()-s0);window.__jumps.push({from:from,to:v.currentTime});});
(function loop(){if(!v.seeking)lastT=v.currentTime;requestAnimationFrame(loop);})();</script>`);
        return;
      }
      const file = path.join(ROOT, url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      const size = fs.statSync(file).size;
      const type = file.endsWith(".wav") ? "audio/wav" : "application/octet-stream";
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (range) {
        const start = range[1] ? +range[1] : 0;
        const end = range[2] ? +range[2] : size - 1;
        res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
        fs.createReadStream(file).pipe(res);
      }
    });
    server.listen(0, () => resolve(server));
  });
}

async function runTalk(port, slug, mode, maxSeconds) {
  const labels = JSON.parse(fs.readFileSync(path.join(TALKS, `${slug}.json`), "utf8")).labels;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "as-talk-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 700, height: 420 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
  });
  const debug = [];
  try {
    await context.addInitScript((m) => {
      localStorage.setItem("adaptiveSpeedDebug", "1");
      if (m === "rules" || m === "capture-only") localStorage.setItem("adaptiveSpeedVad", m);
      else localStorage.removeItem("adaptiveSpeedVad");
    }, mode);
    const page = await context.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      if (t.includes("[AdaptiveSpeed]")) debug.push(t);
    });
    await page.goto(`http://localhost:${port}/player.html?src=/eval/results/talks/${slug}.wav`);
    await page.waitForTimeout(1500); // content script attaches
    await page.evaluate(() => document.getElementById("v").play());

    const cpu0 = cpuByType(profile);
    const samples = [];
    const start = Date.now();
    while (Date.now() - start < maxSeconds * 1000) {
      const s = await page.evaluate(() => { const v = document.getElementById("v"); return { t: v.currentTime, rate: v.playbackRate, ended: v.ended, seeking: v.seeking }; });
      samples.push({ ...s, wall: Date.now() - start });
      if (s.ended) break;
      await page.waitForTimeout(100);
    }

    const seeks = await page.evaluate(() => window.__seeks);
    const jumps = await page.evaluate(() => window.__jumps);
    const cpu1 = cpuByType(profile);
    const elapsedMin = (Date.now() - start) / 60000;
    const cpuPct = {};
    for (const k of Object.keys(cpu1)) cpuPct[k] = +((100 * (cpu1[k] - (cpu0[k] || 0))) / (elapsedMin * 60)).toFixed(1);
    // Accumulate per 100 ms sample: content advanced, and at what rate.
    // A step is "played" when currentTime advanced no more than the playback
    // rate allows in the wall time between samples (plus slack for timer
    // jitter); anything beyond that is a jump, and speech inside a forward
    // jump was skipped, not heard.
    let speech = 0, speechFast = 0, speechSkipped = 0, content = 0, wall = 0, switches = 0;
    // Per 10 ms slice: heard at normal speed at least once / crossed fast.
    // A slice crossed fast and then replayed at normal speed counts as heard.
    const heardNormal = new Uint8Array(labels.length), heardFast = new Uint8Array(labels.length);
    const oddSteps = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const dw = (b.wall - a.wall) / 1000;
      const dc = Math.max(0, b.t - a.t);
      const maxPlayed = dw * Math.max(a.rate, b.rate) + 0.15;
      const jumped = dc > maxPlayed;
      if (jumped || b.t < a.t - 0.05) oddSteps.push({ wall: a.wall, from: +a.t.toFixed(3), to: +b.t.toFixed(3), dw: +dw.toFixed(3), rate: a.rate, seeking: b.seeking });
      content += dc;
      wall += dw;
      if (Math.abs(b.rate - a.rate) > 0.01) switches++;
      // label of each 10 ms slice crossed
      for (let t = a.t; t < b.t; t += 0.01) {
        const k = Math.floor(t * 100);
        if (!jumped) (a.rate > 1.01 ? heardFast : heardNormal)[k] = 1;
        if (!labels[k]) continue;
        speech += 0.01;
        if (jumped) speechSkipped += 0.01;
        else if (a.rate > 1.01) speechFast += 0.01;
      }
    }
    let speechTotal = 0, speechOnlyFast = 0;
    for (let k = 0; k < labels.length; k++) if (labels[k]) { speechTotal++; if (heardFast[k] && !heardNormal[k]) speechOnlyFast++; }
    const back = jumps.filter((j) => j.to < j.from).map((j) => j.from - j.to);
    const fwd = jumps.filter((j) => j.to > j.from + 0.001).map((j) => j.to - j.from);
    if (args.trace) fs.writeFileSync(path.join(ROOT, "eval", "results", `trace-${args.tag || "latest"}-${slug}-${mode}.json`), JSON.stringify({ samples, jumps }, null, 0));
    const parsed = debug.filter((d) => d.includes("[debug]")).map((d) => { try { return JSON.parse(d.slice(d.indexOf("{"))); } catch { return null; } }).filter(Boolean);
    const last = parsed[parsed.length - 1] || {};
    return {
      talk: slug, mode, contentSec: +content.toFixed(1), wallSec: +wall.toFixed(1),
      savedSec: +(content - wall).toFixed(1),
      speechFastPerMin: +((60 * speechFast) / Math.max(1, speech)).toFixed(2),
      speechOnlyFastPerMin: +((60 * speechOnlyFast) / Math.max(1, speechTotal)).toFixed(2),
      speechSkippedSec: +speechSkipped.toFixed(2),
      seekJumps: { back: back.length, backSec: +back.reduce((x, y) => x + y, 0).toFixed(2), maxBackSec: back.length ? +Math.max(...back).toFixed(2) : 0, fwd: fwd.length, fwdSec: +fwd.reduce((x, y) => x + y, 0).toFixed(2) },
      oddSteps: oddSteps.slice(0, 20),
      switchesPerMin: +((60 * switches) / Math.max(1, content)).toFixed(1),
      replaysPerMin: +((60 * seeks.length) / Math.max(1, content)).toFixed(1),
      seekStallMs: seeks.length ? { avg: Math.round(seeks.reduce((a, b) => a + b, 0) / seeks.length), max: Math.round(Math.max(...seeks)) } : null,
      cpuPct, vad: last.vad, model: last.model, mainThreadModelMs: last.mainThreadModelMs, audioThreadModelMs: last.audioThreadModelMs,
      warnings: debug.filter((d) => !d.includes("[debug]")).slice(0, 5),
    };
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

(async () => {
  const server = await serve();
  const port = server.address().port;
  const talks = (args.talks || "quiet-room,music-bed-applause,noisy-vlog,quiet-voice").split(",");
  const modes = (args.modes || "neural,rules").split(",");
  const seconds = +(args.seconds || 400);
  const results = [];
  for (const t of talks) for (const m of modes) {
    const r = await runTalk(port, t, m, seconds);
    results.push(r);
    console.log(JSON.stringify(r));
  }
  fs.writeFileSync(path.join(ROOT, "eval", "results", `browser-${args.tag || "latest"}.json`), JSON.stringify(results, null, 2));
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
