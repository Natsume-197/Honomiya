# Phase 8: Spanish and English

Measured 2026-11-06 on the Nanahoshi host with public-domain LibriVox
audiobooks and their Project Gutenberg EPUBs. Both books are multi-track,
one MP3 per chapter: the first real test of multi-track alignment.

| Book | Language | Audio | Tracks | Text |
| --- | --- | --- | --- | --- |
| *Marianela* (Pérez Galdós), LibriVox | es | 6.0 h | 22 | Gutenberg #17340 |
| *The Time Machine*, version 5 (Wells), LibriVox | en | 3.8 h | 12 | Gutenberg #35 |

## Models

`quartznet15x5-es` and `quartznet15x5-en` are NVIDIA's NeMo QuartzNet 15x5
character models (`stt_es_quartznet15x5`, `stt_en_quartznet15x5`), CC-BY-4.0
(see `docs/model-licences.md`). They are converted from the NGC checkpoints
by `scripts/convert-nemo-quartznet.py`, which now also reads the older
nested `params` configuration, and published in Honomiya's `models-v1`
release.

Our conversions give the **same alignment** as the community ONNX exports of
the same checkpoints (OpenVoiceOS), run with Honomiya's standalone mel
frontend: every sentence start is identical to the millisecond, in both
books.

`scripts/build-mel-frontend.py` builds that standalone frontend. Its Slaney
filterbank and Hann window, computed from their definitions, match the
buffers stored in the Japanese, Spanish and English checkpoints to within
2·10⁻⁹. Honomiya can still run "features" models (an acoustic model plus a
separate frontend), though the published models embed the frontend.

## What changed for Latin-script models

- **Case and diacritics:** text is lowercased. A letter with a diacritic the
  vocabulary lacks falls back to its base letter (ç → c); letters the
  vocabulary has (á, ñ, ü…) stay as they are.
- **Word separator:** these vocabularies have a space class that the model
  emits between words. Descriptors list it in `blankEquivalents`, so its
  probability is added to the blank's when emissions are computed. Text
  tokens never include spaces.
- **Numbers:** these models have no digit classes, so digit runs become
  spoken words, `src/ctc/numerals.ts`. In English, 1984 → "nineteen eighty
  four", and other runs are cardinals; in Spanish, 21 → "veintiuno" and
  1984 → "mil novecientos ochenta y cuatro". Japanese keeps digits with a
  kanji alternative.
- **Anchors:** n-grams of 10 characters (`searchNgram`), against 6 for
  Japanese, because a Latin letter carries less information than a kanji.

## Calibration without a reference

No human alignment exists for these books, so `bench/probes/calibrate-offsets.py`
calibrates from loudness instead. It finds silence → speech onsets and
speech → silence offsets, and matches them to cue starts and ends.

**Validation on Japanese.** Measured on Japanese with the SRT-calibrated
correction, our cues start 148 ms before the speech onset, and the human SRT
reference starts 182 ms before it. Ends sit 120–144 ms after the offset
(before end padding). That gives the targets: start ~165 ms before the
onset, end ~130 ms after the offset.

Run uncorrected and without end padding, the raw lags are:

| Model | Onset − raw start (median) | Offset − raw end | Correction |
| --- | --- | --- | --- |
| es | −240 ms | −10 ms | start −405 ms, end +120 ms |
| en | −290 ms | +70 ms | start −455 ms, end +200 ms |

**Check.** With the correction, cue starts fall 155 ms (es) and 165 ms (en)
before the speech onset.

**A bug found on the way.** The correction was being read from the emissions
header, which keeps the value the model had when the emissions were
computed. `currentTimingCorrection` now applies a known model's current
calibration whenever the emissions come from the same model files.

## Results (fp32)

| | Marianela (es) | The Time Machine (en) |
| --- | --- | --- |
| Sentences aligned | 3 567 / 3 581 (99.6 %) | 1 967 / 2 023 (97.2 %) |
| Not aligned | 13 Gutenberg licence lines, plus 1 | 43 Gutenberg header and 13 footer lines (not narrated) |
| Chapters found (multi-track) | all narrated sections | all 17 narrated sections |
| Still audible after the cue end | 1.3 % | 0.0 % |
| Independent judge: sentence heard in its own span (mean) | 96.6 % | 96.9 % |
| Same, span shifted ±2.5 s | 62.1 % | 64.8 % |
| Own span wins / shifted wins (60 sentences) | 50 / 0 | 47 / 0 |
| Sentences heard at least 70 % in their span | 98.3 % | 96.7 % |
| Alignment from cached emissions | 2 min | 12 s |

The judge (`bench/probes/judge-sample.py`) transcribes each sampled
sentence's span with faster-whisper *small*, a model unrelated to the
aligner. It measures how much of the sentence's text the transcript
contains. Shifted spans still contain part of the text because neighbouring
sentences share words; the margin, with the shifted span never winning, is
the signal.

Emission runs at about 25–35× real time in fp32 on the host.

## int8

`scripts/quantize-ctc-model.py`, with the mel frontend and the classifier
kept in fp32, calibrated on other LibriVox books (*El sombrero de tres
picos* and *Peter Pan*):

| | Marianela (es) | The Time Machine (en) |
| --- | --- | --- |
| Emission + alignment, busy host | 349 s for 6.0 h (~62×) | 227 s for 3.8 h (~60×) |
| Sentence starts within 100 ms of fp32 | 99.4 % | 99.7 % |
| Judge: heard in own span / shifted | 96.5 % / 62.1 % (50 to 0) | 96.7 % / 64.8 % (47 to 1) |

## Published

The `models-v1` GitHub release holds all three models (ja, es, en), each
with fp32, int8, vocabulary, config, model card, licence and notice,
prefixed with the model id, plus one `SHA256SUMS`. End to end from an empty
model directory on the host:

- `models pull` installs and verifies all three.
- `align --engine ctc --words` on *The Time Machine* (12 tracks) picks int8
  automatically, finishes in 198 s and matches the validated alignment.
