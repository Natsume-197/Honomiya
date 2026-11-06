"""Does a cue cut off the end of its sentence?

For every cue, looks at the audio right after the cue ends. If there is still
speech there, and the next cue has not started yet, the cue was cut short
and a reader that stops at the cue's end would clip the last word.

python end-clip.py <audio> <manifest.json> [<manifest.json> ...]
"""

import json
import subprocess
import sys

import numpy as np

SR = 16_000
HOP = 160  # 10 ms
WINDOW_MS = 150


def frame_rms(path: str) -> np.ndarray:
    process = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        stdout=subprocess.PIPE,
    )
    values = []
    remainder = np.zeros(0, dtype=np.float32)
    while True:
        chunk = process.stdout.read(SR * 2 * 60)
        if not chunk:
            break
        samples = np.concatenate([remainder, np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768])
        usable = len(samples) // HOP * HOP
        frames = samples[:usable].reshape(-1, HOP)
        values.append(np.sqrt((frames ** 2).mean(axis=1)))
        remainder = samples[usable:]
    process.wait()
    return np.concatenate(values)


def main() -> None:
    audio, manifests = sys.argv[1], sys.argv[2:]
    rms = frame_rms(audio)
    floor = np.percentile(rms, 10)
    speech = floor * 10 ** (12 / 20)  # 12 dB above the noise floor
    print(json.dumps({"frames": len(rms), "noiseFloor": round(float(floor), 5), "speechThreshold": round(float(speech), 5)}))

    def energy(start_ms: float, end_ms: float) -> float:
        a, b = int(start_ms // 10), int(end_ms // 10)
        return float(rms[a:b].mean()) if b > a else 0.0

    for path in manifests:
        cues = json.load(open(path, encoding="utf-8"))["cues"]
        cues = sorted(cues, key=lambda cue: (cue["audioFileIndex"], cue["startMs"]))
        judged = clipped = 0
        clipped_extended = 0
        gaps = []
        for cue, following in zip(cues, cues[1:] + [None]):
            next_start = following["startMs"] if following and following["audioFileIndex"] == cue["audioFileIndex"] else None
            gap = (next_start - cue["endMs"]) if next_start is not None else None
            if gap is not None:
                gaps.append(gap)
            # Only cues followed by a pause can be judged: otherwise the
            # audio after the end is simply the next sentence.
            if gap is None or gap < WINDOW_MS + 50:
                continue
            judged += 1
            if energy(cue["endMs"], cue["endMs"] + WINDOW_MS) > speech:
                clipped += 1
                # The fix under test: end each cue where the next one starts.
                if energy(next_start - WINDOW_MS, next_start) > speech and False:
                    clipped_extended += 1
        gaps.sort()
        print(json.dumps({
            "manifest": path.split("/")[-1],
            "cues": len(cues),
            "cuesFollowedByPause": judged,
            "speechRightAfterEnd": clipped,
            "clippedShare": round(clipped / max(1, judged), 3),
            "gapMsP50": gaps[len(gaps) // 2] if gaps else None,
        }))


if __name__ == "__main__":
    main()
