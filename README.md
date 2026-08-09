# Honomiya

Honomiya is a command line toolkit for synchronizing ebooks with audiobooks. It
turns an ebook and an ordered set of audio tracks into a portable,
sentence level read-and-listen manifest.

The manifest is Honomiya's stable interface and can be used by any compatible
reader or library application.

## Requirements

- [Bun](https://bun.sh/) 1.3.14 or newer.
- `ffmpeg` and `ffprobe` when transcribing audio.
- A [Modal](https://modal.com/) account and credentials when using the Modal
  provider.

Install the dependencies:

```bash
bun install
```

Deploy the transcription provider once:

```bash
uvx --from modal==1.5.3 modal setup
uvx --from modal==1.5.3 modal deploy modal_app.py
```

Modal reads credentials from `~/.modal.toml` or from `MODAL_TOKEN_ID` and
`MODAL_TOKEN_SECRET`.

## Choose a workflow

| Command | Input | What it does | Output |
| --- | --- | --- | --- |
| `transcribe` | Audio only | Runs speech recognition and records the detected words with their timestamps. It does not read or align an ebook. | An intermediate, reusable `honomiya.transcript.v1` JSON file. |
| `align` | Ebook and audio, plus a provider or reusable transcript | Matches the ebook's exact sentences to the audio timestamps. It can run transcription internally when given a provider. | The final read-and-listen manifest, report and optional SRT files. |

### Direct alignment

`align` is the final command. Use `align --provider` for the normal one-command
workflow: Honomiya transcribes the audio internally and immediately aligns it
with the ebook.

```bash
bun run honomiya align \
  --ebook book.epub \
  --audio 01.mp3 \
  --audio 02.mp3 \
  --provider modal \
  --srt
```

### Create a reusable timed transcript

`transcribe` runs speech recognition on the audio and saves its detected
segments, words and timestamps as JSON. It does not use the ebook and does not
create the final read-and-listen manifest.

Use it first only when you want to inspect or reuse that timed transcript.
Afterward, pass the JSON to `align --transcript` to create the final manifest
without another provider call.

```bash
bun run honomiya transcribe \
  --audio book.m4b \
  --provider modal

bun run honomiya align \
  --ebook book.epub \
  --audio book.m4b \
  --transcript book.honomiya.transcript.json
```

The useful order is `transcribe → align`. Running `transcribe` after
`align --provider` is normally redundant because `align` already transcribed
the audio internally.

### Validate the result

Validate a generated manifest independently:

```bash
bun run honomiya validate book.honomiya.alignment.json
bun run honomiya validate book.honomiya.alignment.json --json
```

## CLI options

| Option | Command | Value and default | Description |
| --- | --- | --- | --- |
| `--ebook <path>` | `align` | Required | Ebook to align. |
| `--audio <path>` | `align`, `transcribe` | Required | Audio source. Repeat it for ordered multi-track input with `align`; `transcribe` accepts one source. |
| `--provider <name>` | `align`, `transcribe` | `modal`; required unless `align` receives transcripts or `HONOMIYA_PROVIDER` is set | Selects the transcription provider. It cannot be combined with `--transcript`. |
| `--transcript <path>` | `align` | Optional; repeatable | Reuses one transcript per audio source, in matching order. |
| `--output <path>` | `align`, `transcribe` | Derived beside the ebook or audio | Overrides the alignment or transcript output path. |
| `--quality <preset>` | `align`, `transcribe` | `accurate` | Uses `accurate` or `fast` processing. |
| `--language <locale>` | `align`, `transcribe` | Automatic | Sets the transcription and text-segmentation language. |
| `--cache-dir <path>` | `align`, `transcribe` | `<output>.cache` | Overrides the resumable chunk cache directory. |
| `--max-chunk-minutes <number>` | `align`, `transcribe` | `30` | Sets the maximum technical chunk duration. |
| `--chunk-overlap-seconds <number>` | `align`, `transcribe` | `5` | Sets recognition context around chunk boundaries. |
| `--parallel-chunks <integer>` | `align`, `transcribe` | `1` | Limits concurrent transcription jobs. |
| `--retries <integer>` | `align`, `transcribe` | `2` | Sets retries after transient provider failures. |
| `--timestamp-backend <backend>` | `align`, `transcribe` | Determined by `--quality` | Uses `stable-ts` or `faster-whisper`. |
| `--interpolation <mode>` | `align` | Determined by `--quality` | Uses `off`, `conservative`, or `complete`. |
| `--srt` | `align` | Disabled | Writes UTF-8 SubRip files using ebook text. |
| `--progress-json` | `align`, `transcribe` | Disabled | Writes versioned progress objects to stderr. |
| `--json` | `validate` | Disabled | Writes the validation summary as JSON. |
| `--help`, `-h` | Global or command | — | Shows help. |
| `--version`, `-v` | Global | — | Prints the Honomiya version. |

## Generated results

| Result | Command | Default path | Contents |
| --- | --- | --- | --- |
| Read-and-listen manifest | `align` | `<ebook-stem>.honomiya.alignment.json` | Source identities and ordered sentence-to-audio cues using `honomiya.read-listen.v1`. |
| Alignment report | `align` | `<alignment-output>.report.json` | Revisions, settings, coverage, cue evidence and performance measurements. |
| SubRip subtitles | `align --srt` | `<audio-stem>.honomiya.srt` | Ebook text with aligned timestamps. |
| Reusable transcript | `transcribe` | `<audio-stem>.honomiya.transcript.json` | Provider provenance, speech regions, segments and word timestamps. |
| Chunk cache | `align`, `transcribe` | `<output>.cache` | Completed chunks and pending job IDs used for retries and resumability. |

## Behavior

- `--quality accurate` uses stable-ts timestamps and complete,
  speech-aware interpolation.
- `--quality fast` uses faster-whisper timestamps and conservative
  interpolation.
- `--provider` is explicit so Honomiya never uploads audio or incurs provider
  cost silently. `HONOMIYA_PROVIDER=modal` can set the default.
- For multi-track input, repeat `--audio` and `--transcript` in matching
  order. Partial transcript sets are rejected.
- Completed chunks and remote job IDs are cached. Repeating the command resumes
  available work instead of starting from zero.
- Ctrl-C stops new chunks, cancels active provider jobs when supported and exits
  with status 130.
