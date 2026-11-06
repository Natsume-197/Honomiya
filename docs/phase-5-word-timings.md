# Phase 5: word timings and `read-listen.v2`

Measured 2026-11-06 on the Nanahoshi host, with the same three books as
Phase 4.

## Format

`honomiya align --engine ctc --words` writes a `honomiya.read-listen.v2`
manifest. It is v1 with two changes:

- `granularity` may be `"word"`.
- Each cue may carry `words`:

```json
{
  "id": "s-3-12-1",
  "text": { "kind": "text-quote", "sectionRef": "p-003", "exact": "吾輩は猫である。" },
  "audioFileIndex": 0,
  "startMs": 61240,
  "endMs": 63410,
  "words": [
    { "start": 0, "end": 2, "text": "吾輩", "startMs": 61240, "endMs": 61720 },
    { "start": 2, "end": 3, "text": "は", "startMs": 61720, "endMs": 61900 }
  ]
}
```

- **Ranges.** `start` and `end` are UTF-16 offsets into the sentence's
  visible text: the cue's `exact` text for a text-quote anchor, or the
  whitespace-normalized text of the fragment. `text` repeats the word so
  consumers can verify the range.
- **Tiling.** Words tile their cue with no gaps or overlaps: the first
  starts with the cue, each ends where the next starts, and the last ends
  with the cue. That is what a reader needs to highlight continuously.
  Punctuation stays inside the surrounding word spans.
- **Validation.** Words must be ordered, non-overlapping and inside their
  cue's time span.
- **Which cues have words.** Only directly aligned cues carry words.
  Interpolated cues have none.

v1 stays the default because Nanahoshi only accepts v1 today. The v1 parser
stays strict; `validate` and `compare` accept both versions
(`parseAnyHonomiyaManifest`).

## How word times are derived

Words come from `Intl.Segmenter` over the sentence text (Phase 2). A word
starts at the first aligned frame of its first token, with the model's start
correction applied. Ends come from tiling. A word with no room left (under
1 ms) merges into the word before it.

## Checking words against the audio

There is no word-level human reference, so `bench/probes/word-check.ts`
checks every word of two or more characters against the audio itself. A word
is confirmed when the greedy decode inside its time span contains at least
half of its characters. As a baseline, the same check runs on the span
shifted by ±1 s.

| Book | Words | Words per cue | Duration p50 | Characters / s p50 | Confirmed in its span | Shifted ±1 s | Kana-only confirmed | Kana-only shifted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| スレイヤーズ 13 | 43 144 | 12.1 | 220 ms | 8.3 | 83.9 % | 8.9 % | 84.8 % | 11.7 % |
| ロクでなし 19 | 67 897 | 11.4 | 260 ms | 6.3 | 81.4 % | 10.1 % | 86.5 % | 14.4 % |
| 口に関するアンケート | 8 957 | 13.7 | 220 ms | 7.7 | 83.1 % | 10.7 % | 85.3 % | 13.9 % |

What the numbers show:

- Words are confirmed by the audio in their own span about eight times as
  often as one second away.
- The unconfirmed remainder is mostly decode noise, since the greedy CER is
  about 26 %, rather than timing error.
- Kana-only words, where the decode and the text share a script, confirm
  slightly more often.
- Speaking rates (6 to 8 characters per second at the median) are what
  Japanese narration sounds like.
- Fewer than 0.5 % of words are shorter than 20 ms.

## Not done

- Nanahoshi support for v2 (Phase 7).
- Word timings for the transcript (Whisper) engine.
