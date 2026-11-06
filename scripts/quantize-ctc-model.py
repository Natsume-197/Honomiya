"""Quantize a Honomiya CTC model (QuartzNet-style ONNX with a `signal` input)
to int8, keeping the mel frontend and the final classifier in fp32.

Phase 6 measured this recipe on an RK3588 (Cortex-A76): about twice as fast
as fp32 with the same alignment accuracy (docs/phase-6-performance.md).

Calibration uses real narration: pass audiobook files (any format ffmpeg
reads). The first minutes of each are enough.

    python -m venv .venv-quantize
    .venv-quantize/bin/pip install onnxruntime==1.23.2 onnx numpy
    .venv-quantize/bin/python scripts/quantize-ctc-model.py \\
        ~/.cache/honomiya/models/quartznet15x5-ja/<revision>/model.onnx \\
        model.int8.onnx book1.m4b book2.m4b
    bun run honomiya models import quartznet15x5-ja --int8 model.int8.onnx
"""

import subprocess
import sys

import numpy as np
import onnx
from onnxruntime.quantization import (
    CalibrationDataReader,
    QuantFormat,
    QuantType,
    quantize_static,
)

SAMPLE_RATE = 16_000
WINDOW = 38 * SAMPLE_RATE
WINDOWS_PER_FILE = 16


def decode(path: str, seconds: int) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-ss", "60", "-t", str(seconds), "-i", path,
         "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


class Narration(CalibrationDataReader):
    def __init__(self, paths: list[str]):
        windows = []
        for path in paths:
            audio = decode(path, WINDOWS_PER_FILE * 38)
            windows += [audio[i * WINDOW:(i + 1) * WINDOW] for i in range(len(audio) // WINDOW)]
        if not windows:
            raise SystemExit("No calibration audio could be decoded")
        self.items = iter({"signal": w.reshape(1, 1, WINDOW)} for w in windows)

    def get_next(self):
        return next(self.items, None)


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    source, target, *audio = sys.argv[1:]
    graph = onnx.load(source).graph
    log_at = next(i for i, node in enumerate(graph.node) if node.op_type == "Log")
    frontend = [n.name for n in graph.node[:log_at] if n.op_type == "Conv"]
    convs = [n.name for n in graph.node if n.op_type == "Conv"]
    quantize_static(
        source, target, Narration(audio),
        quant_format=QuantFormat.QDQ,
        op_types_to_quantize=["Conv"],
        nodes_to_exclude=frontend + [convs[-1]],
        per_channel=True,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
    )
    print(f"Wrote {target}; kept {len(frontend)} frontend conv(s) and the classifier in fp32")


if __name__ == "__main__":
    main()
