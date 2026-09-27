"""Downloads the public audio clips used by the detection benchmark.

Sources (all free for research use):
  - LibriSpeech dev-clean sample (read speech), via Hugging Face datasets API
  - GTZAN music clips (10 genres), via Hugging Face datasets API
  - ESC-50 environmental sounds (laughter, applause, noise...), from GitHub

Files land in eval/data/ (git-ignored). Safe to re-run; skips existing files.
"""
import csv, io, json, os, sys, time, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
API = "https://datasets-server.huggingface.co/rows"


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def hf_rows(dataset, config, split, offset, length):
    q = f"{API}?dataset={dataset}&config={config}&split={split}&offset={offset}&length={length}"
    return json.loads(get(q))["rows"]


def fetch_librispeech():
    out = os.path.join(ROOT, "speech")
    rows = hf_rows("hf-internal-testing/librispeech_asr_dummy", "clean", "validation", 0, 100)
    for r in rows:
        row = r["row"]
        path = os.path.join(out, f"{row['id']}.flac")
        if not os.path.exists(path):
            save(path, get(row["audio"][0]["src"]))
    print(f"speech: {len(rows)} utterances")


def fetch_gtzan(per_genre=2):
    out = os.path.join(ROOT, "music")
    genres = ["blues", "classical", "country", "disco", "hiphop", "jazz", "metal", "pop", "reggae", "rock"]
    # GTZAN rows are ordered by genre, 100 clips each.
    n = 0
    for gi, g in enumerate(genres):
        rows = hf_rows("sanchit-gandhi/gtzan", "default", "train", gi * 100 + 5, per_genre)
        for k, r in enumerate(rows):
            path = os.path.join(out, f"{g}_{k}.wav")
            if not os.path.exists(path):
                save(path, get(r["row"]["audio"][0]["src"]))
            n += 1
    print(f"music: {n} clips")


ESC_CATEGORIES = {
    # human non-speech sounds (hardest negatives)
    "laughing": 4, "clapping": 4, "crying_baby": 3, "coughing": 3, "sneezing": 2, "breathing": 3,
    # everyday noises
    "footsteps": 2, "keyboard_typing": 3, "mouse_click": 2, "door_wood_knock": 2,
    # steady backgrounds
    "vacuum_cleaner": 2, "washing_machine": 2, "rain": 2, "wind": 2, "engine": 2, "airplane": 2,
    # tonal / alarm-like
    "church_bells": 2, "siren": 2, "clock_alarm": 2, "car_horn": 2,
    # animals
    "dog": 2, "rooster": 2, "chirping_birds": 2,
}


def fetch_esc50():
    out = os.path.join(ROOT, "env")
    base = "https://raw.githubusercontent.com/karolpiczak/ESC-50/master"
    meta = list(csv.DictReader(io.StringIO(get(f"{base}/meta/esc50.csv").decode())))
    n = 0
    for cat, count in ESC_CATEGORIES.items():
        files = [m["filename"] for m in meta if m["category"] == cat][:count]
        for i, fn in enumerate(files):
            path = os.path.join(out, f"{cat}_{i}.wav")
            if not os.path.exists(path):
                save(path, get(f"{base}/audio/{fn}"))
            n += 1
    print(f"env: {n} clips")


def convert_all():
    """Converts every clip to 48 kHz mono 16-bit WAV (what the benchmark reads).
    Uses macOS's built-in afconvert; on other systems use ffmpeg instead:
    ffmpeg -i in -ac 1 -ar 48000 -sample_fmt s16 out.wav"""
    import subprocess
    n = 0
    for sub in ("speech", "music", "env"):
        src_dir = os.path.join(ROOT, sub)
        dst_dir = os.path.join(ROOT, "wav48", sub)
        os.makedirs(dst_dir, exist_ok=True)
        for fn in sorted(os.listdir(src_dir)):
            dst = os.path.join(dst_dir, os.path.splitext(fn)[0] + ".wav")
            if not os.path.exists(dst):
                subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@48000", "-c", "1",
                                os.path.join(src_dir, fn), dst], check=True)
            n += 1
    print(f"converted: {n} clips -> {os.path.join(ROOT, 'wav48')}")


if __name__ == "__main__":
    fetch_librispeech()
    fetch_gtzan()
    fetch_esc50()
    convert_all()
    print("done ->", ROOT)
