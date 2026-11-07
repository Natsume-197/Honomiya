# The CTC alignment engine

Honomiya's second alignment engine, `honomiya align --engine ctc`. It aligns
an ebook to its audiobook directly from a CTC acoustic model's per-frame
character probabilities ("emissions"), instead of transcribing the audio and
matching the transcript. It runs on the CPU through `onnxruntime-node`, with
no Python and no remote provider.

This is the entry point for maintainers. The phase reports linked below hold
the detailed measurements behind each decision.

## Why it exists

The transcript engine (Whisper) has to guess the text, then match the guess
to the book. Narration it mishears falls back to interpolation, and its cue
times are imprecise. The CTC engine already knows the text, because it is
the ebook; it only searches for *when* each character is spoken.

Results on the Nanahoshi host's Japanese library and on LibriVox books:

| | Whisper large-v3 (Modal) | CTC |
| --- | --- | --- |
| Directly aligned sentences | median 68 % | 99.5–100 % of narrated text |
| Disagreements over 2 s, scored by an independent judge (one book) | won 0 | won 18 (35 ties) |
| Sentences still audible after their cue ends | 87 % | 0–2.5 % |
| 8.7 h book on an RK3588 CPU | about 30 min, paid GPU | about 14 min with int8, local |

## Pipeline

```
ebook ─► sentences (+ ruby) ─► text conditioning ─► class-set tokens
audio ─► emit (QuartzNet ONNX) ─► sparse emissions ─┐
                                                     ├─► boundary search ─► chapter windows + anchors
                                                     └─► Viterbi between anchors ─► token frames
token frames ─► sentence and word times (timing correction, end padding) ─► read-listen manifest
```

| Stage | Code | What it does |
| --- | --- | --- |
| Models | `src/ctc/models.ts`, `model-store.ts` | Descriptors (files, hashes, calibration, search n-gram, blank-equivalent tokens), `models pull/list/import`, fp32 and int8. |
| Emission | `emit.ts`, `acoustic-model.ts`, `windows.ts`, `pcm.ts` | ffmpeg decodes 5-minute chunks; 38 s inference windows with 2 s of context; frames stitched on a 20 ms grid; cached and resumable per chunk. |
| Emission format | `emissions.ts` | `honomiya.emissions.v1`: blank plus the top 16 classes per frame, int16 milli-nats, about 12 MB per hour. Blank-equivalent classes, such as a word separator, are merged into the blank. |
| Text | `text.ts`, `numerals.ts`, `alignment/ebook-text.ts` | Tokens are sets of equivalent classes: NFKC, kana scripts, glyph variants, case, diacritic fallback. STAR stands for characters the model lacks. Digits become spoken words (ja kanji, es, en). Ruby readings are kept as alternatives. |
| Boundary search | `search.ts` | Unique n-grams in both the book and the greedy decode become anchors. A slope-constrained longest chain runs per chapter, and chapters are placed best-first, which handles reordered, missing, unnarrated and multi-track chapters. |
| Alignment | `viterbi.ts`, `align.ts` | Viterbi runs between thinned anchors, with free edges at chapter boundaries. Not-narrated text is detected and interpolation fills gaps. Cue times get the model's timing correction and 400 ms of end padding. Words tile each sentence. |
| Publication | `publication.ts` | The manifest is `read-listen.v1`, or `v2` with `--words`; the report gains a `ctc` section. |

## Using it

```bash
bun run honomiya models pull quartznet15x5-ja
```

```bash
bun run honomiya align --ebook book.epub --audio book.m4b --engine ctc --words
```

- **Model choice:** from `--language` or the ebook's language; override with `--model`.
- **Precision:** `--precision auto|fp32|int8`. `auto` uses int8 when it is installed, and `models pull` installs it.
- **Reusing emissions:** `honomiya emit` writes emissions for one audio file, and `align --emissions <file>` reuses them.
- **End padding:** `--end-padding-ms` changes it; the default is 400. Set it to 0 only when calibrating.
- **Comparing:** `honomiya compare candidate.json reference.json` measures one manifest against another.

