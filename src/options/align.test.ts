import { describe, expect, test } from "bun:test";
import { AlignOptionsError, parseAlignOptions } from "./align";

const requiredArguments = [
	"--ebook",
	"book.epub",
	"--audio",
	"01.mp3",
	"--output",
	"alignment.json",
];

describe("align options", () => {
	test("parses an explicit Modal provider and ordered audio tracks", () => {
		expect(
			parseAlignOptions(
				[
					"--ebook",
					"book.epub",
					"--audio",
					"01.mp3",
					"--audio",
					"02.mp3",
					"--output",
					"alignment.json",
					"--provider",
					"modal",
					"--language",
					"es",
					"--cache-dir",
					"cache",
					"--max-chunk-minutes",
					"20",
					"--chunk-overlap-seconds",
					"6",
					"--retries",
					"4",
					"--parallel-chunks",
					"2",
					"--timestamp-backend",
					"stable-ts",
					"--interpolation",
					"complete",
				],
				{},
			),
		).toEqual({
			ebookPath: "book.epub",
			audioPaths: ["01.mp3", "02.mp3"],
			transcriptPaths: [],
			outputPath: "alignment.json",
			provider: "modal",
			language: "es",
			cacheDir: "cache",
			maxChunkDurationMs: 1_200_000,
			chunkOverlapMs: 6_000,
			maxRetries: 4,
			parallelChunks: 2,
			quality: "accurate",
			timestampBackend: "stable-ts",
			interpolationMode: "complete",
		});
	});

	test("defaults to accurate and supports a fast preset with explicit overrides", () => {
		const accurate = parseAlignOptions(requiredArguments, {
			HONOMIYA_PROVIDER: "modal",
		});
		expect(accurate.quality).toBe("accurate");
		expect(accurate.timestampBackend).toBe("stable-ts");
		expect(accurate.interpolationMode).toBe("complete");

		const fast = parseAlignOptions(
			[...requiredArguments, "--quality", "fast"],
			{ HONOMIYA_PROVIDER: "modal" },
		);
		expect(fast.quality).toBe("fast");
		expect(fast.timestampBackend).toBe("faster-whisper");
		expect(fast.interpolationMode).toBe("conservative");

		const overridden = parseAlignOptions(
			[
				...requiredArguments,
				"--quality",
				"fast",
				"--timestamp-backend",
				"stable-ts",
				"--interpolation",
				"off",
			],
			{ HONOMIYA_PROVIDER: "modal" },
		);
		expect(overridden.quality).toBe("fast");
		expect(overridden.timestampBackend).toBe("stable-ts");
		expect(overridden.interpolationMode).toBe("off");

		expect(() =>
			parseAlignOptions([...requiredArguments, "--quality", "maximum"], {
				HONOMIYA_PROVIDER: "modal",
			}),
		).toThrow("Unsupported quality preset: maximum");
	});

	test("validates interpolation modes and provider-only timestamp backends", () => {
		expect(() =>
			parseAlignOptions(
				[...requiredArguments, "--interpolation", "everything"],
				{ HONOMIYA_PROVIDER: "modal" },
			),
		).toThrow("Unsupported interpolation mode: everything");
		expect(() =>
			parseAlignOptions(
				[
					...requiredArguments,
					"--transcript",
					"track.json",
					"--timestamp-backend",
					"stable-ts",
				],
				{},
			),
		).toThrow("--timestamp-backend cannot be combined with --transcript");
	});

	test("rejects invalid parallel chunk counts", () => {
		expect(() =>
			parseAlignOptions([...requiredArguments, "--parallel-chunks", "0"], {
				HONOMIYA_PROVIDER: "modal",
			}),
		).toThrow("--parallel-chunks must be a positive integer");
	});

	test("allows HONOMIYA_PROVIDER when the flag is omitted", () => {
		expect(
			parseAlignOptions(requiredArguments, { HONOMIYA_PROVIDER: "modal" })
				.provider,
		).toBe("modal");
	});

	test("defaults output beside the ebook and accepts SRT generation", () => {
		const options = parseAlignOptions(
			[
				"--ebook",
				"/books/story.epub",
				"--audio",
				"/books/story.m4b",
				"--provider",
				"modal",
				"--srt",
			],
			{},
		);

		expect(options.outputPath).toBe("/books/story.honomiya.alignment.json");
		expect(options.srt).toBe(true);
	});

	test("requires an explicit provider when no environment default exists", () => {
		expect(() => parseAlignOptions(requiredArguments, {})).toThrow(
			"--provider is required",
		);
	});

	test("rejects unsupported providers before the pipeline runs", () => {
		expect(() =>
			parseAlignOptions([...requiredArguments, "--provider", "unknown"], {}),
		).toThrow(new AlignOptionsError("Unsupported provider: unknown"));
	});

	test("accepts one precomputed transcript for each ordered audio file", () => {
		expect(
			parseAlignOptions(
				[
					"--ebook",
					"book.epub",
					"--audio",
					"01.mp3",
					"--audio",
					"02.mp3",
					"--transcript",
					"01.json",
					"--transcript",
					"02.json",
					"--output",
					"alignment.json",
				],
				{},
			),
		).toEqual({
			ebookPath: "book.epub",
			audioPaths: ["01.mp3", "02.mp3"],
			transcriptPaths: ["01.json", "02.json"],
			outputPath: "alignment.json",
			quality: "accurate",
			interpolationMode: "complete",
		});
	});

	test("accepts one timed-text file per audio with conservative interpolation", () => {
		const options = parseAlignOptions(
			[
				"--ebook",
				"book.epub",
				"--audio",
				"01.m4b",
				"--audio",
				"02.m4b",
				"--timed-text",
				"01.srt",
				"--timed-text",
				"02.srt",
			],
			{},
		);
		expect(options).toMatchObject({
			audioPaths: ["01.m4b", "02.m4b"],
			transcriptPaths: [],
			timedTextPaths: ["01.srt", "02.srt"],
			interpolationMode: "conservative",
			minDirectCoverage: 0.8,
		});
	});

	test("configures timed-text edition and audio verification", () => {
		const options = parseAlignOptions(
			[
				...requiredArguments,
				"--timed-text",
				"track.srt",
				"--min-direct-coverage",
				"0.9",
				"--verify-provider",
				"local",
				"--verification-samples",
				"5",
			],
			{},
		);

		expect(options).toMatchObject({
			minDirectCoverage: 0.9,
			verificationProvider: "local",
			verificationSamples: 5,
		});
		expect(() =>
			parseAlignOptions([...requiredArguments, "--verify-provider", "modal"], {
				HONOMIYA_PROVIDER: "modal",
			}),
		).toThrow("--verify-provider requires --timed-text");
	});

	test("rejects ambiguous or unsupported timed-text combinations", () => {
		expect(() =>
			parseAlignOptions(
				[...requiredArguments, "--audio", "02.mp3", "--timed-text", "01.srt"],
				{},
			),
		).toThrow("number of --timed-text and --audio values must match");
		expect(() =>
			parseAlignOptions(
				[...requiredArguments, "--timed-text", "01.srt", "--provider", "modal"],
				{},
			),
		).toThrow("--provider cannot be combined with --timed-text");
		expect(() =>
			parseAlignOptions(
				[
					...requiredArguments,
					"--timed-text",
					"01.srt",
					"--interpolation",
					"complete",
				],
				{},
			),
		).toThrow("complete is unavailable with --timed-text");
	});

	test("rejects partial transcript sets and an ambiguous provider", () => {
		expect(() =>
			parseAlignOptions(
				[...requiredArguments, "--audio", "02.mp3", "--transcript", "01.json"],
				{},
			),
		).toThrow("number of --transcript and --audio values must match");
		expect(() =>
			parseAlignOptions(
				[
					...requiredArguments,
					"--transcript",
					"01.json",
					"--provider",
					"modal",
				],
				{},
			),
		).toThrow("--provider cannot be combined with --transcript");
	});
});

