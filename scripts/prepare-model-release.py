"""Assemble a publishable model folder for a converted Honomiya CTC model.

    python scripts/prepare-model-release.py release/quartznet15x5-ja \\
        --onnx out/model.onnx --int8 out/model.int8.onnx --vocab out/vocab.txt \\
        --config out/config.json --nemo japanese-quartznet-large.nemo \\
        --metrics metrics.json

Copies the model files and writes README.md (model card), LICENSE (the
upstream licence text) and NOTICE (attribution), plus SHA256SUMS. The
folder can then be uploaded as is, for example to a Hugging Face model
repository.
"""

import argparse
import hashlib
import json
import pathlib
import shutil
import urllib.request

APACHE_LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0.txt"
CC_BY_4_URL = "https://creativecommons.org/licenses/by/4.0/legalcode.txt"
LICENCE_NAMES = {"apache-2.0": "Apache License 2.0", "cc-by-4.0": "Creative Commons Attribution 4.0 International"}

UPSTREAM = {
    "quartznet15x5-ja": {
        "language": "ja",
        "title": "QuartzNet 15x5 Japanese (ONNX) for Honomiya",
        "upstream": "kinouchi/japanese-quartznet-large",
        "upstream_url": "https://huggingface.co/kinouchi/japanese-quartznet-large",
        "upstream_author": "kinouchi",
        "licence": "apache-2.0",
        "dataset": "reazon-research/reazonspeech",
        "dataset_note": (
            "The upstream model was trained on ReazonSpeech (large, about 5 000 h of Japanese broadcast "
            "audio). ReazonSpeech is distributed under CDLA-Sharing-1.0 with the condition that the corpus is "
            "used solely for the purposes of Article 30-4 of the Japanese Copyright Act. That condition binds "
            "users of the corpus; CDLA-Sharing-1.0 §3.5 places no restrictions on the publication of Results."
        ),
    },
    **{
        f"quartznet15x5-{code}": {
            "language": code,
            "title": f"QuartzNet 15x5 {name} (ONNX) for Honomiya",
            "upstream": f"nvidia/stt_{code}_quartznet15x5",
            "upstream_url": f"https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/stt_{code}_quartznet15x5",
            "upstream_author": "NVIDIA",
            "licence": "cc-by-4.0",
            "dataset": "",
            "dataset_note": (
                "see the upstream NGC model card. Licence: NVIDIA's NeMo team stated that NeMo models on NGC are "
                "under CC-BY-4.0 unless a model card specifies otherwise "
                "(https://github.com/NVIDIA-NeMo/NeMo/discussions/1681)."
            ),
        }
        for code, name in (("es", "Spanish"), ("en", "English"))
    },
}


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=pathlib.Path)
    parser.add_argument("--id", default="quartznet15x5-ja")
    parser.add_argument("--onnx", type=pathlib.Path, required=True)
    parser.add_argument("--int8", type=pathlib.Path)
    parser.add_argument("--vocab", type=pathlib.Path, required=True)
    parser.add_argument("--config", type=pathlib.Path, required=True)
    parser.add_argument("--nemo", type=pathlib.Path, required=True, help="upstream checkpoint, for its hash")
    parser.add_argument("--metrics", type=pathlib.Path, help="JSON with measured results to quote")
    args = parser.parse_args()

    info = UPSTREAM[args.id]
    args.out.mkdir(parents=True, exist_ok=True)
    files = {"model.onnx": args.onnx, "vocab.txt": args.vocab, "config.json": args.config}
    if args.int8:
        files["model.int8.onnx"] = args.int8
    for name, source in files.items():
        shutil.copyfile(source, args.out / name)

    licence_url = APACHE_LICENSE_URL if info["licence"] == "apache-2.0" else CC_BY_4_URL
    request = urllib.request.Request(licence_url, headers={"User-Agent": "honomiya-release-script"})
    with urllib.request.urlopen(request, timeout=60) as response:
        (args.out / "LICENSE").write_bytes(response.read())
    (args.out / "NOTICE").write_text(
        f"{info['title']}\n\n"
        f"Converted from {info['upstream']} by {info['upstream_author']},\n"
        f"{info['upstream_url']}, licensed under the {LICENCE_NAMES[info['licence']]}.\n\n"
        "Changes: the NeMo checkpoint was rebuilt in PyTorch and exported to ONNX with the mel frontend\n"
        "inside the graph (scripts/convert-nemo-quartznet.py in Honomiya). model.int8.onnx is a static\n"
        "int8 quantization of model.onnx (scripts/quantize-ctc-model.py). The weights were not retrained.\n",
        encoding="utf-8",
    )

    sums = {name: sha256(args.out / name) for name in sorted(files)}
    (args.out / "SHA256SUMS").write_text("".join(f"{digest}  {name}\n" for name, digest in sums.items()))
    sizes = {name: (args.out / name).stat().st_size for name in sums}
    metrics = json.loads(args.metrics.read_text()) if args.metrics else {}
    rows = "\n".join(f"| `{name}` | {sizes[name]:,} | `{digest}` |" for name, digest in sums.items())
    metric_lines = "\n".join(f"- {line}" for line in metrics.get("lines", []))

    card = f"""---
language:
- {info['language']}
license: {info['licence']}
library_name: onnx
pipeline_tag: automatic-speech-recognition
base_model: {info['upstream']}
{"datasets:" + chr(10) + "- " + info["dataset"] + chr(10) if info["dataset"] else ""}tags:
- ctc
- quartznet
- forced-alignment
- honomiya
---

# {info['title']}

An ONNX export of [{info['upstream']}]({info['upstream_url']}) for
[Honomiya](https://github.com/Natsume-197/Honomiya), the ebook and audiobook
synchronization toolkit, which uses it for CTC forced alignment.

- **Input** `signal`: raw 16 kHz mono audio shaped `[batch, 1, samples]`. The
  mel frontend runs inside the graph.
- **Output** `logprobs`: per-frame log probabilities shaped
  `[batch, frames, {json.loads(args.config.read_text())['classes']}]`, one frame
  per 20 ms. The CTC blank is the last class.
- **Vocabulary**: `vocab.txt` holds one `<token> <index>` per line, in the
  upstream label order.

## Files

| File | Bytes | SHA-256 |
| --- | --- | --- |
{rows}

`model.int8.onnx` is a static int8 quantization (QDQ, per-channel weights,
calibrated on narration). The mel frontend and the classifier stay in fp32.
On ARM CPUs with dot-product instructions it runs about twice as fast as
`model.onnx`, with the same alignment accuracy.

## Measured with Honomiya
{metric_lines or "- See the Honomiya repository's docs for measurements."}

## Provenance and licence

- Upstream: [{info['upstream']}]({info['upstream_url']}) by {info['upstream_author']},
  {info['licence']}. Upstream checkpoint SHA-256:
  `{sha256(args.nemo)}`.
- This release: the same weights, converted, under the same
  **{LICENCE_NAMES[info['licence']]}** (see `LICENSE` and `NOTICE`).
- Training data: {info['dataset_note']}
"""
    (args.out / "README.md").write_text(card, encoding="utf-8")
    print(json.dumps({"out": str(args.out), "files": sums}, indent=2))


if __name__ == "__main__":
    main()
