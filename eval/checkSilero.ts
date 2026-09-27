// Verifies the TypeScript Silero implementation against onnxruntime output
// (eval/models/silero_reference.json, from eval/export_silero.py) and times it.
// Run: npx esbuild eval/checkSilero.ts --bundle --platform=node | node
import { readFileSync } from "fs";
import { parseSileroWeights, SileroVadModel, QUANT_BITS } from "../src/audio/sileroVad";
if (process.env.CONV_BITS) QUANT_BITS.conv = +process.env.CONV_BITS;
if (process.env.LSTM_BITS) QUANT_BITS.lstm = +process.env.LSTM_BITS;
console.log(`weights: conv int${QUANT_BITS.conv}, lstm int${QUANT_BITS.lstm}`);

const root = process.cwd();
const bin = readFileSync(`${root}/src/models/silero_vad_16k.bin`);
const weights = parseSileroWeights(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const ref = JSON.parse(readFileSync(`${root}/eval/models/silero_reference.json`, "utf8")) as { signal: number[]; probs: number[] };

const model = new SileroVadModel(weights);
const signal = Float32Array.from(ref.signal);
let maxDiff = 0;
const ours: number[] = [];
for (let i = 0, k = 0; k < ref.probs.length; i += 512, k++) {
  const p = model.process(signal.subarray(i, i + 512));
  ours.push(p);
  maxDiff = Math.max(maxDiff, Math.abs(p - ref.probs[k]!));
}
console.log(`chunks ${ours.length}, max |ours - onnxruntime| = ${maxDiff.toExponential(2)}`);

const reps = 3000;
for (let r = 0; r < 500; r++) model.process(signal.subarray((r % 90) * 512, (r % 90) * 512 + 512)); // JIT warm-up
model.reset();
const t0 = performance.now();
for (let r = 0; r < reps; r++) model.process(signal.subarray((r % 90) * 512, (r % 90) * 512 + 512));
const per = (performance.now() - t0) / reps;
console.log(`time per 32 ms chunk: ${per.toFixed(3)} ms  -> ${(100 * per / 32).toFixed(2)}% of one core in real time`);
// int8 weights: allow small probability error, but decisions must agree.
let flips = 0;
for (let k = 0; k < ours.length; k++) if ((ours[k]! >= 0.5) !== (ref.probs[k]! >= 0.5)) flips++;
console.log(`decision flips at 0.5: ${flips} of ${ours.length}`);
process.exit(maxDiff < 0.03 && flips === 0 ? 0 : 1);
