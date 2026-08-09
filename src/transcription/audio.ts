import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeJsonAtomically } from "../support/json-file";
import {
	type AudioChunk,
	type AudioProbe,
	chunkExtension,
	DEFAULT_CHUNK_OVERLAP_MS,
	DEFAULT_MAX_CHUNK_DURATION_MS,
	extractAudioChunk,
	planAudioChunks,
	probeAudio,
} from "./chunks";
import type { TranscriptionJob, TranscriptionProvider } from "./provider";
import {
	HONOMIYA_TRANSCRIPT_SCHEMA,
	type HonomiyaTranscript,
	parseHonomiyaTranscript,
} from "./transcript";

const TRANSCRIPTION_CACHE_VERSION = "honomiya.transcription-cache.v3";
const PENDING_JOB_SCHEMA = "honomiya.pending-transcription.v1";
const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_PARALLEL_CHUNKS = 1;

export interface TranscribeAudioRequest {
	audioPath: string;
	audioSha256: string;
	/** Reuse a publication-level preflight probe when one is available. */
	probe?: AudioProbe;
	language?: string;
	cacheDir: string;
	maxChunkDurationMs?: number;
	chunkOverlapMs?: number;
	maxRetries?: number;
	parallelChunks?: number;
	signal?: AbortSignal;
	onProgress?: (progress: TranscriptionProgress) => void;
	provider: TranscriptionProvider;
}

export interface TranscriptionControls {
	signal?: AbortSignal;
	onProgress?: (progress: TranscriptionProgress) => void;
}

export interface TranscriptionProgress {
	/** Zero-based source index when progress is forwarded by `align`. */
	sourceIndex?: number;
	/** Total ordered audio sources when progress is forwarded by `align`. */
	totalSources?: number;
	/** Completed chunks across every ordered source when forwarded by `align`. */
	overallCompletedChunks?: number;
	/** Planned chunks across every ordered source when forwarded by `align`. */
	overallTotalChunks?: number;
	chunk: number;
	totalChunks: number;
	completedChunks: number;
	state: "cached" | "starting" | "resuming" | "retrying" | "completed";
	attempt?: number;
}

export interface TranscribeAudioResult {
	transcript: HonomiyaTranscript;
	probe: AudioProbe;
	chunks: number;
	cacheHits: number;
	resumedJobs: number;
	retries: number;
}

export interface TranscribeAudioDependencies {
	probe(path: string): Promise<AudioProbe>;
	extract(
		inputPath: string,
		chunk: AudioChunk,
		outputPath: string,
	): Promise<void>;
	readCache(path: string): Promise<unknown | undefined>;
	writeCache(path: string, value: unknown): Promise<void>;
	removeCache(path: string): Promise<void>;
	makeTemporaryDirectory(): Promise<string>;
	removeTemporaryDirectory(path: string): Promise<void>;
}

const runtimeDependencies: TranscribeAudioDependencies = {
	probe: probeAudio,
	extract: extractAudioChunk,
	readCache: async (path) => {
		const file = Bun.file(path);
		if (!(await file.exists())) return undefined;
		try {
			return JSON.parse(await file.text());
		} catch (error) {
			if (error instanceof SyntaxError) return undefined;
			throw error;
		}
	},
	writeCache: writeJsonAtomically,
	removeCache: (path) => rm(path, { force: true }),
	makeTemporaryDirectory: () => mkdtemp(join(tmpdir(), "honomiya-")),
	removeTemporaryDirectory: (path) =>
		rm(path, { recursive: true, force: true }),
};

function cacheKey(request: TranscribeAudioRequest, chunk: AudioChunk): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: TRANSCRIPTION_CACHE_VERSION,
				audioSha256: request.audioSha256,
				provider: request.provider.name,
				providerRevision: request.provider.revision,
				language: request.language ?? null,
				startMs: chunk.startMs,
				endMs: chunk.endMs,
				ownedStartMs: chunk.ownedStartMs,
				ownedEndMs: chunk.ownedEndMs,
				mediaProcessing: "ffmpeg-stream-copy-overlap-v2",
			}),
		)
		.digest("hex");
}

function cachePath(request: TranscribeAudioRequest, chunk: AudioChunk): string {
	const index = (chunk.index + 1).toString().padStart(5, "0");
	return join(request.cacheDir, `${index}-${cacheKey(request, chunk)}.json`);
}

