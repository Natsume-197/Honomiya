# Phase 6: performance

Measured 2026-11-06 on the Nanahoshi host: an RK3588 with four Cortex-A55
cores (cpu0–3, 1.8 GHz) and four Cortex-A76 cores (cpu4–7, 2.26 GHz), CPU
only. The host kept serving Jellyfin and the other services, so loads varied
between 0.7 and 5. Each comparison below was run back to back.

## Where the time goes

After Phase 4, aligning a whole book takes seconds; emission is the cost. On
the 8.7-hour book, emission spent about 93 % of its time in the model, 4 %
waiting for audio decoding and 2 % in top-k selection.

## CPU tuning: nothing left to gain

10 minutes of audio, QuartzNet 15x5 ja, fp32, quiet host:

| Configuration | xRT |
| --- | --- |
| 4 threads, OS scheduling (current default) | **32.3×** |
| Pinned to the A76 cores | 30.5× |
| 60 s / 120 s windows (instead of 38 s) | 29.1× / 28.0× |
| Batch of 2 / 4 windows | 19.0× / 26.4× |
| A55 cores only | 6.7× |
| A76 and A55 in parallel (two processes) | 24.5× + 6.2× |

The default is already the best. Longer windows, batching and adding the
little cores all lose, most likely because the cores share memory bandwidth.

## INT8 quantization

The A76 has dot-product instructions that ONNX Runtime uses for int8
convolutions. All variants below were quantized statically with ONNX Runtime
1.23.2 (QDQ, per-channel weights) and calibrated on real narration.

| Variant | Size | xRT | Greedy CER |
| --- | --- | --- | --- |
| fp32 (reference) | 95 MB | 28.9× | 0.275 |
| int8, every Conv | 25 MB | 88.3× | 0.326 |
| int8, mel frontend and classifier kept in fp32 | 25 MB | 61.5× | 0.275 |
| int8, frontend, classifier and first encoder block kept in fp32 | — | 54.9× | 0.273 |
| Dynamic int8 (ConvInteger) | 24 MB | 1.6× | 0.294 |

Quantizing every Conv also quantizes the STFT convolution of the mel
frontend and the classifier, which costs accuracy. Keeping just those two in
fp32 restores fp32's CER and still runs twice as fast. That recipe is
`scripts/quantize-ctc-model.py`.

### Whole books not used for calibration

Calibration used スレイヤーズ 13 and シャイロックの子供たち. These two books
were not part of it:

| Book | fp32 xRT | int8 xRT | fp32 start and end ≤ 500 ms | int8 start and end ≤ 500 ms | Recall (both) |
| --- | --- | --- | --- | --- | --- |
| 口に関するアンケート (1.0 h) | ~19× | 37.6× | 94.1 % | 94.2 % | 100 % |
| ロクでなし 19 (8.7 h) | 18.6× | 37.0× | 84.3 % | 84.6 % | 99.6 % |

Alignment accuracy is unchanged and emission is twice as fast under the
same host load. An 8.7-hour book drops from 28 to 14 minutes.

### End to end

The documented workflow was run in full:

1. Quantize with `scripts/quantize-ctc-model.py`, calibrated on two other
   books.
2. `models import`.
3. `align --engine ctc --words` with no precomputed emissions, so it emits
   and aligns in one run.

On 口に関するアンケート (1.0 h) it took **103 s in total** at a host load of
6. The report names the int8 revision, recall is 100 %, and 93.9 % of
sentences have both boundaries within 500 ms (fp32: 94.1 %).

## How to use it

```bash
.venv-quantize/bin/python scripts/quantize-ctc-model.py <model.onnx> model.int8.onnx book1.m4b book2.m4b
bun run honomiya models import quartznet15x5-ja --int8 model.int8.onnx
```

- `models import` stores the file next to the fp32 vocabulary with a sidecar
  recording its SHA-256.
- The variant's revision (`…+int8.<sha12>`) appears in every emissions
  header, so cached fp32 and int8 emissions never mix.
- `emit` and `align --engine ctc` take `--precision auto|fp32|int8`. `auto`,
  the default, uses an imported int8 variant when there is one.

The quantized weights are derived from third-party weights whose licence is
unconfirmed, so Honomiya does not download them; each installation quantizes
its own copy. If the licence allows it, the variant can later be published
and pinned like the fp32 file.

## Not pursued

- **RK3588 NPU (RKNN).** Its conversion toolkit and runtime are Python and
  C, so a Bun binding would need native work. Revisit if int8 on the CPU is
  not enough.
- **Shorter window context (2 s → 1 s)** would save about 6 % of model
  time, at an unmeasured accuracy risk.
- **Viterbi optimization.** It takes 2 to 6 s per book; there is nothing to
  gain.
