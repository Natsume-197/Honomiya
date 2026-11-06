"""Independent judge for disputed sentence timings.

For each disputed sentence, transcribes the audio at engine A's span and at
engine B's span with a third model (faster-whisper, default "small") and
scores how much of the sentence each transcript contains. The span whose
audio actually says the sentence wins.

python judge.py <audio> <disputes.json> [model]
"""

import difflib
import json
import subprocess
import sys
import unicodedata

import numpy as np
from faster_whisper import WhisperModel

SR = 16_000


def clip(path: str, start_ms: int, end_ms: int) -> np.ndarray:
    start = max(0, start_ms - 300) / 1000
    duration = min(20.0, (end_ms - start_ms + 600) / 1000)
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
         "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    return "".join(c for c in text if c.isalnum())


def coverage(sentence: str, heard: str) -> float:
    """Share of the sentence's characters found, in order, in the transcript."""
    s, h = normalize(sentence), normalize(heard)
    if not s:
        return 0.0
    blocks = difflib.SequenceMatcher(None, s, h, autojunk=False).get_matching_blocks()
    return sum(block.size for block in blocks) / len(s)


def main() -> None:
    audio, disputes_path = sys.argv[1], sys.argv[2]
    model = WhisperModel(sys.argv[3] if len(sys.argv) > 3 else "small", device="cpu", compute_type="int8")
    disputes = json.load(open(disputes_path, encoding="utf-8"))
    wins = {"a": 0, "b": 0, "tie": 0}
    rows = []
    for item in disputes:
        scores = {}
        for side in ("a", "b"):
            span = item[side]
            segments, _ = model.transcribe(clip(audio, span["startMs"], span["endMs"]), language="ja", beam_size=1, vad_filter=False)
            heard = "".join(segment.text for segment in segments)
            scores[side] = (coverage(item["text"], heard), heard)
        a, b = scores["a"][0], scores["b"][0]
        winner = "tie" if abs(a - b) < 0.15 else ("a" if a > b else "b")
        wins[winner] += 1
        rows.append({"id": item["id"], "a": round(a, 2), "b": round(b, 2), "winner": winner,
                     "text": item["text"][:30], "heardA": scores["a"][1][:30], "heardB": scores["b"][1][:30]})
        print(json.dumps(rows[-1], ensure_ascii=False), flush=True)
    print(json.dumps({"judged": len(disputes), **wins}))


if __name__ == "__main__":
    main()
