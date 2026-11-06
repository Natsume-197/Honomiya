# CTC model provenance and licences

Reviewed 2026-11-06.

## quartznet15x5-ja (the default Japanese model)

| | |
| --- | --- |
| What Honomiya downloads | its own conversion, from the GitHub release [`models-quartznet15x5-ja-v1`](https://github.com/Natsume-197/Honomiya/releases/tag/models-quartznet15x5-ja-v1): `model.onnx`, `model.int8.onnx`, `vocab.txt`, with `LICENSE`, `NOTICE`, a model card and `SHA256SUMS` |
| Actual origin | [`kinouchi/japanese-quartznet-large`](https://huggingface.co/kinouchi/japanese-quartznet-large), a NeMo QuartzNet model published 2024-09-01 |
| Licence of the origin | **Apache-2.0** |
| Training data | [ReazonSpeech](https://huggingface.co/datasets/reazon-research/reazonspeech) "large" (about 5 000 h of Japanese broadcast audio) |
| Training data licence | CDLA-Sharing-1.0, with the condition that the dataset is used solely for the purposes of Article 30-4 of the Japanese Copyright Act |

### How the origin was established

- The `.nemo` checkpoint's 4 540 labels are identical to an earlier
  third-party ONNX export's `vocab.txt`, in the same order. That order is shuffled, not sorted, so it
  works as a fingerprint.
- Both models have the same architecture: QuartzNet with 18 blocks, kernels
  33 to 87 and a 1×1 classifier, and a 64-mel frontend with 20 ms windows and
  10 ms hops.

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
- **Distribution.** Honomiya converts the checkpoint itself and publishes
  the result, fp32 and int8, as a GitHub release with the Apache-2.0
  licence, an attribution notice and hashes. It no longer depends on any
  third-party mirror.

### Self-converted release

`scripts/convert-nemo-quartznet.py` rebuilds the checkpoint in PyTorch from
its configuration and weights, without NeMo, and exports ONNX with the mel
frontend inside the graph. `scripts/prepare-model-release.py` then assembles
an uploadable folder with the model card, `LICENSE` (Apache-2.0), `NOTICE`
and `SHA256SUMS`.

The upstream checkpoint was downloaded from its author's repository; its
SHA-256 (`d4f0ce9f…`) matches the published one. Validated on 2026-11-06
against the interim export:

| | Interim export | Self-converted |
| --- | --- | --- |
| Vocabulary | — | byte-identical |
| Greedy CER (10 min of スレイヤーズ 13) | 0.275 | 0.272 |
| スレイヤーズ 13 (3.9 h), sentences within 500 ms | 86.5 % | 86.1 % |
| 口に関するアンケート, within 500 ms (fp32 / int8) | 94.1 % / 94.2 % | 94.2 % / 94.4 % |
| Signed start bias against the reference | +7 to +28 ms | +18 to +40 ms |

The two exports' frontends differ slightly: 90 % argmax agreement per frame
on identical weights. Accuracy and timing are the same, so the existing
timing correction (−1 228 / −762 ms) still applies.

Published on 2026-11-06 as the GitHub release `models-quartznet15x5-ja-v1`.
`models pull quartznet15x5-ja` downloads and verifies `model.onnx`,
`model.int8.onnx` and `vocab.txt`, so no installation needs Python. End to
end on the Nanahoshi host, starting from an empty model directory:

- Pull, then `align --engine ctc --words` on 口に関するアンケート (1 h).
- The aligner picked int8 automatically and finished in 74 s.
- Recall was 100 %, with 94.4 % of sentences within 500 ms.

## Other models considered

| Model | Licence | Status |
| --- | --- | --- |
| MMS-300m forced aligner (Meta) | CC-BY-NC-4.0 | Not used: non-commercial and too slow on ARM |
| OpenVoiceOS QuartzNet ONNX (en, de, es, fr, it, pl, ca, ru, pt, ar, hy, kk, fo, is) | CC-BY-4.0 | Candidates for other languages; attribution required |
| OpenVoiceOS QuartzNet Maltese (mt) | CC-BY-NC-SA-4.0 | Avoid: non-commercial |
