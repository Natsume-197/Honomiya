# CTC model provenance and licences

Reviewed 2026-11-06.

## quartznet15x5-ja (the default Japanese model)

| | |
| --- | --- |
| What Honomiya downloads | `model.onnx` and `vocab.txt` from the Storyteller project's GitLab model registry (package `quartznet15x5-ja` 1.0.0, created 2026-09-21) |
| Licence stated by that registry | none (neither the package nor the project declares one) |
| Actual origin | [`kinouchi/japanese-quartznet-large`](https://huggingface.co/kinouchi/japanese-quartznet-large), a NeMo QuartzNet model published 2024-09-01 |
| Licence of the origin | **Apache-2.0** |
| Training data | [ReazonSpeech](https://huggingface.co/datasets/reazon-research/reazonspeech) "large" (about 5 000 h of Japanese broadcast audio) |
| Training data licence | CDLA-Sharing-1.0, with the condition that the dataset is used solely for the purposes of Article 30-4 of the Japanese Copyright Act |

### How the origin was established

- The `.nemo` checkpoint's 4 540 labels are identical to Storyteller's
  `vocab.txt`, in the same order. That order is shuffled, not sorted, so it
  works as a fingerprint.
- Both models have the same architecture: QuartzNet with 18 blocks, kernels
  33 to 87 and a 1×1 classifier, and a 64-mel frontend with 20 ms windows and
  10 ms hops.
- Storyteller's conversion script (`libraries/mlx-audio/scripts/convert.py`)
  accepts `.nemo` checkpoints.
- Storyteller's other QuartzNet languages come from OpenVoiceOS ONNX exports
  on Hugging Face.

### What this means

- **The weights are Apache-2.0.** Use, modification and redistribution,
  commercial included, are allowed with a copy of the licence and
  attribution. The int8 variant Honomiya produces is a modification and falls
  under the same terms.
- **The dataset condition binds whoever uses the dataset**, which here means
  the model's trainer. CDLA-Sharing-1.0 §3.5 says the agreement "imposes no
  obligations or restrictions on Your Use or Publication of Results", and
  ReazonSpeech's own models are published as Apache-2.0.
- **What the licence text leaves open:** whether a trained model counts as
  "Results". For self-hosted, personal use the residual risk is negligible.
  For a commercial product, ask a lawyer.
- **The weak link is the download source, not the licence.** The Storyteller
  registry states no licence or attribution and could change or disappear.
  The robust option is to fetch the `.nemo` from its author, convert it with
  Honomiya's own tooling, and host the ONNX (fp32 and int8) with the
  Apache-2.0 licence and an attribution notice.

## Other models considered

| Model | Licence | Status |
| --- | --- | --- |
| MMS-300m forced aligner (Meta) | CC-BY-NC-4.0 | Not used: non-commercial and too slow on ARM |
| OpenVoiceOS QuartzNet ONNX (en, de, es, fr, it, pl, ca, ru, pt, ar, hy, kk, fo, is) | CC-BY-4.0 | Candidates for other languages; attribution required |
| OpenVoiceOS QuartzNet Maltese (mt) | CC-BY-NC-SA-4.0 | Avoid: non-commercial |
