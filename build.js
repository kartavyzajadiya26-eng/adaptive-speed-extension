// Bundles the extension's three entry points and copies static assets into
// dist/, which is the folder you point Chrome's "Load unpacked" at.
//
// Each entry is bundled separately (not code-split) because MV3 content
// scripts and service workers must each be a single self-contained file —
// Chrome does not fetch chunked/dynamic-imported bundles for them.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const isWatch = process.argv.includes("--watch");
const outdir = path.join(__dirname, "dist");

const entryPoints = {
  content: "src/content/content.ts",
  background: "src/background/background.ts",
  popup: "src/popup/popup.ts",
  // Loaded with audioWorklet.addModule(); runs on the audio thread.
  "capture-worklet": "src/audio/captureWorklet.ts",
};

const staticFiles = [
  ["manifest.json", "manifest.json"],
  ["src/popup/popup.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
  // Silero VAD weights (MIT, snakers4/silero-vad), exported by eval/export_silero.py.
  ["src/models/silero_vad_16k.bin", "models/silero_vad_16k.bin"],
  ["src/models/LICENSE-silero.txt", "models/LICENSE-silero.txt"],
];

function copyStaticFiles() {
  fs.mkdirSync(outdir, { recursive: true });
  for (const [from, to] of staticFiles) {
    fs.mkdirSync(path.dirname(path.join(outdir, to)), { recursive: true });
    fs.copyFileSync(path.join(__dirname, from), path.join(outdir, to));
  }

  const iconsSrc = path.join(__dirname, "src", "icons");
  const iconsOut = path.join(outdir, "icons");
  fs.mkdirSync(iconsOut, { recursive: true });
  if (fs.existsSync(iconsSrc)) {
    for (const file of fs.readdirSync(iconsSrc)) {
      fs.copyFileSync(path.join(iconsSrc, file), path.join(iconsOut, file));
    }
  }
  console.log("[build] copied manifest, popup, icons -> dist/");
}

async function build() {
  copyStaticFiles();

  const buildOptions = {
    entryPoints,
    bundle: true,
    outdir,
    format: "iife",
    target: ["chrome110"],
    sourcemap: true,
    logLevel: "info",
  };

  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("[build] watching for changes…");
  } else {
    await esbuild.build(buildOptions);
    console.log("[build] done -> dist/");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
