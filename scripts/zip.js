// Zips dist/ into adaptive-speed-extension.zip at the project root — the
// file you can drag into chrome://extensions or submit to the Web Store.
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const out = path.join(root, "adaptive-speed-extension.zip");

if (!fs.existsSync(dist)) {
  console.error("[zip] dist/ not found — run `npm run build` first.");
  process.exit(1);
}

if (fs.existsSync(out)) fs.rmSync(out);

execFileSync("zip", ["-r", out, "."], { cwd: dist, stdio: "inherit" });
console.log(`[zip] wrote ${path.relative(root, out)}`);
