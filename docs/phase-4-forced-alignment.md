# Phase 4: CTC forced alignment

Measured 2026-11-06 on the Nanahoshi host, with whole-book emissions from
`honomiya emit`, aligned with `honomiya align --engine ctc --emissions …` and
measured with `honomiya compare` against the existing SRT-derived alignments.

## Pipeline (`src/ctc/align.ts`, `src/ctc/viterbi.ts`)

1. **Text.** Condition the ebook's sentences (Phase 2, surface policy).
2. **Search.** Place chapters and collect their anchor chains (Phase 3).
3. **Segments.** Thin each chapter's anchors to at least 150 tokens apart.
   Each pair of neighbouring anchors bounds one segment of text and audio.
   - The first segment of a chapter has a free start, and the last a free
     end, so titles, pauses and music before or after the narration cost
     nothing.
   - A segment above 80 M cells is left for interpolation; none was in
     these books.
4. **Viterbi.** A CTC state graph with blanks between tokens: stay, advance,
   or skip a blank between different tokens.
   - Scores are read straight from the sparse emissions, only for the class
     sets the segment uses. Each token scores the best class of its set, and
     STAR scores a constant −3.
   - Only reachable states are visited.
   - Backpointers are one byte per cell per segment.
5. **Not-narrated text.** A sentence of 8 or more tokens squeezed into
   under 1.5 frames per token, with a mean log probability below −4, is
   dropped rather than given a fake time.
6. **Cues.**
   - Token frames become sentence and word times, with the model's timing
     correction applied (−1 228 ms start, −762 ms end; Phase 0).
   - Times are mapped to their track, kept ordered and non-overlapping, and
     gaps between timed sentences of a placed chapter are interpolated by
     text length.
   - Word timings are computed for Phase 5 but not written to the v1
     manifest yet.

`align --engine ctc` emits (or reads with `--emissions`) one emissions file
per audio track and writes the same `honomiya.read-listen.v1` manifest and
report as the transcript engine. The report gains a `ctc` section with the
chapter placement, segment counts, dropped sentences, model and timings.

## Results: whole books against the SRT references

| Book | Hours | Recall | Start p50 | Start p90 | Start and end ≤ 250 ms | ≤ 500 ms | ≤ 1 s | Mean IoU | Alignment time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| スレイヤーズ 13 | 3.9 | 99.6 % | 57 ms | 387 ms | 69.4 % | 86.7 % | 96.1 % | 0.852 | 3.3 s |
| ロクでなし 19 | 8.7 | 99.6 % | 80 ms | 450 ms | 69.4 % | 84.3 % | 91.3 % | 0.851 | 6.9 s |
| 口に関するアンケート | 1.0 | 100 % | 44 ms | 172 ms | 87.2 % | 94.1 % | 95.5 % | 0.919 | 0.8 s |

"Start and end ≤ x" counts a sentence only when both of its boundaries are
within x of the reference. Missing or misplaced cues count as failures.

For comparison, the Modal Whisper large-v3 alignments on the same host had a
median direct coverage of 68 % and took about 30 minutes per book. CTC
alignment takes seconds once the emissions exist. Emission itself runs at
about 20× real time on the host's CPU, so an 8 h book takes about 25 minutes.

## The outliers are reference errors

The largest disagreements were inspected by greedy-decoding the emissions at
both the CTC time and the reference time.

- **口に関するアンケート**, the closing questionnaire (`p-011`).
  - The reference places 「前掲の創作怪談をお読みになったうえで…」 at
    3 474 s. Its neighbouring cues last 0.3 to 0.9 s, which is impossible for
    their length.
  - At 3 443 s, where CTC placed it, the audio says
    「…前掲の創作怪談をお聞きになったうえでアンケートにご…」. Note the
    narration's お聞きになった for the book's お読みになった; CTC aligned
    through the substitution.
- **ロクでなし 19**: shouted lines such as 「お、お父さぁん！」 and
  「やだぁあああ！」 get 0.1 to 0.2 s in the reference and 1 to 3 s from CTC.
  The audio is silent at the reference time and contains the line at the CTC
  time.

The SRT references squeeze some cues into tiny spans through their
interpolation. The p99 errors above are therefore mostly the reference's, and
the true accuracy of the CTC alignments is better than the table shows.

## Cue ends: not cutting off the last syllable

A reader that plays one sentence and stops at its cue end clips the last
word if the cue ends before the voice fades. Measured on the audio of
やはり俺の青春ラブコメはまちがっている。1 (7.2 h). A cue counts as clipped
when the audio is still within 20 dB of the median speech level 50 to 100 ms
after its end, and the next cue starts at least 300 ms later.

| Alignment | Level at the cue end | Still audible after the end |
| --- | --- | --- |
| Whisper large-v3 (Honomiya 0.1, Modal) | −9.8 dB (mid-syllable) | 87.1 % |
| CTC, no end padding | −40.5 dB | 15.3 % |
| CTC, `endPaddingMs: 400` (default) | −57.6 dB | **2.5 %** |

Padding values tried on the CTC alignment:

| Padding | Still audible after the end |
| --- | --- |
| 150 ms | 7.4 % |
| 250 ms | 5.0 % |
| 400 ms | 2.5 % |
| 600 ms | 2.4 % |

The gain stops at 400 ms. `padCueEnds` extends each cue's end into the
following silence by up to that much, never past the next cue's start or the
end of the file, and stretches the cue's last word with it.

Against the SRT references, cue ends now sit about 350 ms after the
reference ends (whose own ends do not include the fading tail). Starts and
the share of sentences within 500 ms are unchanged: 94.4 % and 86.5 %.

## Remaining work

- Phase 5: write word timings into a `read-listen.v2` manifest.
- Re-align segments without dropped text. Not needed
  yet, because no sentence was dropped in these books.
- Viterbi speed is fine for now (about 2 to 6 s per book); profile it before
  any native port.
