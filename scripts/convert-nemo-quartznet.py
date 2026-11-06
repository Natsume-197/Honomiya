"""Convert a NeMo QuartzNet (Jasper-style, character CTC) checkpoint to the
ONNX layout Honomiya runs: raw 16 kHz mono audio in (`signal`, shaped
[batch, 1, samples]), log probabilities out (`logprobs`, shaped
[batch, frames, classes]), with the mel frontend inside the graph.

    python -m venv .venv-convert
    .venv-convert/bin/pip install torch onnx onnxruntime pyyaml numpy
    .venv-convert/bin/python scripts/convert-nemo-quartznet.py model.nemo out/

Writes out/model.onnx, out/vocab.txt (`<token> <index>` per line, blank
last) and out/config.json. With --reference-onnx and --audio (raw float32
16 kHz mono), it also compares the new model with a reference export.

The network is rebuilt from the checkpoint's configuration and weights; NeMo
itself is not needed. Inference only: padding masks and `pad_to` are not
reproduced, which matches NeMo inside a window and differs only in the last
few frames at its edge (Honomiya discards window edges anyway).
"""

import argparse
import hashlib
import io
import json
import math
import pathlib
import tarfile

import numpy as np
import torch
import yaml
from torch import nn

SAMPLE_RATE = 16_000
BATCH_NORM_EPS = 1e-3  # NeMo JasperBlock default
LOG_ZERO_GUARD = 2.0 ** -24
NORMALIZE_EPS = 1e-5
PREEMPHASIS = 0.97


def read_nemo(path: pathlib.Path):
    with tarfile.open(path) as archive:
        members = {pathlib.PurePosixPath(m.name).name: m for m in archive.getmembers() if m.isfile()}
        config = yaml.safe_load(archive.extractfile(members["model_config.yaml"]).read())
        weights = torch.load(io.BytesIO(archive.extractfile(members["model_weights.ckpt"]).read()),
                             map_location="cpu", weights_only=True)
    return config, weights


