from pathlib import Path
import tempfile

import modal

APP_NAME = "honomiya-transcriber"
MODEL_ID = "large-v3"
MODEL_CACHE_PATH = "/models"
HOURS = 60 * 60
CUDA_IMAGE = "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04"

image = (
    modal.Image.from_registry(CUDA_IMAGE, add_python="3.12")
    .entrypoint([])
    .apt_install("ffmpeg")
    .uv_pip_install(
        "faster-whisper==1.2.1",
        "stable-ts-whisperless[fw]==2.19.1",
    )
)
model_cache = modal.Volume.from_name(
    "honomiya-whisper-models", create_if_missing=True
)
app = modal.App(APP_NAME)


@app.cls(
    image=image,
    gpu="L4",
    max_containers=2,
    scaledown_window=5 * 60,
    timeout=6 * HOURS,
    volumes={MODEL_CACHE_PATH: model_cache},
)
class HonomiyaTranscriber:
    @modal.enter()
    def load_model(self):
        from faster_whisper import WhisperModel

        self.model = WhisperModel(
            MODEL_ID,
            device="cuda",
            compute_type="float16",
            download_root=MODEL_CACHE_PATH,
        )
        self.stable_model = None

    def load_stable_model(self):
        if self.stable_model is None:
            import stable_whisper

            self.stable_model = stable_whisper.load_faster_whisper(
                MODEL_ID,
                device="cuda",
                compute_type="float16",
                download_root=MODEL_CACHE_PATH,
            )
        return self.stable_model

    @modal.method()
    def transcribe(
        self,
        audio_bytes: bytes,
        filename: str,
        language: str | None = None,
        offset_ms: int = 0,
        timestamp_backend: str = "faster-whisper",
    ) -> dict:
        if timestamp_backend not in {"faster-whisper", "stable-ts"}:
            raise ValueError(f"Unsupported timestamp backend: {timestamp_backend}")

        from faster_whisper.audio import decode_audio
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        suffix = Path(filename).suffix
        with tempfile.NamedTemporaryFile(suffix=suffix) as audio_file:
            audio_file.write(audio_bytes)
            audio_file.flush()
            sample_rate = 16_000
            audio = decode_audio(audio_file.name, sampling_rate=sample_rate)
            duration_ms = round(len(audio) * 1000 / sample_rate)
            vad_options = VadOptions()
            speech_timestamps = get_speech_timestamps(
                audio,
                vad_options=vad_options,
                sampling_rate=sample_rate,
            )
            speech_timeline = [
                {
                    "startMs": offset_ms
                    + round(region["start"] * 1000 / sample_rate),
                    "endMs": offset_ms
                    + round(region["end"] * 1000 / sample_rate),
                }
                for region in speech_timestamps
                if region["end"] > region["start"]
            ]

            if timestamp_backend == "stable-ts":
                result = self.load_stable_model().transcribe(
                    audio,
                    language=language,
                    beam_size=5,
                    vad=True,
                    word_timestamps=True,
                )
                raw_segments = result.segments
                detected_language = (
                    getattr(result, "language", None) or language or "unknown"
                )
                language_probability = None
            else:
                raw_segments, info = self.model.transcribe(
                    audio,
                    language=language,
                    beam_size=5,
                    vad_filter=True,
                    vad_parameters=vad_options,
                    word_timestamps=True,
                )
                detected_language = info.language
                language_probability = info.language_probability

            normalized_segments = []
            for segment_id, segment in enumerate(raw_segments):
                segment_start_ms = offset_ms + round(segment.start * 1000)
                segment_end_ms = offset_ms + round(segment.end * 1000)
                normalized_words = []
                for word in segment.words or []:
                    word_start_ms = max(
                        segment_start_ms,
                        offset_ms + round(word.start * 1000),
                    )
                    word_end_ms = min(
                        segment_end_ms,
                        offset_ms + round(word.end * 1000),
                    )
                    # Whisper can assign identical sub-millisecond boundaries
                    # to adjacent tokens. They cannot form a valid cue after
                    # integer conversion; the segment text remains available.
                    if word_end_ms <= word_start_ms:
                        continue
                    normalized_words.append(
                        {
                            "startMs": word_start_ms,
                            "endMs": word_end_ms,
                            "text": word.word,
                            **(
                                {"probability": getattr(word, "probability", None)}
                                if getattr(word, "probability", None) is not None
                                else {}
                            ),
                        }
                    )
                if segment_end_ms <= segment_start_ms:
                    continue
                normalized_segments.append(
                    {
                        "id": segment_id,
                        "startMs": segment_start_ms,
                        "endMs": segment_end_ms,
                        "text": segment.text.strip(),
                        "words": normalized_words,
                    }
                )

        return {
            "schema": "honomiya.transcript.v1",
            "engine": {
                "provider": "modal",
                "model": MODEL_ID,
                "timestampBackend": timestamp_backend,
            },
            "language": detected_language,
            **(
                {"languageProbability": language_probability}
                if language_probability is not None
                else {}
            ),
            "offsetMs": offset_ms,
            "durationMs": duration_ms,
            "speechTimeline": speech_timeline,
            "segments": normalized_segments,
        }
