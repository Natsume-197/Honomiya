import { describe, expect, test } from "bun:test";
import { parseTranscribeOptions, TranscribeOptionsError } from "./transcribe";

describe("transcribe options", () => {
	test("parses an explicit provider and language", () => {
		expect(
			parseTranscribeOptions(
				[
					"--audio",
					"track.mp3",
					"--provider",
					"modal",
					"--output",
					"track.json",
					"--language",
					"es",
					"--cache-dir",
					"cache",
					"--max-chunk-minutes",
					"20",
					"--chunk-overlap-seconds",
					"7.5",
					"--retries",
					"3",
					"--parallel-chunks",
					"2",
					"--timestamp-backend",
					"stable-ts",
				],
				{},
			),
		).toEqual({
			audioPath: "track.mp3",
			provider: "modal",
			outputPath: "track.json",
			language: "es",
			cacheDir: "cache",
			maxChunkDurationMs: 1_200_000,
			chunkOverlapMs: 7_500,
			maxRetries: 3,
			parallelChunks: 2,
			quality: "accurate",
			timestampBackend: "stable-ts",
		});
	});

	test("defaults to accurate and resolves the fast preset", () => {
		const accurate = parseTranscribeOptions(["--audio", "track.mp3"], {
			HONOMIYA_PROVIDER: "modal",
		});
		expect(accurate.quality).toBe("accurate");
		expect(accurate.timestampBackend).toBe("stable-ts");

		const fast = parseTranscribeOptions(
			["--audio", "track.mp3", "--quality", "fast"],
			{ HONOMIYA_PROVIDER: "modal" },
		);
		expect(fast.quality).toBe("fast");
		expect(fast.timestampBackend).toBe("faster-whisper");
	});

	test("rejects an unsupported timestamp backend", () => {
		expect(() =>
			parseTranscribeOptions(
				["--audio", "track.mp3", "--timestamp-backend", "magic"],
				{ HONOMIYA_PROVIDER: "modal" },
			),
		).toThrow("Unsupported timestamp backend: magic");
	});

	test("rejects invalid parallel chunk counts", () => {
		for (const value of ["0", "-1", "1.5", "many"]) {
			expect(() =>
				parseTranscribeOptions(
					["--audio", "track.mp3", "--parallel-chunks", value],
					{ HONOMIYA_PROVIDER: "modal" },
				),
			).toThrow("--parallel-chunks must be a positive integer");
		}
	});

	test("accepts zero overlap and rejects fractional retries", () => {
		expect(
			parseTranscribeOptions(
				["--audio", "track.mp3", "--chunk-overlap-seconds", "0"],
				{ HONOMIYA_PROVIDER: "modal" },
			).chunkOverlapMs,
		).toBe(0);
		expect(() =>
			parseTranscribeOptions(["--audio", "track.mp3", "--retries", "1.5"], {
				HONOMIYA_PROVIDER: "modal",
			}),
		).toThrow("--retries must be a non-negative integer");
	});

	test("rejects an invalid chunk duration", () => {
		expect(() =>
			parseTranscribeOptions(
				[
					"--audio",
					"track.mp3",
					"--output",
					"track.json",
					"--max-chunk-minutes",
					"0",
				],
				{ HONOMIYA_PROVIDER: "modal" },
			),
		).toThrow("--max-chunk-minutes must be a positive number");
	});

	test("uses the provider environment default", () => {
		const options = parseTranscribeOptions(["--audio", "/books/track.mp3"], {
			HONOMIYA_PROVIDER: "modal",
		});

		expect(options.provider).toBe("modal");
		expect(options.outputPath).toBe("/books/track.honomiya.transcript.json");
	});

	test("rejects missing and duplicate inputs", () => {
		expect(() =>
			parseTranscribeOptions(["--output", "track.json"], {}),
		).toThrow(new TranscribeOptionsError("--audio is required"));
		expect(() =>
			parseTranscribeOptions(
				["--audio", "one.mp3", "--audio", "two.mp3", "--output", "track.json"],
				{ HONOMIYA_PROVIDER: "modal" },
			),
		).toThrow("--audio may only be provided once");
		expect(() =>
			parseTranscribeOptions(
				["--audio", "track.mp3", "--output", "track.mp3"],
				{ HONOMIYA_PROVIDER: "modal" },
			),
		).toThrow("--output must not overwrite --audio");
	});
});