describe("CTC engine options", () => {
	test("needs no provider and selects the model from the language", () => {
		expect(
			parseAlignOptions(
				["--ebook", "b.epub", "--audio", "a.m4b", "--engine", "ctc", "--language", "ja", "--threads", "4"],
				{},
			),
		).toMatchObject({ engine: "ctc", ctcModel: "quartznet15x5-ja", threads: 4, transcriptPaths: [] });
	});

	test("infers the engine from precomputed emissions", () => {
		expect(
			parseAlignOptions(["--ebook", "b.epub", "--audio", "a.m4b", "--emissions", "a.emissions.bin"], {}),
		).toMatchObject({ engine: "ctc", emissionsPaths: ["a.emissions.bin"] });
	});

	test("rejects transcript-engine options", () => {
		const base = ["--ebook", "b.epub", "--audio", "a.m4b", "--engine", "ctc"];
		expect(() => parseAlignOptions([...base, "--provider", "modal"], {})).toThrow(/--provider cannot/);
		expect(() => parseAlignOptions([...base, "--timed-text", "a.srt"], {})).toThrow(/--timed-text cannot/);
		expect(() => parseAlignOptions([...base, "--quality", "fast"], {})).toThrow(/--quality cannot/);
		expect(() =>
			parseAlignOptions([...base, "--emissions", "x.bin", "--audio", "b.m4b"], {}),
		).toThrow(/--emissions and --audio/);
		expect(() =>
			parseAlignOptions(["--ebook", "b.epub", "--audio", "a.m4b", "--model", "quartznet15x5-ja"], {
				HONOMIYA_PROVIDER: "local",
			}),
		).toThrow(/requires --engine ctc/);
		expect(() => parseAlignOptions([...base.slice(0, 4), "--engine", "x"], {})).toThrow(/Unsupported engine/);
	});
});
