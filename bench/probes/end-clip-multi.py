"""Share of cues still audible right after their end, for multi-track books.

A cue counts when the next cue of the same file starts at least 300 ms after
its end; it is "cut off" when the audio 50 or 100 ms after the end is still
within 20 dB of the file's median speech level.

python end-clip-multi.py <manifest.json> <audio-dir>
"""

import json
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from importlib import import_module  # noqa: E402

frame_rms = import_module("end-clip").frame_rms


def main() -> None:
    manifest = json.load(open(sys.argv[1], encoding="utf-8"))
    audio_dir = pathlib.Path(sys.argv[2])
    judged = audible = 0
    for audio in manifest["sources"]["audioFiles"]:
        rms = frame_rms(str(audio_dir / audio["filename"]))
        floor = np.percentile(rms, 10)
        level = np.median(rms[rms > max(floor * 100, 1e-4)])
        db = 20 * np.log10(np.maximum(rms, 1e-7) / level)
        cues = sorted((c for c in manifest["cues"] if c["audioFileIndex"] == audio["index"]), key=lambda c: c["startMs"])
        for cue, following in zip(cues, cues[1:]):
            if following["startMs"] - cue["endMs"] < 300:
                continue
            frame = cue["endMs"] // 10
            if frame + 10 >= len(db):
                continue
            judged += 1
            audible += bool(db[frame + 5] > -20 or db[frame + 10] > -20)
    print(json.dumps({"manifest": pathlib.Path(sys.argv[1]).name, "cuesFollowedByPause": judged,
                      "stillAudibleAfterEnd": round(audible / max(1, judged), 3)}))


if __name__ == "__main__":
    main()