function pendingJobPath(
	request: TranscribeAudioRequest,
	chunk: AudioChunk,
): string {
	return `${cachePath(request, chunk)}.pending`;
}

interface PendingJobCache {
	schema: typeof PENDING_JOB_SCHEMA;
	audioSha256: string;
	provider: string;
	providerRevision: string;
	startMs: number;
	endMs: number;
	job: TranscriptionJob;
}

function usablePendingJob(
	input: unknown,
	request: TranscribeAudioRequest,
	chunk: AudioChunk,
): TranscriptionJob | undefined {
	if (!input || typeof input !== "object") return undefined;
	const pending = input as Partial<PendingJobCache>;
	const job = pending.job;
	if (
		pending.schema !== PENDING_JOB_SCHEMA ||
		pending.audioSha256 !== request.audioSha256 ||
		pending.provider !== request.provider.name ||
		pending.providerRevision !== request.provider.revision ||
		pending.startMs !== chunk.startMs ||
		pending.endMs !== chunk.endMs ||
		!job ||
		job.provider !== request.provider.name ||
		typeof job.id !== "string" ||
		job.id.length === 0
	) {
		return undefined;
	}
	return job;
}

function pendingJobCache(
	request: TranscribeAudioRequest,
	chunk: AudioChunk,
	job: TranscriptionJob,
): PendingJobCache {
	return {
		schema: PENDING_JOB_SCHEMA,
		audioSha256: request.audioSha256,
		provider: request.provider.name,
		providerRevision: request.provider.revision,
		startMs: chunk.startMs,
		endMs: chunk.endMs,
		job,
	};
}

function usableCachedTranscript(
	input: unknown,
	request: TranscribeAudioRequest,
	chunk: AudioChunk,
): HonomiyaTranscript | undefined {
	try {
		const transcript = parseHonomiyaTranscript(input);
		if (
			transcript.engine.provider !== request.provider.name ||
			transcript.engine.revision !== request.provider.revision ||
			transcript.offsetMs !== chunk.startMs
		) {
			return undefined;
		}
		return transcript;
	} catch {
		return undefined;
	}
}

function ownedTranscriptSegments(
	transcript: HonomiyaTranscript,
	chunk: AudioChunk,
): HonomiyaTranscript["segments"] {
	return transcript.segments.flatMap((segment) => {
		if (segment.words.length === 0) {
			const midpoint = (segment.startMs + segment.endMs) / 2;
			if (midpoint < chunk.ownedStartMs || midpoint >= chunk.ownedEndMs) {
				return [];
			}
			const startMs = Math.max(segment.startMs, chunk.ownedStartMs);
			const endMs = Math.min(segment.endMs, chunk.ownedEndMs);
			return endMs > startMs ? [{ ...segment, startMs, endMs }] : [];
		}

		const words = segment.words.flatMap((word) => {
			const midpoint = (word.startMs + word.endMs) / 2;
			if (midpoint < chunk.ownedStartMs || midpoint >= chunk.ownedEndMs) {
				return [];
			}
			const startMs = Math.max(word.startMs, chunk.ownedStartMs);
			const endMs = Math.min(word.endMs, chunk.ownedEndMs);
			return endMs > startMs ? [{ ...word, startMs, endMs }] : [];
		});
		const first = words[0];
		const last = words.at(-1);
		if (!first || !last) return [];
		return [
			{
				...segment,
				startMs: first.startMs,
				endMs: last.endMs,
				text: words.map((word) => word.text).join(" "),
				words,
			},
		];
	});
}

function ownedSpeechTimeline(
	transcript: HonomiyaTranscript,
	chunk: AudioChunk,
): NonNullable<HonomiyaTranscript["speechTimeline"]> {
	return (transcript.speechTimeline ?? []).flatMap((region) => {
		const startMs = Math.max(region.startMs, chunk.ownedStartMs);
		const endMs = Math.min(region.endMs, chunk.ownedEndMs);
		return endMs > startMs ? [{ startMs, endMs }] : [];
	});
}