class MelFrontend(nn.Module):
    """Pre-emphasis, centred STFT (as a convolution), power, mel, log and
    per-feature normalization over the window."""

    def __init__(self, filterbank: torch.Tensor, window: torch.Tensor, n_fft: int, hop: int):
        super().__init__()
        self.n_fft, self.hop = n_fft, hop
        padded = torch.zeros(n_fft)
        start = (n_fft - window.numel()) // 2
        padded[start:start + window.numel()] = window
        bins = n_fft // 2 + 1
        n = torch.arange(n_fft, dtype=torch.float64)
        k = torch.arange(bins, dtype=torch.float64).unsqueeze(1)
        angle = 2 * math.pi * k * n / n_fft
        real = (torch.cos(angle) * padded).float()
        imag = (-torch.sin(angle) * padded).float()
        self.register_buffer("basis", torch.cat([real, imag]).unsqueeze(1))  # [2*bins, 1, n_fft]
        self.register_buffer("filterbank", filterbank.float())  # [mels, bins]
        self.bins = bins

    def forward(self, signal: torch.Tensor) -> torch.Tensor:  # [B, 1, N]
        emphasized = torch.cat([signal[:, :, :1], signal[:, :, 1:] - PREEMPHASIS * signal[:, :, :-1]], dim=2)
        padded = nn.functional.pad(emphasized, (self.n_fft // 2, self.n_fft // 2))
        spectrum = nn.functional.conv1d(padded, self.basis, stride=self.hop)  # [B, 2*bins, T]
        real, imag = spectrum[:, : self.bins], spectrum[:, self.bins:]
        power = real * real + imag * imag
        mel = torch.matmul(self.filterbank, power)  # [B, mels, T]
        logmel = torch.log(mel + LOG_ZERO_GUARD)
        mean = logmel.mean(dim=2, keepdim=True)
        frames = logmel.shape[2]
        std = torch.sqrt(((logmel - mean) ** 2).sum(dim=2, keepdim=True) / (frames - 1)) + NORMALIZE_EPS
        return (logmel - mean) / std


def batch_norm(weights, prefix: str, channels: int) -> nn.BatchNorm1d:
    norm = nn.BatchNorm1d(channels, eps=BATCH_NORM_EPS)
    norm.weight.data = weights[f"{prefix}.weight"]
    norm.bias.data = weights[f"{prefix}.bias"]
    norm.running_mean.data = weights[f"{prefix}.running_mean"]
    norm.running_var.data = weights[f"{prefix}.running_var"]
    return norm


def conv(weight: torch.Tensor, stride: int, dilation: int, groups: int, bias=None) -> nn.Conv1d:
    out_channels, in_per_group, kernel = weight.shape
    layer = nn.Conv1d(in_per_group * groups, out_channels, kernel, stride=stride,
                      padding=dilation * (kernel - 1) // 2, dilation=dilation, groups=groups, bias=bias is not None)
    layer.weight.data = weight
    if bias is not None:
        layer.bias.data = bias
    return layer


class Block(nn.Module):
    def __init__(self, weights, index: int, spec: dict):
        super().__init__()
        prefix = f"encoder.encoder.{index}"
        stride, dilation = spec["stride"][0], spec["dilation"][0]
        # mconv is a flat list: per repeat [depthwise?, pointwise conv, BN, (ReLU, Dropout)].
        entries = sorted({int(k.split(".")[4]) for k in weights if k.startswith(f"{prefix}.mconv.")})
        layers, current = [], []
        for entry in entries:
            key = f"{prefix}.mconv.{entry}"
            if f"{key}.running_mean" in weights:
                current.append(batch_norm(weights, key, weights[f"{key}.weight"].shape[0]))
                layers.append(nn.Sequential(*current))
                current = []
                continue
            weight = weights[f"{key}.conv.weight"]
            depthwise = weight.shape[1] == 1 and weight.shape[2] > 1
            groups = weight.shape[0] if depthwise else 1
            current.append(conv(weight, stride if depthwise or weight.shape[2] > 1 else 1, dilation if weight.shape[2] > 1 else 1, groups))
        self.repeats = nn.ModuleList(layers)
        self.residual = None
        if spec.get("residual"):
            res = f"{prefix}.res.0"
            self.residual = nn.Sequential(conv(weights[f"{res}.0.conv.weight"], 1, 1, 1),
                                          batch_norm(weights, f"{res}.1", weights[f"{res}.1.weight"].shape[0]))

    def forward(self, x):
        out = x
        for position, layer in enumerate(self.repeats):
            out = layer(out)
            if position < len(self.repeats) - 1:
                out = torch.relu(out)
        if self.residual is not None:
            out = out + self.residual(x)
        return torch.relu(out)


class QuartzNet(nn.Module):
    def __init__(self, config, weights):
        super().__init__()
        pre = config["preprocessor"]
        if pre.get("normalize") != "per_feature" or pre.get("features") != 64:
            raise SystemExit(f"Unsupported preprocessor: {pre}")
        hop = round(pre["window_stride"] * SAMPLE_RATE)
        filterbank = weights["preprocessor.featurizer.fb"].squeeze(0)
        window = weights.get("preprocessor.featurizer.window")
        if window is None:
            window = torch.hann_window(round(pre["window_size"] * SAMPLE_RATE), periodic=False)
        self.frontend = MelFrontend(filterbank, window, pre["n_fft"], hop)
        self.blocks = nn.Sequential(*[Block(weights, i, spec) for i, spec in enumerate(config["encoder"]["jasper"])])
        self.decoder = conv(weights["decoder.decoder_layers.0.weight"], 1, 1, 1, weights["decoder.decoder_layers.0.bias"])
        self.hop = hop
        self.stride = math.prod(spec["stride"][0] for spec in config["encoder"]["jasper"])

    def forward(self, signal):
        logits = self.decoder(self.blocks(self.frontend(signal)))  # [B, C, T]
        return torch.log_softmax(logits.transpose(1, 2), dim=2)


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("nemo", type=pathlib.Path)
    parser.add_argument("out", type=pathlib.Path)
    parser.add_argument("--reference-onnx", type=pathlib.Path)
    parser.add_argument("--audio", type=pathlib.Path, help="raw float32 16 kHz mono samples")
    args = parser.parse_args()

    config, weights = read_nemo(args.nemo)
    labels = config.get("labels") or config["decoder"].get("vocabulary")
    model = QuartzNet(config, weights).eval()
    classes = model.decoder.out_channels
    if classes != len(labels) + 1:
        raise SystemExit(f"Decoder has {classes} classes for {len(labels)} labels")

    args.out.mkdir(parents=True, exist_ok=True)
    onnx_path = args.out / "model.onnx"
    example = torch.zeros(1, 1, SAMPLE_RATE * 4)
    torch.onnx.export(model, example, str(onnx_path), input_names=["signal"], output_names=["logprobs"],
                      dynamic_axes={"signal": {0: "batch", 2: "samples"}, "logprobs": {0: "batch", 1: "frames"}},
                      opset_version=17, dynamo=False)
    (args.out / "vocab.txt").write_text("".join(f"{label} {i}\n" for i, label in enumerate(labels)) + f"<blk> {len(labels)}\n",
                                       encoding="utf-8")
    (args.out / "config.json").write_text(json.dumps({
        "architecture": "quartznet",
        "sampleRate": SAMPLE_RATE,
        "samplesPerFrame": model.hop * model.stride,
        "classes": classes,
        "blank": len(labels),
        "input": "signal",
        "source": {"file": args.nemo.name, "sha256": sha256(args.nemo)},
    }, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"model.onnx": {"bytes": onnx_path.stat().st_size, "sha256": sha256(onnx_path)},
                      "vocab.txt": {"bytes": (args.out / "vocab.txt").stat().st_size, "sha256": sha256(args.out / "vocab.txt")}}))

    if args.reference_onnx and args.audio:
        import onnxruntime as ort

        audio = np.fromfile(args.audio, dtype=np.float32)
        window = 38 * SAMPLE_RATE
        ours = ort.InferenceSession(str(onnx_path))
        reference = ort.InferenceSession(str(args.reference_onnx))
        diffs, agree, total = [], 0, 0
        for start in range(0, len(audio) - window + 1, window):
            chunk = audio[start:start + window].reshape(1, 1, window)
            a = ours.run(None, {"signal": chunk})[0][0]
            b = reference.run(None, {reference.get_inputs()[0].name: chunk})[0][0]
            frames = min(len(a), len(b))
            a, b = a[:frames], b[:frames]
            diffs.append(np.abs(a - b).max(axis=1))
            agree += int((a.argmax(axis=1) == b.argmax(axis=1)).sum())
            total += frames
        diffs = np.concatenate(diffs)
        print(json.dumps({"comparedFrames": total, "argmaxAgreement": round(agree / total, 4),
                          "maxAbsDiffP50": float(np.percentile(diffs, 50)), "maxAbsDiffP99": float(np.percentile(diffs, 99)),
                          "framesOurs": int(len(a)), "framesReference": int(len(b))}))


if __name__ == "__main__":
    main()
