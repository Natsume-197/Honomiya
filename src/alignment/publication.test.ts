import { describe, expect, test } from "bun:test";
import type { EbookDocument } from "../ebook-parser/ebook";
import type { TranscriptionProvider } from "../transcription/provider";
import {
	HONOMIYA_TRANSCRIPT_SCHEMA,
	type HonomiyaTranscript,
} from "../transcription/transcript";
import { alignPublication } from "./publication";

function ebookDocument(
	onClose: () => void,
	openSection: () => Promise<
		{ html: string; styles: string[] } | undefined
	> = async () => ({
		html: "<p>Alpha begins. Omega ends.</p>",
		styles: [],
	}),
): EbookDocument {
	return {
		format: "epub",
		metadata: {
			identifier: "fixture",
			identifiers: [],
			title: "Fixture",
			subtitle: "",
			authors: [],
			publisher: "",
			language: "en",
			published: "",
			description: "",
			subjects: [],
			rights: "",
			contributors: [],
		},
		content: {
			kind: "html",
			sections: [{ id: "chapter" }],
			toc: [],
			openSection,
			openResource: async () => undefined,
		},
		openCover: async () => undefined,
		close: async () => onClose(),
	};
}

function transcript(): HonomiyaTranscript {
	return {
		schema: HONOMIYA_TRANSCRIPT_SCHEMA,
		engine: {
			provider: "fixture",
			model: "fixture",
			timestampBackend: "stable-ts",
		},
		source: { sha256: "b".repeat(64), filename: "track.mp3" },
		language: "en",
		offsetMs: 0,
		durationMs: 2_000,
		speechTimeline: [{ startMs: 0, endMs: 2_000 }],
		segments: [
			{
				id: 0,
				startMs: 0,
				endMs: 2_000,
				text: "alpha begins omega ends",
				words: ["alpha", "begins", "omega", "ends"].map((text, index) => ({
					text,
					startMs: index * 500,
					endMs: (index + 1) * 500,
				})),
			},
		],
	};
}

