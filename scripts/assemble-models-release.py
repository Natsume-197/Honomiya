"""Combine per-model folders (from prepare-model-release.py) into one release.

    python scripts/assemble-models-release.py release/models-v1 \\
        release/quartznet15x5-ja release/quartznet15x5-es release/quartznet15x5-en

Every file is prefixed with its model id (quartznet15x5-ja.model.onnx,
quartznet15x5-ja.LICENSE.txt, …). The script writes one SHA256SUMS and
NOTES.md (the release notes: a table of models, licences and upstreams, then
each model card). Published files must never be replaced, because Honomiya
verifies them by hash; an updated model gets a new file name or release.
"""

import hashlib
import json
import pathlib
import shutil
import sys

RENAMES = {"LICENSE": "LICENSE.txt", "NOTICE": "NOTICE.txt"}
SKIP = {"SHA256SUMS"}


def front_matter(card: str) -> tuple[dict, str]:
    if not card.startswith("---"):
        return {}, card
    _, header, body = card.split("---", 2)
    fields, key = {}, None
    for line in header.strip().splitlines():
        if line.startswith("- ") and key:
            fields[key] = ", ".join(filter(None, [fields.get(key), line[2:].strip()]))
        elif ":" in line:
            key, value = line.split(":", 1)
            key = key.strip()
            fields[key] = value.strip()
    return fields, body.strip()


def main() -> None:
    out = pathlib.Path(sys.argv[1])
    folders = [pathlib.Path(p) for p in sys.argv[2:]]
    out.mkdir(parents=True, exist_ok=True)
    rows, cards, sums = [], [], {}
    for folder in folders:
        model_id = folder.name
        for path in sorted(folder.iterdir()):
            if path.name in SKIP:
                continue
            target = out / f"{model_id}.{RENAMES.get(path.name, path.name)}"
            shutil.copyfile(path, target)
            sums[target.name] = hashlib.sha256(target.read_bytes()).hexdigest()
        fields, body = front_matter((folder / "README.md").read_text(encoding="utf-8"))
        rows.append(f"| `{model_id}` | {fields.get('language', '').lstrip('- ')} | {fields.get('license', '')} | "
                    f"{fields.get('base_model', '')} |")
        cards.append(body.replace("# ", "## ", 1))
    (out / "SHA256SUMS").write_text("".join(f"{d}  {n}\n" for n, d in sorted(sums.items())))
    notes = (
        "CTC acoustic models for [Honomiya](https://github.com/Natsume-197/Honomiya)'s forced aligner, "
        "converted to ONNX by Honomiya's own scripts. Files are prefixed with their model id. "
        "Each model keeps its upstream licence: see its `LICENSE.txt` and `NOTICE.txt`.\n\n"
        "| Model | Language | Licence | Upstream |\n| --- | --- | --- | --- |\n"
        + "\n".join(rows) + "\n\n" + "\n\n".join(cards) + "\n"
    )
    (out / "NOTES.md").write_text(notes, encoding="utf-8")
    print(json.dumps({"out": str(out), "files": len(sums)}, indent=2))


if __name__ == "__main__":
    main()
