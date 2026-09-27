"""Exports the 16 kHz branch of Silero VAD v5 into a compact weight file the
extension can load without an ONNX runtime, plus reference outputs used to
check the TypeScript implementation matches onnxruntime exactly.

Requires: pip install onnx onnxruntime numpy
Usage:    python eval/export_silero.py
"""
import json, os, struct
import numpy as np
import onnx
from onnx import numpy_helper

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "silero_vad.onnx")
OUT_BIN = os.path.join(HERE, "..", "src", "models", "silero_vad_16k.bin")
OUT_REF = os.path.join(HERE, "models", "silero_reference.json")

PREFIX = "If_0_then_branch__Inline_0__"
# The STFT basis is a periodic-Hann DFT, recomputed in TypeScript, so it's not exported.
WANTED = [
    "encoder.0.reparam_conv.weight", "encoder.0.reparam_conv.bias",
    "encoder.1.reparam_conv.weight", "encoder.1.reparam_conv.bias",
    "encoder.2.reparam_conv.weight", "encoder.2.reparam_conv.bias",
    "encoder.3.reparam_conv.weight", "encoder.3.reparam_conv.bias",
    "decoder.rnn.weight_ih", "decoder.rnn.weight_hh",
    "decoder.rnn.bias_ih", "decoder.rnn.bias_hh",
    "decoder.decoder.2.weight", "decoder.decoder.2.bias",
]


MODEL_URL = "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"


def main():
    if not os.path.exists(MODEL):
        import urllib.request
        os.makedirs(os.path.dirname(MODEL), exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, MODEL)
    m = onnx.load(MODEL)
    if_node = m.graph.node[2]
    then_g = [a.g for a in if_node.attribute if a.name == "then_branch"][0]
    consts = {}
    for n in then_g.node:
        if n.op_type == "Constant" and n.output[0].startswith(PREFIX):
            consts[n.output[0][len(PREFIX):]] = numpy_helper.to_array(n.attribute[0].t)

    # Binary layout: "SVAD" | u32 manifest length | manifest JSON | pad to 4 | float32 data
    tensors, blobs, offset = [], [], 0
    for name in WANTED:
        arr = np.ascontiguousarray(consts[name].astype(np.float32))
        tensors.append({"name": name, "shape": list(arr.shape), "offset": offset})
        blobs.append(arr.tobytes())
        offset += arr.size
    manifest = json.dumps({"version": "silero_vad_v5_16k", "tensors": tensors}).encode()
    pad = (-(8 + len(manifest))) % 4
    with open(OUT_BIN, "wb") as f:
        f.write(b"SVAD")
        f.write(struct.pack("<I", len(manifest) + pad))
        f.write(manifest + b" " * pad)
        for b in blobs:
            f.write(b)
    print("wrote", OUT_BIN, os.path.getsize(OUT_BIN), "bytes,", offset, "floats")

    # Reference: run onnxruntime over a deterministic signal made of noise,
    # a tone and a synthetic vowel-like buzz, carrying state/context the same
    # way the extension does (64-sample context + 512 new samples per call).
    import onnxruntime as ort
    sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(1)
    sr = 16000
    t = np.arange(sr * 3) / sr
    sig = 0.02 * rng.standard_normal(t.size)
    sig[sr:2 * sr] += 0.3 * np.sin(2 * np.pi * 440 * t[sr:2 * sr])
    buzz = np.sign(np.sin(2 * np.pi * 120 * t)) * 0.2 * (1 + np.sin(2 * np.pi * 3 * t))
    sig[2 * sr:] += np.convolve(buzz, np.hanning(40) / 20, mode="same")[2 * sr:]
    sig = sig.astype(np.float32)
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros(64, dtype=np.float32)
    probs = []
    for i in range(0, sig.size - 511, 512):
        chunk = sig[i:i + 512]
        x = np.concatenate([context, chunk])[None, :]
        out, state = sess.run(None, {"input": x, "state": state, "sr": np.array(sr, dtype=np.int64)})
        probs.append(float(out[0, 0]))
        context = chunk[-64:]
    with open(OUT_REF, "w") as f:
        json.dump({"signal": sig.tolist(), "probs": probs}, f)
    print("reference chunks:", len(probs), "min/max prob", min(probs), max(probs))


if __name__ == "__main__":
    main()
