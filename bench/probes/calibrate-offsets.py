"""Estimate a CTC model's timing correction without a reference alignment.

Speech onsets (silence → speech) and offsets (speech → silence) are found in
the audio's loudness. Each cue start is matched to the latest onset at most
500 ms after it and at most 3 s before it, and each cue end to the nearest
offset within 1.5 s. The medians of (onset − start) and (offset − end) are
what the model's timing correction should add.

Run it on an alignment made with the correction set to zero to calibrate a
new model, or on a corrected one to check the residual (it should be near 0).
Cue ends that already include end padding will show the padding as a
negative end residual.

python calibrate-offsets.py <manifest.json> <audio-dir>
Audio files are found in <audio-dir> by the filenames the manifest lists.
"""

import json
import pathlib
import statistics
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from importlib import import_module  # noqa: E402

frame_rms = import_module("end-clip").frame_rms

SILENCE_DB = -35  # relative to median speech level
SPEECH_DB = -20
MIN_SILENCE_FRAMES = 30  # 300 ms of 10 ms frames
MIN_SPEECH_FRAMES = 15


def transitions(db: np.ndarray):
    """10 ms frame indices of speech onsets and offsets around real pauses."""
    silent = db < SILENCE_DB
    loud = db > SPEECH_DB
    onsets, offsets = [], []
    run = 0
    for i in range(len(db)):
        if silent[i]:
            run += 1
            continue
        if run >= MIN_SILENCE_FRAMES and loud[i : i + MIN_SPEECH_FRAMES].mean() > 0.5:
            onsets.append(i)
            # The offset before this pause: last non-silent frame before it.
            j = i - run - 1
            if j >= 0:
                offsets.append(j + 1)
        run = 0
    return np.array(onsets), np.array(offsets)


def main() -> None:
    manifest = json.load(open(sys.argv[1], encoding="utf-8"))
    audio_dir = pathlib.Path(sys.argv[2])
    start_diffs, end_diffs = [], []
    for audio in manifest["sources"]["audioFiles"]:
        rms = frame_rms(str(audio_dir / audio["filename"]))
        floor = np.percentile(rms, 10)
        level = np.median(rms[rms > max(floor * 100, 1e-4)])
        db = 20 * np.log10(np.maximum(rms, 1e-7) / level)
        onsets, offsets = transitions(db)
        if len(onsets) == 0:
            continue
        onset_ms, offset_ms = onsets * 10, offsets * 10
        for cue in (c for c in manifest["cues"] if c["audioFileIndex"] == audio["index"]):
            candidates = onset_ms[(onset_ms <= cue["startMs"] + 500) & (onset_ms >= cue["startMs"] - 3000)]
            if len(candidates):
                start_diffs.append(int(candidates.max()) - cue["startMs"])
            near = offset_ms[np.abs(offset_ms - cue["endMs"]) <= 1500]
            if len(near):
                end_diffs.append(int(near[np.argmin(np.abs(near - cue["endMs"]))]) - cue["endMs"])
    summary = lambda xs: {"n": len(xs), "median": round(statistics.median(xs)) if xs else None,
                          "p25": round(float(np.percentile(xs, 25))) if xs else None,
                          "p75": round(float(np.percentile(xs, 75))) if xs else None}
    print(json.dumps({"manifest": pathlib.Path(sys.argv[1]).name,
                      "startCorrectionMs": summary(start_diffs), "endCorrectionMs": summary(end_diffs)}))


if __name__ == "__main__":
    main()
