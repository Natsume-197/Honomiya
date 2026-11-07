# Phase 2: CTC text conditioning

Measured 2026-11-06 on the Nanahoshi host (Orange Pi 5 Plus), against the
same SRT-derived references as Phase 0. Emissions come from `honomiya emit`
(QuartzNet 15x5 ja, sparse top-16).

## What changed

- `extractSectionSentences` now records ruby readings (`<ruby>base<rt>`,
  `<rb>…<rt>…` pairs, nested markup) as `ruby` spans on each sentence.
  Sentence ids and text are unchanged: zero differences across the five corpus
  books (3 591 to 9 334 sentences each).
- `src/ctc/text.ts` turns sentences into the aligner's token sequence:
  - Every token is a **set of equivalent model classes**. The model was
    trained on raw Japanese, so its vocabulary holds ASCII and full-width
    digits, full-width Latin, hiragana and katakana, and duplicates. The set
    covers NFKC forms, the kana-script counterpart and a small glyph-variant
    table (噓→嘘, 頰→頬, …).
  - Punctuation and symbols are dropped, because they are not narrated.
    Characters the model cannot emit become STAR wildcards.
  - Each token maps back to its sentence, its UTF-16 source range and its
    word (`Intl.Segmenter`).
  - Spans that may be spoken differently from how they are written carry
    **alternatives**: ruby readings, with full-size ruby kana also allowing
    small kana (ぎよく → ぎょく), and digit runs read as kanji numerals
    (2008 → 二千八).

## Coverage

| Book | Characters | STAR | Ruby alternatives | Digit runs |
| --- | --- | --- | --- | --- |
| スレイヤーズ 13 | 71 924 | 12 (0.02 %) | 3 564 | 15 |
| ロクでなし魔術講師と禁忌教典 19 | 113 619 | 103 (0.09 %) | 2 563 | 66 |

## Alignment by text policy

A plain CTC Viterbi over 10-minute windows of the sparse emissions, with the
Phase 0 timing correction. "≤ 250" is the share of sentence starts within
250 ms of the reference.

| Window | Policy | Start p50 | Start ≤ 250 | Start ≤ 500 | End ≤ 500 |
| --- | --- | --- | --- | --- | --- |
| スレイヤーズ 30:00 | surface | 65 ms | 85.6 % | 90.2 % | 93.1 % |
| スレイヤーズ 30:00 | ruby | 65 ms | 85.6 % | 90.2 % | 93.1 % |
| ロクでなし 30:00 | surface | 80 ms | 92.7 % | 96.4 % | 90.9 % |
| ロクでなし 30:00 | ruby | 80 ms | 92.7 % | 96.4 % | 90.0 % |
| ロクでなし 4:00:00 | surface | 104 ms | 78.1 % | 83.3 % | 85.1 % |
| ロクでなし 4:00:00 | ruby | 104 ms | 78.1 % | 83.3 % | 85.1 % |

Numeral alternatives made no measurable difference in these windows. On the
same スレイヤーズ window, sparse emissions with class sets beat Phase 0's dense
emissions with exact classes: starts within 250 ms rose from 81.6 % to 85.6 %.

**Default policy: surface text.** Replacing kanji with their ruby readings
does not help, because the model mostly emits the written kanji. The
alternatives stay in the conditioned text so Phase 4 can try them as optional
lattice paths.

## Boundary-search anchors

Unique-in-both n-grams between the book tokens and the greedy decode of the
whole book. Precision is the share whose decode time lies within ±10 s of
the reference time.

| n | スレイヤーズ anchors | precision | ロクでなし anchors | precision |
| --- | --- | --- | --- | --- |
| 4 | 20 810 | 0.991 | 26 261 | 0.989 |
| 6 | 23 609 | 0.999 | 31 108 | 0.997 |
| 8 | 19 531 | 1.000 | 25 648 | 0.999 |
| 10 | 15 228 | 1.000 | 19 478 | 1.000 |

Surface n-grams over class sets give an anchor every three or four characters
at n = 6. Projecting to kana with a morphological analyzer (kuromoji) is not
needed. Phase 3 should use n = 6 to 8.

## Reproducing

```bash
bun bench/probes/text-policy.ts book.epub reference.json book.emissions.bin 1800 600
```

```bash
bun bench/probes/ngram-anchors.ts book.epub reference.json book.emissions.bin
```