function mergeSpeechTimeline(
	regions: NonNullable<HonomiyaTranscript["speechTimeline"]>,
): NonNullable<HonomiyaTranscript["speechTimeline"]> {
	const merged: NonNullable<HonomiyaTranscript["speechTimeline"]> = [];
	for (const region of [...regions].sort(
		(left, right) => left.startMs - right.startMs,
	)) {
		const previous = merged.at(-1);
		if (previous && region.startMs <= previous.endMs) {
			previous.endMs = Math.max(previous.endMs, region.endMs);
		} else {
			merged.push({ ...region });
		}
	}
	return merged;
}

function mergeChunkTranscripts(
	request: TranscribeAudioRequest,
	probe: AudioProbe,
	chunks: AudioChunk[],
	transcripts: HonomiyaTranscript[],
): HonomiyaTranscript {
	const first = transcripts[0];
	if (!first) throw new Error("Audio chunk planning produced no transcripts");
	const segments = transcripts
		.flatMap((transcript, index) => {
			const chunk = chunks[index];
			if (!chunk) throw new Error(`Missing chunk plan at index ${index}`);
			return ownedTranscriptSegments(transcript, chunk);
		})
		.sort((left, right) => left.startMs - right.startMs)
		.map((segment, id) => ({ ...segment, id }));
	const lastEndMs = segments.at(-1)?.endMs ?? 0;
	const speechTimeline = mergeSpeechTimeline(
		transcripts.flatMap((transcript, index) => {
			const chunk = chunks[index];
			if (!chunk) throw new Error(`Missing chunk plan at index ${index}`);
			return ownedSpeechTimeline(transcript, chunk);
		}),
	);

	return parseHonomiyaTranscript({
		schema: HONOMIYA_TRANSCRIPT_SCHEMA,
		engine: first.engine,
		source: {
			sha256: request.audioSha256,
			filename: basename(request.audioPath),
		},
		language: first.language,
		...(first.languageProbability === undefined
			? {}
			: { languageProbability: first.languageProbability }),
		offsetMs: 0,
		durationMs: Math.max(probe.durationMs, lastEndMs),
		...(speechTimeline.length > 0 ? { speechTimeline } : {}),
		segments,
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Transcription cancelled");
	error.name = "AbortError";
	throw error;
}

export async function transcribeAudio(
	request: TranscribeAudioRequest,
	dependencies: TranscribeAudioDependencies = runtimeDependencies,
): Promise<TranscribeAudioResult> {
	const parallelChunks = request.parallelChunks ?? DEFAULT_PARALLEL_CHUNKS;
	if (!Number.isInteger(parallelChunks) || parallelChunks <= 0) {
		throw new Error("parallelChunks must be a positive integer");
	}
	const probe = request.probe ?? (await dependencies.probe(request.audioPath));
	const chunks = planAudioChunks(
		probe,
		request.maxChunkDurationMs ?? DEFAULT_MAX_CHUNK_DURATION_MS,
		request.chunkOverlapMs ?? DEFAULT_CHUNK_OVERLAP_MS,
	);
	const transcripts: Array<HonomiyaTranscript | undefined> = new Array(
		chunks.length,
	);
	let cacheHits = 0;
	let resumedJobs = 0;
	let retries = 0;
	let completedChunks = 0;
	let temporaryDirectory: string | undefined;
	let temporaryDirectoryPromise: Promise<string> | undefined;
	const workerController = new AbortController();
	const signal = request.signal
		? AbortSignal.any([request.signal, workerController.signal])
		: workerController.signal;

	const getTemporaryDirectory = () => {
		temporaryDirectoryPromise ??= dependencies
			.makeTemporaryDirectory()
			.then((path) => {
				temporaryDirectory = path;
				return path;
			});
		return temporaryDirectoryPromise;
	};

	const processChunk = async (chunk: AudioChunk): Promise<void> => {
		throwIfAborted(signal);
		const path = cachePath(request, chunk);
		const pendingPath = pendingJobPath(request, chunk);
		const cached = usableCachedTranscript(
			await dependencies.readCache(path),
			request,
			chunk,
		);
		if (cached) {
			cacheHits += 1;
			transcripts[chunk.index] = cached;
			await dependencies.removeCache(pendingPath);
			completedChunks += 1;
			request.onProgress?.({
				chunk: chunk.index + 1,
				totalChunks: chunks.length,
				completedChunks,
				state: "cached",
			});
			return;
		}
		let activeJob = usablePendingJob(
			await dependencies.readCache(pendingPath),
			request,
			chunk,
		);
		let countedResume = false;
		if (activeJob && !request.provider.resume) {
			throw new Error(
				`Provider ${request.provider.name} cannot resume pending job ${activeJob.id}`,
			);
		}

		let chunkPath = request.audioPath;
		if (!activeJob) {
			const coversWholeAudio =
				chunks.length === 1 &&
				chunk.startMs === 0 &&
				chunk.endMs === probe.durationMs;
			if (!coversWholeAudio) {
				chunkPath = join(
					await getTemporaryDirectory(),
					`chunk-${(chunk.index + 1).toString().padStart(5, "0")}${chunkExtension(request.audioPath)}`,
				);
				await dependencies.extract(request.audioPath, chunk, chunkPath);
			}
		}

		const maxRetries = request.maxRetries ?? DEFAULT_MAX_RETRIES;
		let transcript: HonomiyaTranscript | undefined;
		for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
			throwIfAborted(signal);
			request.onProgress?.({
				chunk: chunk.index + 1,
				totalChunks: chunks.length,
				completedChunks,
				state: activeJob ? "resuming" : "starting",
				attempt: attempt + 1,
			});
			try {
				if (activeJob) {
					if (!request.provider.resume) {
						throw new Error(
							`Provider ${request.provider.name} cannot resume jobs`,
						);
					}
					if (!countedResume) {
						resumedJobs += 1;
						countedResume = true;
					}
					transcript = parseHonomiyaTranscript(
						await request.provider.resume(activeJob, signal),
					);
				} else {
					transcript = parseHonomiyaTranscript(
						await request.provider.transcribe({
							audioPath: chunkPath,
							language: request.language,
							offsetMs: chunk.startMs,
							signal,
							onJobStarted: async (job) => {
								activeJob = job;
								await dependencies.writeCache(
									pendingPath,
									pendingJobCache(request, chunk, job),
								);
							},
						}),
					);
				}
				break;
			} catch (error) {
				if (signal.aborted) {
					if (activeJob && request.provider.cancel) {
						await request.provider.cancel(activeJob).catch(() => undefined);
					}
					await dependencies.removeCache(pendingPath);
					throw error;
				}
				if (attempt >= maxRetries) throw error;
				retries += 1;
				request.onProgress?.({
					chunk: chunk.index + 1,
					totalChunks: chunks.length,
					completedChunks,
					state: "retrying",
					attempt: attempt + 2,
				});
			}
		}
		if (!transcript) throw new Error("Transcription produced no result");
		if (transcript.offsetMs !== chunk.startMs) {
			throw new Error(
				`Provider returned offset ${transcript.offsetMs} for chunk at ${chunk.startMs}`,
			);
		}
		await dependencies.writeCache(path, transcript);
		await dependencies.removeCache(pendingPath);
		transcripts[chunk.index] = transcript;
		completedChunks += 1;
		request.onProgress?.({
			chunk: chunk.index + 1,
			totalChunks: chunks.length,
			completedChunks,
			state: "completed",
		});
	};

	try {
		let nextChunkIndex = 0;
		let firstError: unknown;
		let hasError = false;
		const worker = async () => {
			while (!hasError && !signal.aborted) {
				const index = nextChunkIndex;
				nextChunkIndex += 1;
				const chunk = chunks[index];
				if (!chunk) return;
				try {
					await processChunk(chunk);
				} catch (error) {
					if (!hasError) {
						hasError = true;
						firstError = error;
						workerController.abort();
					}
					return;
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(parallelChunks, chunks.length) }, () =>
				worker(),
			),
		);
		if (hasError) throw firstError;
		throwIfAborted(signal);
	} finally {
		if (temporaryDirectory) {
			await dependencies.removeTemporaryDirectory(temporaryDirectory);
		}
	}
	const completedTranscripts = transcripts.map((transcript, index) => {
		if (!transcript) {
			throw new Error(`Missing transcript for chunk ${index + 1}`);
		}
		return transcript;
	});

	return {
		transcript: mergeChunkTranscripts(
			request,
			probe,
			chunks,
			completedTranscripts,
		),
		probe,
		chunks: chunks.length,
		cacheHits,
		resumedJobs,
		retries,
	};
}
