import argparse
import json
from pathlib import Path


def milliseconds(seconds: float, offset_ms: int) -> int:
    return offset_ms + round(seconds * 1000)


def transcribe(args: argparse.Namespace) -> dict:
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    sample_rate = 16_000
    audio = decode_audio(args.audio, sampling_rate=sample_rate)
    duration_ms = round(len(audio) * 1000 / sample_rate)
    vad_options = VadOptions()
    speech_timestamps = get_speech_timestamps(
        audio,
        vad_options=vad_options,
        sampling_rate=sample_rate,
    )
    speech_timeline = [
        {
            "startMs": args.offset_ms
            + round(region["start"] * 1000 / sample_rate),
            "endMs": args.offset_ms
            + round(region["end"] * 1000 / sample_rate),
        }
        for region in speech_timestamps
        if region["end"] > region["start"]
    ]

    model_options = {
        "device": args.device,
        "compute_type": args.compute_type,
    }
    if args.download_root:
        model_options["download_root"] = args.download_root

    if args.timestamp_backend == "stable-ts":
        import stable_whisper

        model = stable_whisper.load_faster_whisper(args.model, **model_options)
        result = model.transcribe(
            audio,
            language=args.language,
            beam_size=5,
            vad=True,
            word_timestamps=True,
        )
        raw_segments = result.segments
        detected_language = getattr(result, "language", None) or args.language or "unknown"
        language_probability = None
    else:
        model = WhisperModel(args.model, **model_options)
        raw_segments, info = model.transcribe(
            audio,
            language=args.language,
            beam_size=5,
            vad_filter=True,
            vad_parameters=vad_options,
            word_timestamps=True,
        )
        detected_language = info.language
        language_probability = info.language_probability

    segments = []
    for raw_segment in raw_segments:
        segment_start_ms = milliseconds(raw_segment.start, args.offset_ms)
        segment_end_ms = milliseconds(raw_segment.end, args.offset_ms)
        text = raw_segment.text.strip()
        if segment_end_ms <= segment_start_ms or not text:
            continue
        words = []
        for raw_word in raw_segment.words or []:
            word_start_ms = max(
                segment_start_ms,
                milliseconds(raw_word.start, args.offset_ms),
            )
            word_end_ms = min(
                segment_end_ms,
                milliseconds(raw_word.end, args.offset_ms),
            )
            word_text = raw_word.word
            if word_end_ms <= word_start_ms or not word_text:
                continue
            word = {
                "startMs": word_start_ms,
                "endMs": word_end_ms,
                "text": word_text,
            }
            probability = getattr(raw_word, "probability", None)
            if probability is not None:
                word["probability"] = probability
            words.append(word)
        segments.append(
            {
                "id": len(segments),
                "startMs": segment_start_ms,
                "endMs": segment_end_ms,
                "text": text,
                "words": words,
            }
        )

    transcript = {
        "schema": "honomiya.transcript.v1",
        "engine": {
            "provider": "local",
            "model": args.model,
            "timestampBackend": args.timestamp_backend,
        },
        "language": detected_language,
        "offsetMs": args.offset_ms,
        "durationMs": duration_ms,
        "speechTimeline": speech_timeline,
        "segments": segments,
    }
    if language_probability is not None:
        transcript["languageProbability"] = language_probability
    return transcript


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Honomiya local Whisper worker")
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--language")
    parser.add_argument("--offset-ms", required=True, type=int)
    parser.add_argument(
        "--timestamp-backend",
        choices=("faster-whisper", "stable-ts"),
        required=True,
    )
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--compute-type", required=True)
    parser.add_argument("--download-root")
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(transcribe(parse_args()), ensure_ascii=False))