describe("publication alignment", () => {
	test("extracts and validates the ebook before starting provider work", async () => {
		let closed = false;
		let providerCreated = false;
		let audioProbed = false;
		let transcriptionStarted = false;
		const provider: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async () => transcript(),
		};

		await expect(
			alignPublication(
				{
					ebookPath: "/books/corrupt.epub",
					audioPaths: ["/books/track.mp3"],
					transcriptPaths: [],
					outputPath: "/output/alignment.json",
					provider: "modal",
				},
				{
					openEbook: async () =>
						ebookDocument(
							() => {
								closed = true;
							},
							async () => {
								throw new Error("corrupt ebook section");
							},
						),
					createProvider: () => {
						providerCreated = true;
						return provider;
					},
					transcribeAudio: async () => {
						transcriptionStarted = true;
						throw new Error("must not transcribe audio");
					},
					probeAudio: async () => {
						audioProbed = true;
						return { durationMs: 2_000, chapters: [] };
					},
					hashFile: async (path) =>
						path.endsWith(".epub") ? "a".repeat(64) : "b".repeat(64),
					readTranscript: async () => {
						throw new Error("must not read a transcript");
					},
					now: () => new Date("2026-08-08T12:00:00.000Z"),
				},
			),
		).rejects.toThrow("corrupt ebook section");

		expect(closed).toBe(true);
		expect(providerCreated).toBe(false);
		expect(audioProbed).toBe(false);
		expect(transcriptionStarted).toBe(false);
	});

	test("builds a validated manifest and an auditable report", async () => {
		let closed = false;
		let parallelChunks: number | undefined;
		let timestampBackend: string | undefined;
		const progress: unknown[] = [];
		const provider: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async () => transcript(),
		};
		const result = await alignPublication(
			{
				ebookPath: "/books/book.epub",
				audioPaths: ["/books/track.mp3"],
				transcriptPaths: [],
				outputPath: "/output/alignment.json",
				provider: "modal",
				parallelChunks: 2,
			},
			{
				openEbook: async () =>
					ebookDocument(() => {
						closed = true;
					}),
				createProvider: (_name, backend) => {
					timestampBackend = backend;
					return provider;
				},
				transcribeAudio: async (request) => {
					parallelChunks = request.parallelChunks;
					request.onProgress?.({
						chunk: 1,
						totalChunks: 1,
						completedChunks: 1,
						state: "completed",
					});
					return {
						transcript: transcript(),
						probe: { durationMs: 2_000, chapters: [] },
						chunks: 1,
						cacheHits: 0,
						resumedJobs: 0,
						retries: 0,
					};
				},
				probeAudio: async () => ({ durationMs: 2_000, chapters: [] }),
				hashFile: async (path) =>
					path.endsWith(".epub") ? "a".repeat(64) : "b".repeat(64),
				readTranscript: async () => {
					throw new Error("must not read a transcript");
				},
				now: () => new Date("2026-08-08T12:00:00.000Z"),
			},
			{ onProgress: (event) => progress.push(event) },
		);

		expect(result.manifest.cues).toHaveLength(2);
		expect(result.manifest.transcription).toEqual({ origin: "honomiya" });
		expect(result.manifest.sources.audioFiles[0]?.durationMs).toBe(2_000);
		expect(result.report.transcription).toEqual({
			mode: "provider",
			provider: { name: "modal", revision: "fixture-v1" },
			sources: [
				{
					audioFileIndex: 0,
					provider: "fixture",
					model: "fixture",
					timestampBackend: "stable-ts",
					chunks: 1,
					cacheHits: 0,
					resumedJobs: 0,
					retries: 0,
					parallelChunks: 2,
				},
			],
		});
		expect(parallelChunks).toBe(2);
		expect(timestampBackend).toBe("stable-ts");
		expect(result.report.parameters.quality).toBe("accurate");
		expect(result.report.parameters.interpolationMode).toBe("complete");
		expect(result.report.parameters.chapterNgramSize).toBe(5);
		expect(result.report.alignment.bookCoverage).toBe(1);
		expect(closed).toBe(true);
		expect(progress).toEqual([
			expect.objectContaining({
				sourceIndex: 0,
				totalSources: 1,
				overallCompletedChunks: 1,
				overallTotalChunks: 1,
			}),
		]);
	});

	test("reuses a validated transcript without creating a provider", async () => {
		let closed = false;
		let readPath = "";
		const result = await alignPublication(
			{
				ebookPath: "/books/book.epub",
				audioPaths: ["/books/track.mp3"],
				transcriptPaths: ["/cache/track.json"],
				outputPath: "/output/alignment.json",
			},
			{
				openEbook: async () =>
					ebookDocument(() => {
						closed = true;
					}),
				createProvider: () => {
					throw new Error("must not create a provider");
				},
				transcribeAudio: async () => {
					throw new Error("must not transcribe audio");
				},
				probeAudio: async () => {
					throw new Error("must not probe audio");
				},
				hashFile: async (path) =>
					path.endsWith(".epub") ? "a".repeat(64) : "b".repeat(64),
				readTranscript: async (path) => {
					readPath = path;
					return transcript();
				},
				now: () => new Date("2026-08-08T12:00:00.000Z"),
			},
		);

		expect(readPath).toBe("/cache/track.json");
		expect(result.report.transcription.mode).toBe("precomputed");
		expect(result.manifest.transcription).toEqual({ origin: "honomiya" });
		expect(result.manifest.cues).toHaveLength(2);
		expect(closed).toBe(true);
	});

	test("aligns from SRT timed text without creating a provider", async () => {
		let readPath = "";
		let probedPath = "";
		const result = await alignPublication(
			{
				ebookPath: "/books/book.epub",
				audioPaths: ["/books/track.mp3"],
				transcriptPaths: [],
				timedTextPaths: ["/subs/track.srt"],
				outputPath: "/output/alignment.json",
			},
			{
				openEbook: async () => ebookDocument(() => undefined),
				createProvider: () => {
					throw new Error("must not create a provider");
				},
				transcribeAudio: async () => {
					throw new Error("must not transcribe audio");
				},
				probeAudio: async (path) => {
					probedPath = path;
					return { durationMs: 2_000, chapters: [] };
				},
				hashFile: async (path) =>
					path.endsWith(".epub")
						? "a".repeat(64)
						: path.endsWith(".srt")
							? "c".repeat(64)
							: "b".repeat(64),
				readTranscript: async () => {
					throw new Error("must not read a transcript");
				},
				readTimedText: async (path) => {
					readPath = path;
					return "1\n00:00:00,000 --> 00:00:02,000\nAlpha begins. Omega ends.\n";
				},
				now: () => new Date("2026-08-08T12:00:00.000Z"),
			},
		);

		expect(readPath).toBe("/subs/track.srt");
		expect(probedPath).toBe("/books/track.mp3");
		expect(result.manifest.cues).toHaveLength(2);
		expect(result.manifest.transcription).toEqual({ origin: "external" });
		expect(result.report.parameters.interpolationMode).toBe("conservative");
		expect(result.report.transcription).toMatchObject({
			mode: "timed-text",
			sources: [
				{
					audioFileIndex: 0,
					provider: "timed-text",
					model: "srt",
				},
			],
			timedText: [
				{
					filename: "track.srt",
					sha256: "c".repeat(64),
					totalCues: 1,
					usedCues: 1,
					excludedCues: 0,
				},
			],
		});
	});

	test("rejects timed text from an incompatible ebook edition", async () => {
		await expect(
			alignPublication(
				{
					ebookPath: "/books/book.epub",
					audioPaths: ["/books/track.mp3"],
					transcriptPaths: [],
					timedTextPaths: ["/subs/track.srt"],
					outputPath: "/output/alignment.json",
					minDirectCoverage: 0.8,
				},
				{
					openEbook: async () => ebookDocument(() => undefined),
					createProvider: () => {
						throw new Error("must not create a provider");
					},
					transcribeAudio: async () => {
						throw new Error("must not transcribe audio");
					},
					probeAudio: async () => ({ durationMs: 2_000, chapters: [] }),
					hashFile: async (path) =>
						path.endsWith(".epub")
							? "a".repeat(64)
							: path.endsWith(".srt")
								? "c".repeat(64)
								: "b".repeat(64),
					readTranscript: async () => undefined,
					readTimedText: async () =>
						"1\n00:00:00,000 --> 00:00:02,000\nCompletely different words.\n",
					now: () => new Date("2026-08-08T12:00:00.000Z"),
				},
			),
		).rejects.toThrow("may be different editions");
	});

	test("rejects timed text whose acoustic samples do not match the audio", async () => {
		const verifierProvider: TranscriptionProvider = {
			name: "local",
			revision: "fixture-verifier-v1",
			transcribe: async () => transcript(),
		};
		await expect(
			alignPublication(
				{
					ebookPath: "/books/book.epub",
					audioPaths: ["/books/track.mp3"],
					transcriptPaths: [],
					timedTextPaths: ["/subs/track.srt"],
					outputPath: "/output/alignment.json",
					verificationProvider: "local",
				},
				{
					openEbook: async () => ebookDocument(() => undefined),
					createProvider: () => verifierProvider,
					transcribeAudio: async () => {
						throw new Error("must not transcribe full audio");
					},
					probeAudio: async () => ({ durationMs: 2_000, chapters: [] }),
					hashFile: async (path) =>
						path.endsWith(".epub")
							? "a".repeat(64)
							: path.endsWith(".srt")
								? "c".repeat(64)
								: "b".repeat(64),
					readTranscript: async () => undefined,
					readTimedText: async () =>
						"1\n00:00:00,000 --> 00:00:02,000\nAlpha begins. Omega ends.\n",
					verifyTimedText: async () => ({
						provider: { name: "local", revision: "fixture-verifier-v1" },
						status: "failed",
						confidence: "low",
						averageScore: 0.1,
						passingSamples: 0,
						totalSamples: 1,
						samples: [],
					}),
					now: () => new Date("2026-08-08T12:00:00.000Z"),
				},
			),
		).rejects.toThrow("Timed-text verification failed");
	});

	test("rejects a transcript produced from different audio bytes", async () => {
		const mismatched = transcript();
		mismatched.source = {
			sha256: "c".repeat(64),
			filename: "different.mp3",
		};

		await expect(
			alignPublication(
				{
					ebookPath: "/books/book.epub",
					audioPaths: ["/books/track.mp3"],
					transcriptPaths: ["/cache/track.json"],
					outputPath: "/output/alignment.json",
				},
				{
					openEbook: async () => ebookDocument(() => undefined),
					createProvider: () => {
						throw new Error("must not create a provider");
					},
					transcribeAudio: async () => {
						throw new Error("must not transcribe audio");
					},
					probeAudio: async () => {
						throw new Error("must not probe audio");
					},
					hashFile: async (path) =>
						path.endsWith(".epub") ? "a".repeat(64) : "b".repeat(64),
					readTranscript: async () => mismatched,
					now: () => new Date("2026-08-08T12:00:00.000Z"),
				},
			),
		).rejects.toThrow("does not match audio /books/track.mp3");
	});
});
