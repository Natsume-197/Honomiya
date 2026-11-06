# Phase 3: boundary search

Measured 2026-11-06 on the Nanahoshi host, with whole-book emissions from
`honomiya emit` and the same SRT-derived references as earlier phases.

## Algorithm (`src/ctc/search.ts`)

1. **Global decode.** Every track's emissions are greedy-decoded onto one
   global frame axis and reduced to class-set tokens, the same tokens the
   book is conditioned into (`src/ctc/text.ts`).
2. **Anchor candidates.** A candidate is a 6-gram that occurs exactly once in
   the whole book and exactly once in the whole decode. A phrase repeated
   anywhere, such as chapter titles in a table of contents, never anchors.
3. **Anchor chain per chapter.** The search keeps the longest chain of a
   chapter's candidates that moves forward in both text and audio at a
   plausible speaking rate: 2 to 25 frames per token between neighbours,
   with 150 frames of slack and at most 4 000 tokens between links.
   - This is a dynamic program, not a single RANSAC line, so it follows a
     narrator's changing pace inside a chapter.
   - It is deterministic.
   - A stray match far away cannot join the chain.
4. **Placement.** Chapters are placed best-first (longest chain). A placed
   chapter's anchored audio is unavailable to the rest, which resolves
   reordered, repeated and missing chapters without assuming the ebook and
   the audiobook share an order. A chapter needs enough anchors and 30 %
   coverage to count as found.
5. **Windows for the aligner.** The outer anchors are extrapolated at the
   local speaking rate. The window then widens by up to 60 s (titles, pauses,
   music) but never past the neighbouring chapters' anchors. Phase 4 finds
   the exact boundaries inside.

`trackFrame` maps global frames back to a track and a local frame, so one
chapter may span several files.

## Results

| Book | Hours | Chapters | Found / narrated | False positives | Windows containing the narration | Anchors | Anchor error p50 / p90 | ≤ 1 s | Search time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| スレイヤーズ 13 | 3.9 | 20 | 15 / 15 | 0 | 15 / 15 | 23 567 | 162 / 434 ms | 99.8 % | 0.7 s |
| ロクでなし 19 | 8.7 | 19 | 13 / 13 | 0 | 13 / 13 | 30 982 | 193 / 628 ms | 97.0 % | 1.0 s |
| 口に関するアンケート | 1.0 | 12 | 10 / 10 | 0 | 10 / 10 | 6 395 | 196 / 610 ms | 96.9 % | 0.1 s |

The probe first reported three narrated chapters as missed. All three are
illustration credits, colophons and the e-book copyright notice, which the
audiobooks do not narrate. Their reference cues come from the SRT
alignment's interpolation, squeezed into the last seconds of audio. Every
chapter that is actually narrated was found.

Anchor errors include the reference's own error and the anchor's position
inside its n-gram, so they are upper bounds. They are only meant to prove the
anchors are trustworthy segment boundaries; Phase 4 aligns between them.

## Notes for Phase 4

- Chapter windows start 5 to 20 s before the narration (median) and up to
  60 s before it. Viterbi with free start and end trims that.
- Anchors are dense: every 3 to 4 tokens. Segments between anchors should be
  thinned to a few hundred tokens to bound memory, while staying short enough
  that a wrong anchor costs little.
- Colophon-style sections (`p-credit`, `p-colophon`) could be excluded up
  front.

## Reproducing

```bash
bun bench/probes/chapter-search.ts book.epub reference.json book.emissions.bin
```
