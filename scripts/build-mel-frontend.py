"""Build Honomiya's standalone NeMo-compatible mel frontend as ONNX.

    python scripts/build-mel-frontend.py out/frontend.onnx [--check model.nemo ...]

Input `signal` [batch, 1, samples] of 16 kHz mono audio; output `features`
[batch, 64, frames]: pre-emphasis 0.97, centred 512-point STFT of a 320-sample
Hann window every 160 samples, power, Slaney mel filterbank (0–8 kHz), log
with a 2^-24 guard, and per-feature normalization over the window. That is
the AudioToMelSpectrogramPreprocessor setup of NeMo 64-mel CTC models, so
acoustic models exported without their frontend can run on raw audio.

The filterbank and window are computed here from their definitions, not
copied from any checkpoint. --check compares them with the buffers stored in
NeMo checkpoints.
"""

import argparse
import io
import pathlib
import sys
import tarfile

import numpy as np
import torch

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from importlib import import_module  # noqa: E402

converter = import_module("convert-nemo-quartznet")

SAMPLE_RATE = 16_000
N_FFT = 512
WINDOW = 320
HOP = 160
MELS = 64


def hz_to_mel(hz: np.ndarray) -> np.ndarray:
    """Slaney mel scale: linear below 1 kHz, logarithmic above."""
    hz = np.asarray(hz, dtype=np.float64)
    f_sp = 200.0 / 3
    mels = hz / f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    return np.where(hz >= min_log_hz, min_log_mel + np.log(np.maximum(hz, 1e-12) / min_log_hz) / logstep, mels)


def mel_to_hz(mels: np.ndarray) -> np.ndarray:
    mels = np.asarray(mels, dtype=np.float64)
    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    return np.where(mels >= min_log_mel, min_log_hz * np.exp(logstep * (mels - min_log_mel)), f_sp * mels)


def slaney_filterbank(sr=SAMPLE_RATE, n_fft=N_FFT, n_mels=MELS, fmin=0.0, fmax=None) -> np.ndarray:
    fmax = fmax or sr / 2
    fft_freqs = np.linspace(0, sr / 2, n_fft // 2 + 1)
    mel_points = mel_to_hz(np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2))
    widths = np.diff(mel_points)
    ramps = mel_points[:, None] - fft_freqs[None, :]
    weights = np.zeros((n_mels, len(fft_freqs)))
    for i in range(n_mels):
        lower = -ramps[i] / widths[i]
        upper = ramps[i + 2] / widths[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    enorm = 2.0 / (mel_points[2 : n_mels + 2] - mel_points[:n_mels])
    return (weights * enorm[:, None]).astype(np.float32)


class Frontend(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.frontend = converter.MelFrontend(
            torch.from_numpy(slaney_filterbank()), torch.hann_window(WINDOW, periodic=False), N_FFT, HOP
        )

    def forward(self, signal):
        return self.frontend(signal)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=pathlib.Path)
    parser.add_argument("--check", type=pathlib.Path, nargs="*", default=[])
    args = parser.parse_args()

    fb = slaney_filterbank()
    window = torch.hann_window(WINDOW, periodic=False).numpy()
    for path in args.check:
        with tarfile.open(path) as archive:
            member = next(m for m in archive.getmembers() if m.name.endswith("model_weights.ckpt"))
            weights = torch.load(io.BytesIO(archive.extractfile(member).read()), map_location="cpu", weights_only=True)
        stored_fb = weights["preprocessor.featurizer.fb"].squeeze(0).numpy()
        stored_window = weights["preprocessor.featurizer.window"].numpy()
        print(f"{path.name}: filterbank max abs diff {np.abs(stored_fb - fb).max():.3e}, "
              f"window max abs diff {np.abs(stored_window - window).max():.3e}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    model = Frontend().eval()
    torch.onnx.export(model, torch.zeros(1, 1, SAMPLE_RATE * 4), str(args.out), input_names=["signal"],
                      output_names=["features"], dynamic_axes={"signal": {0: "batch", 2: "samples"},
                                                               "features": {0: "batch", 2: "frames"}},
                      opset_version=17, dynamo=False)
    print(f"wrote {args.out} ({args.out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
