import { describe, expect, test } from "bun:test";
import { HONOMIYA_MANIFEST_SCHEMA } from "../artifacts/manifest";
import { runCli } from "./app";
import type { CliCommands, CliIO } from "./types";

function createIO(contents = "") {
	let stdout = "";
	let stderr = "";
	const io: CliIO = {
		readText: async () => contents,
		writeStdout: (message) => {
			stdout += message;
		},
		writeStderr: (message) => {
			stderr += message;
		},
	};
	return {
		io,
		stdout: () => stdout,
		stderr: () => stderr,
	};
}

function validManifestJson() {
	return JSON.stringify({
		schema: HONOMIYA_MANIFEST_SCHEMA,
		createdAt: "2026-08-08T15:00:00.000Z",
		generator: { name: "honomiya", version: "0.1.0" },
		granularity: "sentence",
		sources: {
			ebook: { sha256: "a".repeat(64) },
			audioFiles: [{ index: 0, sha256: "b".repeat(64) }],
		},
		cues: [],
	});
}

describe("Honomiya CLI", () => {
	test("prints help", async () => {
		const output = createIO();

		expect(await runCli(["--help"], output.io)).toBe(0);
		expect(output.stdout()).toContain("honomiya validate");
		expect(output.stderr()).toBe("");
	});

	test("prints command-specific help without running a command", async () => {
		const output = createIO();

		expect(await runCli(["transcribe", "--help"], output.io)).toBe(0);
		expect(output.stdout()).toContain("honomiya transcribe --audio");
		expect(output.stdout()).toContain("--quality <accurate|fast>");
		expect(output.stderr()).toBe("");
	});

	test("validates a manifest with a machine-readable summary", async () => {
		const output = createIO(validManifestJson());

		expect(
			await runCli(["validate", "alignment.json", "--json"], output.io),
		).toBe(0);
		expect(JSON.parse(output.stdout())).toEqual({
			schema: HONOMIYA_MANIFEST_SCHEMA,
			granularity: "sentence",
			audioFiles: 1,
			cues: 0,
		});
	});

	test("reports schema failures without throwing", async () => {
		const output = createIO("{}");

		expect(await runCli(["validate", "alignment.json"], output.io)).toBe(1);
		expect(output.stderr()).toContain("Invalid Honomiya manifest");
	});

	test("uses exit code 2 for a usage error", async () => {
		const output = createIO();

		expect(await runCli(["validate"], output.io)).toBe(2);
		expect(output.stderr()).toContain("Usage: honomiya validate");
	});

	test("runs the complete align command with an explicit provider", async () => {
		const output = createIO();
		let receivedProvider = "";
		let receivedQuality = "";
		const commands: CliCommands = {
			align: async (options) => {
				receivedProvider = options.provider ?? "";
				receivedQuality = options.quality ?? "";
				return {
					bookSentences: 2,
					directCues: 1,
					interpolatedCues: 1,
					unmatchedSentences: 0,
					bookCoverage: 1,
					directCoverage: 0.5,
					unmatchedAudioFiles: [],
					chapters: [],
				};
			},
		};

		expect(
			await runCli(
				[
					"align",
					"--ebook",
					"book.epub",
					"--audio",
					"track.mp3",
					"--provider",
					"modal",
					"--output",
					"alignment.json",
				],
				output.io,
				commands,
				{},
			),
		).toBe(0);
		expect(receivedProvider).toBe("modal");
		expect(receivedQuality).toBe("accurate");
		expect(output.stdout()).toContain("Aligned 2/2 sentences");
	});

	test("emits versioned JSON progress for machine consumers", async () => {
		const output = createIO();
		const commands: CliCommands = {
			align: async (_options, controls) => {
				controls?.onProgress?.({
					sourceIndex: 1,
					totalSources: 2,
					chunk: 3,
					totalChunks: 4,
					completedChunks: 2,
					state: "completed",
				});
				return {
					bookSentences: 0,
					directCues: 0,
					interpolatedCues: 0,
					unmatchedSentences: 0,
					bookCoverage: 0,
					directCoverage: 0,
					unmatchedAudioFiles: [],
					chapters: [],
				};
			},
		};

		expect(
			await runCli(
				[
					"align",
					"--ebook",
					"book.epub",
					"--audio",
					"track.mp3",
					"--provider",
					"modal",
					"--progress-json",
				],
				output.io,
				commands,
				{},
			),
		).toBe(0);
		expect(JSON.parse(output.stderr())).toEqual({
			schema: "honomiya.progress.v1",
			phase: "transcribe",
			sourceIndex: 1,
			totalSources: 2,
			chunk: 3,
			sourceChunks: 4,
			totalChunks: 4,
			completedChunks: 2,
			state: "completed",
		});
	});

	test("rejects align without a provider before invoking the pipeline", async () => {
		const output = createIO();
		let invoked = false;
		const commands: CliCommands = {
			align: async () => {
				invoked = true;
				throw new Error("must not run");
			},
		};

		expect(
			await runCli(
				[
					"align",
					"--ebook",
					"book.epub",
					"--audio",
					"track.mp3",
					"--output",
					"alignment.json",
				],
				output.io,
				commands,
				{},
			),
		).toBe(2);
		expect(invoked).toBe(false);
		expect(output.stderr()).toContain("--provider is required");
	});

	test("transcribes one audio track with the selected provider", async () => {
		const output = createIO();
		let receivedAudio = "";
		let receivedTimestampBackend = "";
		const commands: CliCommands = {
			align: async () => {
				throw new Error("must not align");
			},
			transcribe: async (options) => {
				receivedAudio = options.audioPath;
				receivedTimestampBackend = options.timestampBackend ?? "";
				return {
					provider: { name: "modal", revision: "fixture-v1" },
					chunks: 1,
					cacheHits: 0,
					resumedJobs: 0,
					retries: 0,
					transcript: {
						schema: "honomiya.transcript.v1",
						engine: { provider: "modal", model: "large-v3" },
						language: "es",
						offsetMs: 0,
						durationMs: 1_000,
						segments: [],
					},
				};
			},
		};

		expect(
			await runCli(
				[
					"transcribe",
					"--audio",
					"track.mp3",
					"--provider",
					"modal",
					"--output",
					"track.json",
				],
				output.io,
				commands,
				{},
			),
		).toBe(0);
		expect(receivedAudio).toBe("track.mp3");
		expect(receivedTimestampBackend).toBe("stable-ts");
		expect(output.stdout()).toContain("Transcribed 1000 ms");
	});

	test("aligns from a transcript without requiring a provider", async () => {
		const output = createIO();
		let transcriptPaths: string[] = [];
		const commands: CliCommands = {
			align: async (options) => {
				transcriptPaths = options.transcriptPaths;
				return {
					bookSentences: 0,
					directCues: 0,
					interpolatedCues: 0,
					unmatchedSentences: 0,
					bookCoverage: 0,
					directCoverage: 0,
					unmatchedAudioFiles: [],
					chapters: [],
				};
			},
		};

		expect(
			await runCli(
				[
					"align",
					"--ebook",
					"book.epub",
					"--audio",
					"track.mp3",
					"--transcript",
					"track.json",
					"--output",
					"alignment.json",
				],
				output.io,
				commands,
				{},
			),
		).toBe(0);
		expect(transcriptPaths).toEqual(["track.json"]);
	});
});
