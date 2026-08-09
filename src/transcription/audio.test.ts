import { describe, expect, test } from "bun:test";
import { type TranscribeAudioDependencies, transcribeAudio } from "./audio";
import type { AudioChunk } from "./chunks";
import type { TranscriptionProvider } from "./provider";
import {
	HONOMIYA_TRANSCRIPT_SCHEMA,
	type HonomiyaTranscript,
} from "./transcript";

function chunkTranscript(
	offsetMs: number,
	durationMs: number,
): HonomiyaTranscript {
	return {
		schema: HONOMIYA_TRANSCRIPT_SCHEMA,
		engine: {
			provider: "modal",
			model: "large-v3",
			revision: "fixture-v1",
		},
		language: "ja",
		offsetMs,
		durationMs,
		segments: [
			{
				id: 0,
				startMs: offsetMs,
				endMs: offsetMs + durationMs,
				text: `chunk ${offsetMs}`,
				words: [],
			},
		],
	};
}

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("chunked audio transcription", () => {
	test("caches completed chunks and merges their global timestamps", async () => {
		const cache = new Map<string, unknown>();
		const extracted: AudioChunk[] = [];
		const requests: number[] = [];
		let removals = 0;
		const provider: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async (request) => {
				const offsetMs = request.offsetMs ?? 0;
				requests.push(offsetMs);
				return chunkTranscript(offsetMs, offsetMs === 1_666 ? 834 : 833);
			},
		};
		const dependencies: TranscribeAudioDependencies = {
			probe: async () => ({ durationMs: 2_500, chapters: [] }),
			extract: async (_input, chunk) => {
				extracted.push(chunk);
			},
			readCache: async (path) => cache.get(path),
			writeCache: async (path, value) => {
				cache.set(path, value);
			},
			removeCache: async (path) => {
				cache.delete(path);
			},
			makeTemporaryDirectory: async () => "/tmp/honomiya-fixture",
			removeTemporaryDirectory: async () => {
				removals += 1;
			},
		};
		const request = {
			audioPath: "/books/book.m4b",
			audioSha256: "a".repeat(64),
			language: "ja",
			cacheDir: "/cache",
			maxChunkDurationMs: 1_000,
			provider,
		};

		const first = await transcribeAudio(request, dependencies);
		expect(first.chunks).toBe(3);
		expect(first.cacheHits).toBe(0);
		expect(requests).toEqual([0, 625, 1_458]);
		expect(extracted).toHaveLength(3);
		expect(first.transcript.source?.sha256).toBe("a".repeat(64));
		expect(first.transcript.durationMs).toBe(2_500);
		expect(first.transcript.segments.map((segment) => segment.id)).toEqual([
			0, 1, 2,
		]);

		requests.length = 0;
		extracted.length = 0;
		const second = await transcribeAudio(request, dependencies);
		expect(second.cacheHits).toBe(3);
		expect(requests).toEqual([]);
		expect(extracted).toEqual([]);
		expect(removals).toBe(1);
	});

	test("uses overlapped recognition context but emits each boundary word once", async () => {
		const provider: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async (request) => {
				const offsetMs = request.offsetMs ?? 0;
				const words =
					offsetMs === 0
						? [
								{ text: "before", startMs: 8_000, endMs: 9_000 },
								{ text: "boundary", startMs: 9_000, endMs: 11_000 },
							]
						: [
								{ text: "boundary", startMs: 9_000, endMs: 11_000 },
								{ text: "after", startMs: 11_000, endMs: 12_000 },
							];
				return {
					schema: HONOMIYA_TRANSCRIPT_SCHEMA,
					engine: {
						provider: "modal",
						model: "large-v3",
						revision: "fixture-v1",
					},
					language: "en",
					offsetMs,
					durationMs: offsetMs === 0 ? 12_000 : 12_000,
					speechTimeline:
						offsetMs === 0
							? [{ startMs: 8_000, endMs: 11_000 }]
							: [{ startMs: 9_000, endMs: 12_000 }],
					segments: [
						{
							id: 0,
							startMs: words[0]?.startMs ?? offsetMs,
							endMs: words.at(-1)?.endMs ?? offsetMs + 1,
							text: words.map((word) => word.text).join(" "),
							words,
						},
					],
				};
			},
		};
		const cache = new Map<string, unknown>();
		const result = await transcribeAudio(
			{
				audioPath: "/books/book.m4b",
				audioSha256: "b".repeat(64),
				cacheDir: "/cache",
				maxChunkDurationMs: 10_000,
				chunkOverlapMs: 2_000,
				provider,
			},
			{
				probe: async () => ({ durationMs: 20_000, chapters: [] }),
				extract: async () => undefined,
				readCache: async (path) => cache.get(path),
				writeCache: async (path, value) => {
					cache.set(path, value);
				},
				removeCache: async (path) => {
					cache.delete(path);
				},
				makeTemporaryDirectory: async () => "/tmp/honomiya-overlap",
				removeTemporaryDirectory: async () => undefined,
			},
		);

		expect(
			result.transcript.segments.flatMap((segment) =>
				segment.words.map((word) => word.text),
			),
		).toEqual(["before", "boundary", "after"]);
		expect(result.transcript.segments[1]?.startMs).toBe(10_000);
		expect(result.transcript.speechTimeline).toEqual([
			{ startMs: 8_000, endMs: 12_000 },
		]);
	});

	test("limits parallel work and merges chunks by timeline, not completion order", async () => {
		const cache = new Map<string, unknown>();
		const startedTwo = deferred();
		const startedThree = deferred();
		const startedFour = deferred();
		const releases = new Map<number, () => void>();
		const startedOffsets: number[] = [];
		const completedOffsets: number[] = [];
		const completedCounts: number[] = [];
		let active = 0;
		let maxActive = 0;
		let temporaryDirectories = 0;
		const provider: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async (request) => {
				const offsetMs = request.offsetMs ?? 0;
				const release = deferred();
				releases.set(offsetMs, release.resolve);
				startedOffsets.push(offsetMs);
				active += 1;
				maxActive = Math.max(maxActive, active);
				if (startedOffsets.length === 2) startedTwo.resolve();
				if (startedOffsets.length === 3) startedThree.resolve();
				if (startedOffsets.length === 4) startedFour.resolve();
				await release.promise;
				active -= 1;
				completedOffsets.push(offsetMs);
				return chunkTranscript(offsetMs, 1_000);
			},
		};
		const running = transcribeAudio(
			{
				audioPath: "/books/book.m4b",
				audioSha256: "f".repeat(64),
				cacheDir: "/cache",
				maxChunkDurationMs: 1_000,
				chunkOverlapMs: 0,
				parallelChunks: 2,
				onProgress: (progress) => {
					if (progress.state === "completed") {
						completedCounts.push(progress.completedChunks);
					}
				},
				provider,
			},
			{
				probe: async () => ({ durationMs: 4_000, chapters: [] }),
				extract: async () => undefined,
				readCache: async (path) => cache.get(path),
				writeCache: async (path, value) => {
					cache.set(path, value);
				},
				removeCache: async (path) => {
					cache.delete(path);
				},
				makeTemporaryDirectory: async () => {
					temporaryDirectories += 1;
					return "/tmp/honomiya-parallel";
				},
				removeTemporaryDirectory: async () => undefined,
			},
		);

		await startedTwo.promise;
		expect(startedOffsets).toEqual([0, 1_000]);
		expect(maxActive).toBe(2);
		releases.get(1_000)?.();
		await startedThree.promise;
		releases.get(2_000)?.();
		await startedFour.promise;
		releases.get(3_000)?.();
		releases.get(0)?.();

		const result = await running;
		expect(completedOffsets).toEqual([1_000, 2_000, 3_000, 0]);
		expect(completedCounts).toEqual([1, 2, 3, 4]);
		expect(maxActive).toBe(2);
		expect(temporaryDirectories).toBe(1);
		expect(
			result.transcript.segments.map((segment) => segment.startMs),
		).toEqual([0, 1_000, 2_000, 3_000]);
	});

	test("cancels every active parallel provider job on abort", async () => {
		const cache = new Map<string, unknown>();
		const controller = new AbortController();
		const startedTwo = deferred();
		const startedJobs: string[] = [];
		const cancelledJobs: string[] = [];
		const provider: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async (request) => {
				const id = `fc-${request.offsetMs ?? 0}`;
				await request.onJobStarted?.({ provider: "modal", id });
				startedJobs.push(id);
				if (startedJobs.length === 2) startedTwo.resolve();
				return new Promise((_, reject) => {
					request.signal?.addEventListener(
						"abort",
						() => {
							const error = new Error("Transcription cancelled");
							error.name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				});
			},
			cancel: async (job) => {
				cancelledJobs.push(job.id);
			},
		};
		const running = transcribeAudio(
			{
				audioPath: "/books/book.m4b",
				audioSha256: "0".repeat(64),
				cacheDir: "/cache",
				maxChunkDurationMs: 1_000,
				chunkOverlapMs: 0,
				parallelChunks: 2,
				provider,
				signal: controller.signal,
			},
			{
				probe: async () => ({ durationMs: 3_000, chapters: [] }),
				extract: async () => undefined,
				readCache: async (path) => cache.get(path),
				writeCache: async (path, value) => {
					cache.set(path, value);
				},
				removeCache: async (path) => {
					cache.delete(path);
				},
				makeTemporaryDirectory: async () => "/tmp/honomiya-parallel-cancel",
				removeTemporaryDirectory: async () => undefined,
			},
		);

		await startedTwo.promise;
		controller.abort();
		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		expect(startedJobs).toEqual(["fc-0", "fc-1000"]);
		expect(cancelledJobs.sort()).toEqual(["fc-0", "fc-1000"]);
		expect(cache.size).toBe(0);
	});

	test("persists a Modal job id and reattaches after a failed process", async () => {
		const cache = new Map<string, unknown>();
		const dependencies: TranscribeAudioDependencies = {
			probe: async () => ({ durationMs: 1_000, chapters: [] }),
			extract: async () => undefined,
			readCache: async (path) => cache.get(path),
			writeCache: async (path, value) => {
				cache.set(path, value);
			},
			removeCache: async (path) => {
				cache.delete(path);
			},
			makeTemporaryDirectory: async () => "/tmp/honomiya-resume",
			removeTemporaryDirectory: async () => undefined,
		};
		const baseRequest = {
			audioPath: "/books/book.m4b",
			audioSha256: "c".repeat(64),
			cacheDir: "/cache",
			maxRetries: 0,
		};
		const interrupted: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async (request) => {
				await request.onJobStarted?.({ provider: "modal", id: "fc-pending" });
				throw new Error("connection lost");
			},
			resume: async () => {
				throw new Error("not reached in the first process");
			},
		};
		await expect(
			transcribeAudio({ ...baseRequest, provider: interrupted }, dependencies),
		).rejects.toThrow("connection lost");

		let resumedId = "";
		const resumed: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async () => {
				throw new Error("must not upload the audio twice");
			},
			resume: async (job) => {
				resumedId = job.id;
				return chunkTranscript(0, 1_000);
			},
		};
		const result = await transcribeAudio(
			{ ...baseRequest, provider: resumed },
			dependencies,
		);

		expect(resumedId).toBe("fc-pending");
		expect(result.resumedJobs).toBe(1);
		expect(result.cacheHits).toBe(0);
	});

	test("retries by reattaching instead of spawning a duplicate provider job", async () => {
		const cache = new Map<string, unknown>();
		let submissions = 0;
		let resumes = 0;
		const provider: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async (request) => {
				submissions += 1;
				await request.onJobStarted?.({ provider: "modal", id: "fc-retry" });
				throw new Error("temporary transport failure");
			},
			resume: async () => {
				resumes += 1;
				return chunkTranscript(0, 1_000);
			},
		};
		const result = await transcribeAudio(
			{
				audioPath: "/books/book.m4b",
				audioSha256: "d".repeat(64),
				cacheDir: "/cache",
				maxRetries: 1,
				provider,
			},
			{
				probe: async () => ({ durationMs: 1_000, chapters: [] }),
				extract: async () => undefined,
				readCache: async (path) => cache.get(path),
				writeCache: async (path, value) => {
					cache.set(path, value);
				},
				removeCache: async (path) => {
					cache.delete(path);
				},
				makeTemporaryDirectory: async () => "/tmp/honomiya-retry",
				removeTemporaryDirectory: async () => undefined,
			},
		);

		expect(submissions).toBe(1);
		expect(resumes).toBe(1);
		expect(result.retries).toBe(1);
		expect(result.resumedJobs).toBe(1);
	});

	test("cancels the active remote job and clears its pending record", async () => {
		const cache = new Map<string, unknown>();
		const controller = new AbortController();
		let cancelled = "";
		const provider: TranscriptionProvider = {
			name: "modal",
			revision: "fixture-v1",
			transcribe: async (request) => {
				await request.onJobStarted?.({ provider: "modal", id: "fc-cancel" });
				controller.abort();
				const error = new Error("Transcription cancelled");
				error.name = "AbortError";
				throw error;
			},
			cancel: async (job) => {
				cancelled = job.id;
			},
		};
		await expect(
			transcribeAudio(
				{
					audioPath: "/books/book.m4b",
					audioSha256: "e".repeat(64),
					cacheDir: "/cache",
					provider,
					signal: controller.signal,
				},
				{
					probe: async () => ({ durationMs: 1_000, chapters: [] }),
					extract: async () => undefined,
					readCache: async (path) => cache.get(path),
					writeCache: async (path, value) => {
						cache.set(path, value);
					},
					removeCache: async (path) => {
						cache.delete(path);
					},
					makeTemporaryDirectory: async () => "/tmp/honomiya-cancel",
					removeTemporaryDirectory: async () => undefined,
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });

		expect(cancelled).toBe("fc-cancel");
		expect(cache.size).toBe(0);
	});
});
