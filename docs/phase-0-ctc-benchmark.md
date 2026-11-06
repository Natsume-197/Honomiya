# Phase 0: CTC alignment feasibility

Measured 2026-11-06 on the production host that runs Nanahoshi: an Orange Pi 5
Plus (RK3588, 4×A76 + 4×A55, 16 GB RAM, no CUDA), CPU only, with
`onnxruntime-node` 1.23.2 under Bun 1.3.14 in a throwaway container. The
Nanahoshi services kept running during the measurements, so throughput is a
conservative estimate.

## Why Japanese first

All 1 397 alignment reports on that host are `ja`. 1 391 used SRT timed text
(median direct coverage 0.99, about 1.6 minutes per book). The few audio-only
runs used Modal Whisper large-v3: about 30 minutes per book and a median direct
coverage of 0.68. The audio-only path is the one CTC has to improve.

## Reference corpus

Pairs whose existing alignment came from SRT timed text and has no gap longer
than 60 s. Cue ids are stable for a given ebook, so those manifests serve as
the reference for `honomiya compare`.

| Book | Audio |
| --- | --- |
| 口に関するアンケート | 1.0 h |
| スレイヤーズ 13 | 3.9 h |
| ロクでなし魔術講師と禁忌教典 19 | 8.7 h |
| シャイロックの子供たち | 10.2 h |
| 春夏秋冬代行者 夏の舞 下 | 14.7 h |

All audiobooks in the library are single-track AAC (`.m4b`), 6 to 10 hours
typically.

## Throughput

10 minutes of スレイヤーズ 13, greedy decoding included. xRT is audio duration
divided by processing time.

| Model | Precision | Threads | xRT | Peak RSS |
| --- | --- | --- | --- | --- |
| QuartzNet 15x5 ja | fp32 | 2 | 17.2× | 495 MB |
| QuartzNet 15x5 ja | fp32 | 4 | **31.0×** | 531 MB |
| QuartzNet 15x5 ja | fp32 | 8 | 21.6× | 511 MB |
| QuartzNet 15x5 ja | fp16 | 4 | 32.1× | 469 MB |
| MMS-300m forced aligner | int8 | 8 | 2.7× | 1.5 GB |
| MMS-300m forced aligner | fp32 | 4 | 1.6× | 2.4 GB |

Four threads (the big cores) beat eight. An 8-hour book takes about 15 minutes
of emission time with QuartzNet and three to five hours with MMS.

## Recognition quality

QuartzNet 15x5 ja emits 4 541 classes (4 177 kanji, 175 kana, symbols), so
the ebook text needs no romanization. MMS emits romanized Latin and reads
kanji as Mandarin pinyin, which makes it a poor fit for Japanese.

- Greedy CER on the 10-minute window, against the reference ebook text: 0.273.
- Characters of the whole ebook missing from the vocabulary: 0.04 %. They are
  glyph variants (噓/嘘, 頰/頬, 搔/掻, 瘦/痩, 剝/剥, 嚙/噛) that a small
  normalization table maps onto the vocabulary.

## Forced alignment

`bench/probes/forced-align.ts` runs a plain CTC Viterbi (free start and end)
over the 10-minute window and compares sentence boundaries with the reference.

The raw timings are late by a constant amount. The reference starts sit on a
silence-to-speech edge (RMS 0.013 → 0.052), and the CTC starts sit inside
speech. The emission activity trails the audio envelope by 980 ms on both
books, so the lag belongs to this model export.

The offsets were calibrated on シャイロックの子供たち (start 1 228 ms, end 762 ms
of lag, 104 sentences). They were then validated on スレイヤーズ 13, which has a
different narrator (174 sentences):

| Boundary | p50 | p90 | p99 | ≤ 250 ms | ≤ 500 ms |
| --- | --- | --- | --- | --- | --- |
| Start | 73 ms | 545 ms | 1 033 ms | 81.6 % | 88.5 % |
| End | 89 ms | 485 ms | 1 205 ms | 73.6 % | 90.2 % |

The reference is SRT-derived and carries its own error, so these are
agreement figures, not absolute accuracy.

## Conclusions

1. **QuartzNet 15x5 ja is the engine for the Nanahoshi host.** It is fast on
   ARM, needs no Python and no romanization, and covers nearly all characters.
   MMS stays as an optional multilingual fallback, off by default, and its
   CC-BY-NC licence rules it out for commercial use.
2. Model-specific start and end offsets are required. They belong in the model
   descriptor and must be calibrated per model.
3. The naive Viterbi runs at about 83 ns per cell. A whole book needs anchors
   between segments, a diagonal band and typed-array loops without per-frame
   allocations. That is Phase 4 work; Storyteller reports about 4 ns per cell.
4. The model weights come from the Storyteller project's model registry, and
   their licence must be confirmed before Honomiya downloads them by default.

## Reproducing

The probes live in `bench/probes` and need `onnxruntime-node`, which is not a
Honomiya dependency yet. Decode a window to raw 16 kHz mono float32 first:

```bash
ffmpeg -ss 1800 -t 600 -i book.m4b -ac 1 -ar 16000 -f f32le sample.f32
```

```bash
bun bench/probes/throughput.ts qn model.onnx vocab.txt 4 38 sample.f32
```

```bash
bun bench/probes/forced-align.ts book.epub reference.json sample.f32 1800 model.onnx vocab.txt 1228 762
```

Compare a full candidate manifest against a reference with
`honomiya compare candidate.json reference.json`.
