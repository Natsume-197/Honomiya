"""Average loudness around cue ends, relative to typical speech.

For cues followed by a pause of at least 1 s (so the next sentence does not
pollute the window), prints the mean level in dB (0 dB = median speech
level) from 300 ms before the cue end to 800 ms after it, and the share of
cues whose audio is still within 20 dB of speech level 50, 100 and 200 ms
after the end, which is audible speech being cut off.

python end-profile.py <audio> <manifest.json> [...]
"""

import json
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from importlib import import_module

frame_rms = import_module("end-clip").frame_rms


def main() -> None:
    audio, manifests = sys.argv[1], sys.argv[2:]
    rms = frame_rms(audio)
    floor = np.percentile(rms, 10)
    speech_level = np.median(rms[rms > floor * 100])
    db = 20 * np.log10(np.maximum(rms, 1e-7) / speech_level)
    print(json.dumps({"speechLevel": float(speech_level)}))
    offsets = list(range(-300, 801, 50))
    for path in manifests:
        cues = sorted(json.load(open(path, encoding="utf-8"))["cues"], key=lambda c: (c["audioFileIndex"], c["startMs"]))
        profiles = []
        for cue, following in zip(cues, cues[1:]):
            if following["audioFileIndex"] != cue["audioFileIndex"] or following["startMs"] - cue["endMs"] < 1000:
                continue
            end = cue["endMs"] // 10
            profiles.append([db[end + o // 10] for o in offsets])
        profiles = np.array(profiles)
        mean = profiles.mean(axis=0)
        audible = {f"+{o}ms": round(float((profiles[:, offsets.index(o)] > -20).mean()), 3) for o in (50, 100, 200)}
        print(json.dumps({
            "manifest": path.split("/")[-1],
            "cuesWithPause": len(profiles),
            "profileDb": {f"{o:+d}": round(float(v), 1) for o, v in zip(offsets, mean) if o % 100 == 0},
            "audibleAfterEnd": audible,
        }))


if __name__ == "__main__":
    main()
