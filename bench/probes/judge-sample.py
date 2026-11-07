"""Reference-free check of a word-level (read-listen.v2) alignment.

Samples sentences spread over the book. For each, an independent model
(faster-whisper, default "small") transcribes the audio inside the cue and
inside the same span shifted 2.5 s earlier and later. A correct alignment
makes the sentence's own span contain far more of its text than the shifted
spans. Also reports how many sampled cues are still audible right after
their end (a cut-off last syllable).

python judge-sample.py <manifest.v2.json> <audio-dir> <language> [count] [model]
Audio files are looked up in <audio-dir> by the manifest's filenames.
"""

import json
import pathlib
import statistics
import sys

import numpy as np
from faster_whisper import WhisperModel

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from importlib import import_module  # noqa: E402

judge = import_module("judge")


def main() -> None:
    manifest = json.load(open(sys.argv[1], encoding="utf-8"))
    audio_dir = pathlib.Path(sys.argv[2])
    language = sys.argv[3]
    count = int(sys.argv[4]) if len(sys.argv) > 4 else 60
    model = WhisperModel(sys.argv[5] if len(sys.argv) > 5 else "small", device="cpu", compute_type="int8")
    files = {a["index"]: str(audio_dir / a["filename"]) for a in manifest["sources"]["audioFiles"]}
    cues = [c for c in manifest["cues"] if len(c.get("words", [])) >= 6]
    step = max(1, len(cues) // count)
    sample = cues[::step][:count]

    def heard(cue, shift):
        clip = judge.clip(files[cue["audioFileIndex"]], max(0, cue["startMs"] + shift), cue["endMs"] + shift)
        segments, _ = model.transcribe(clip, language=language, beam_size=1, vad_filter=False)
        return "".join(segment.text for segment in segments)

    own, shifted, rows = [], [], []
    for cue in sample:
        text = "".join(word["text"] for word in cue["words"])
        here = judge.coverage(text, heard(cue, 0))
        away = max(judge.coverage(text, heard(cue, -2500)), judge.coverage(text, heard(cue, 2500)))
        own.append(here)
        shifted.append(away)
        rows.append({"id": cue["id"], "own": round(here, 2), "shifted": round(away, 2), "text": text[:40]})
        print(json.dumps(rows[-1], ensure_ascii=False), flush=True)
    print(json.dumps({
        "sampled": len(sample),
        "meanCoverageOwnSpan": round(statistics.mean(own), 3),
        "meanCoverageShifted": round(statistics.mean(shifted), 3),
        "ownSpanWins": sum(1 for a, b in zip(own, shifted) if a > b + 0.15),
        "shiftedWins": sum(1 for a, b in zip(own, shifted) if b > a + 0.15),
        "ownCoverageAtLeast70": round(float(np.mean([c >= 0.7 for c in own])), 3),
    }))


if __name__ == "__main__":
    main()