## Models

All models are Honomiya's own conversions, published in the GitHub release
[`models-v1`](https://github.com/Natsume-197/Honomiya/releases/tag/models-v1).
Files are prefixed with the model id, and one `SHA256SUMS` covers them all.

| Model | Upstream | Licence | Timing correction (start / end) | Anchor n-gram |
| --- | --- | --- | --- | --- |
| `quartznet15x5-ja` | kinouchi/japanese-quartznet-large (Hugging Face) | Apache-2.0 | −1 228 / −762 ms (from SRT references) | 6 |
| `quartznet15x5-es` | NVIDIA NeMo `stt_es_quartznet15x5` (NGC) | CC-BY-4.0 | −405 / +120 ms (from audio loudness) | 10 |
| `quartznet15x5-en` | NVIDIA NeMo `stt_en_quartznet15x5` (NGC) | CC-BY-4.0 | −455 / +200 ms (from audio loudness) | 10 |

Provenance and the licence reasoning are in [model-licences.md](model-licences.md).

**Rules for published files**

- A published file is never replaced, because Honomiya verifies every
  download by size and SHA-256.
- An updated model gets a new release (`models-v2`) and a new descriptor
  revision. The revision also keys the emission cache, so old and new
  emissions never mix.
- Descriptors keep the local file names (`model.onnx`, `vocab.txt`) apart
  from the URLs, so moving files between releases does not force a
  re-download.

## Adding a language

1. **Find a model and check its licence first.** Use a character-level CTC
   model whose weights allow redistribution. Record the evidence in
   `model-licences.md`. Avoid non-commercial (NC) weights. Never rely on a
   re-uploader's licence label: check the original publisher's.
2. **Convert** the NeMo checkpoint:
   `scripts/convert-nemo-quartznet.py model.nemo out/`. It handles flat and
   nested (`params`) configs and embeds the mel frontend. Other
   architectures need their own converter; a frontend-less ONNX can run with
   `scripts/build-mel-frontend.py` and `input: "features"`.
3. **Add a descriptor** in `src/ctc/models.ts`:
   - files with sizes and SHA-256;
   - `blankEquivalents` for a word-separator class;
   - `searchNgram`: 6 for logographic scripts, 10 for alphabets;
   - a zero `timingCorrectionMs`.
4. **Teach the text side the language if needed:** a spoken-number function
   in `numerals.ts`, case folding and diacritics.
5. **Get test data:** a LibriVox recording plus its Project Gutenberg EPUB.
   Check that every audio track actually downloaded; a missing track looks
   exactly like an unaligned chapter.
6. **Calibrate.** Align with `--end-padding-ms 0`, then run
   `bench/probes/calibrate-offsets.py manifest.json audio-dir`. Set
   `start = median − 165` and `end = median + 130`. Those targets reproduce
   the SRT-calibrated Japanese model within 30 ms. Re-run to confirm a start
   residual of about +165 ms.
7. **Validate:**
   - `chapters` in the report: every narrated section found.
   - `bench/probes/end-clip-multi.py`: under 3 % audible after the end.
   - `bench/probes/judge-sample.py`: the own span should clearly beat the
     ±2.5 s shift, with the shift winning about 0 times.
8. **Quantize** with `scripts/quantize-ctc-model.py`, calibrating on *other*
   books, and validate int8 against fp32 with `compare`.
9. **Publish:**
   - `scripts/prepare-model-release.py` for each model (model card,
     `LICENSE`, `NOTICE`; add an `UPSTREAM` entry);
   - `scripts/assemble-models-release.py` into a new release folder;
   - `gh release create models-vN --latest=false`;
   - descriptor URLs and the int8 entry;
   - `models pull` from an empty model directory, then one end-to-end
     `align`.

## Validation toolbox (`bench/probes`)

| Probe | Use |
| --- | --- |
| `throughput.ts`, `emit-with-model.ts` | Model speed; emitting with an arbitrary ONNX file. |
| `window-text.ts`, `emissions-window.ts` | Greedy CER of a window against the ebook text. |
| `ngram-anchors.ts`, `chapter-search.ts` | Anchor density and precision; chapter placement against a reference. |
| `text-policy.ts`, `forced-align.ts` | Viterbi experiments on a window. |
| `calibrate-offsets.py` | Reference-free timing calibration from loudness. |
| `end-clip.py`, `end-profile.py`, `end-clip-multi.py` | Whether cue ends cut off the last syllable. |
| `judge.py`, `disputes.ts`, `judge-sample.py` | An independent model (faster-whisper small) decides which span holds a sentence. |
| `word-check.ts` | Word timings against the audio. |

SRT-derived alignments are useful references, but they contain errors of
their own: cues squeezed by interpolation, sometimes 30 s off. The judge
probes settle disputes against the audio itself.

## Decisions worth remembering

- **QuartzNet, not MMS.** MMS (Meta) is CC-BY-NC, runs at 1.6–4× real time
  on ARM, and romanizes kanji as pinyin. QuartzNet 15x5 runs at about 30× in
  fp32 and about 60× in int8.
- **Sparse emissions.** Dense emissions of a 4 541-class vocabulary would
  take 1.6 GB per hour. The top 16 classes plus the blank lose no accuracy;
  they were in fact slightly better than dense with class sets.
- **Surface text, not ruby readings.** Replacing kanji with their ruby
  readings did not help, because the model mostly emits the written kanji.
  The readings stay available as alternatives.
- **Word separators count as silence.** They are merged into the blank at
  emission time, so the text never needs space tokens.
- **Timing corrections belong to the model,** and the current calibration
  overrides the one recorded in cached emissions of the same model files.
- **A 400 ms end padding,** never past the next cue, keeps the fading last
  syllable.
- **Own conversions, one release.** Every model is converted from its
  original checkpoint and hosted in `models-v1` with its licence, notice and
  hashes, with no dependency on third-party mirrors. Another project's
  aligner was studied for ideas only; none of its code is used.

## Phase reports

| Phase | Report |
| --- | --- |
| 0: feasibility, model choice, timing lag | [phase-0-ctc-benchmark.md](phase-0-ctc-benchmark.md) |
| 2: text conditioning, ruby, anchors | [phase-2-text-conditioning.md](phase-2-text-conditioning.md) |
| 3: boundary search | [phase-3-boundary-search.md](phase-3-boundary-search.md) |
| 4: forced alignment, cue ends | [phase-4-forced-alignment.md](phase-4-forced-alignment.md) |
| 5: word timings, `read-listen.v2` | [phase-5-word-timings.md](phase-5-word-timings.md) |
| 6: performance, int8 | [phase-6-performance.md](phase-6-performance.md) |
| 8: Spanish and English | [phase-8-latin-languages.md](phase-8-latin-languages.md) |
| Licences | [model-licences.md](model-licences.md) |

Phases 1 (emissions) and 7 (integration) have no separate report; phase 1
is described above.

## Open work

- **Nanahoshi integration** (phase 7):
  - `onnxruntime-node` in the image and `HONOMIYA_REF` at the merged commit;
  - models pulled once to a volume;
  - the worker uses `--engine ctc` when there is no SRT and a model exists;
  - an engine selector (SRT → CTC → Whisper);
  - `"ctc"` in the report's `transcription.mode` enum;
  - `read-listen.v2` word highlighting in the reader.
- **More languages:** NVIDIA's other QuartzNet models (de, fr, it, pl, ca,
  ru, zh) rest on the same licence basis; community models need checking one
  by one.
- **Aligner:**
  - re-align segments after dropping un-narrated text;
  - exclude colophons and credits up front;
  - use CTC on SRT-aligned books to add word timings.
- **Validation:** run about 20 SRT-referenced books with `compare` for a
  broader figure.
- **Housekeeping:** four Windows path tests (SRT and options) failed before
  this work and still do.
