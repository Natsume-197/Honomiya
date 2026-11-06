import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { writeBytesAtomically } from "../support/json-file";
import {
	type AudioProbe,
	probeAudio,
} from "../transcription/chunks";
import type { TranscriptionProgress } from "../transcription/audio";
import {
	type AcousticModel,
	type AcousticModelOutput,
	openOnnxAcousticModel,
} from "./acoustic-model";
import {
	type CtcEmissions,
	concatEmissions,
	decodeEmissions,
	encodeEmissions,
	HONOMIYA_EMISSIONS_SCHEMA,
	SparseEmissionsBuilder,
} from "./emissions";
import type { InstalledCtcModel } from "./model-store";
import { decodePcm } from "./pcm";
import { parseVocabularyText } from "./vocabulary";
import { planInferenceWindows, planTechnicalChunks } from "./windows";

const EMISSION_CACHE_VERSION = "honomiya.emission-cache.v1";
export const DEFAULT_TOP_K = 16;
export const DEFAULT_EMIT_CHUNK_MINUTES = 5;

export function defaultEmitThreads(): number {
	const available =
		typeof navigator !== "undefined" && navigator.hardwareConcurrency
			? navigator.hardwareConcurrency
			: 4;
	// Phase 0: four threads beat eight on big.LITTLE ARM boards.
	return Math.max(1, Math.min(4, available));
}

export interface EmitAudioRequest {
	audioPath: string;
	audioSha256: string;
	model: InstalledCtcModel;
	cacheDir: string;
	probe?: AudioProbe;
	threads?: number;
	topK?: number;
	chunkMinutes?: number;
	signal?: AbortSignal;
	onProgress?: (progress: TranscriptionProgress) => void;
}

export interface EmitAudioResult {
	emissions: CtcEmissions;
	probe: AudioProbe;
	chunks: number;
	cacheHits: number;
	performance: {
		/** Time spent waiting for decoded audio, after overlap with inference. */
		decodeWaitMs: number;
		modelMs: number;
		selectMs: number;
		totalMs: number;
	};
}

export interface EmitAudioDependencies {
	probe(path: string): Promise<AudioProbe>;
	decode(
		path: string,
		options: { startMs: number; durationMs: number; sampleRate: number; signal?: AbortSignal },
	): Promise<Float32Array>;
	openModel(model: InstalledCtcModel, threads: number): Promise<AcousticModel>;
	readVocabulary(path: string): Promise<string>;
	readCache(path: string): Promise<Uint8Array | undefined>;
	writeCache(path: string, bytes: Uint8Array): Promise<void>;
}

const runtimeDependencies: EmitAudioDependencies = {
	probe: probeAudio,
	decode: decodePcm,
	openModel: (model, threads) =>
		openOnnxAcousticModel(model.modelPath, model.descriptor, { threads }),
	readVocabulary: (path) => Bun.file(path).text(),
	readCache: async (path) => {
		const file = Bun.file(path);
		return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : undefined;
	},
	writeCache: writeBytesAtomically,
};

/** Frames a model may drop at the end of its input (convolution padding). */
const MAX_TRAILING_FRAME_SHORTFALL = 2;

/**
 * Some graphs emit one or two frames fewer than samples / samplesPerFrame.
 * Inside a chunk the discarded context absorbs that; at the very end of the
 * audio the last row is repeated instead.
 */
export function padFrames(
	output: AcousticModelOutput,
	expectedFrames: number,
): AcousticModelOutput {
	const missing = expectedFrames - output.frames;
	if (missing <= 0 || missing > MAX_TRAILING_FRAME_SHORTFALL || output.frames === 0) {
		return output;
	}
	const { classes } = output;
	const padded = new Float32Array(expectedFrames * classes);
	padded.set(output.logProbabilities.subarray(0, output.frames * classes));
	const lastRow = output.logProbabilities.subarray(
		(output.frames - 1) * classes,
		output.frames * classes,
	);
	for (let frame = output.frames; frame < expectedFrames; frame += 1) {
		padded.set(lastRow, frame * classes);
	}
	return { frames: expectedFrames, classes, logProbabilities: padded };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		const error = new Error("Emission was cancelled");
		error.name = "AbortError";
		throw error;
	}
}

export async function emitAudio(
	request: EmitAudioRequest,
	dependencies: EmitAudioDependencies = runtimeDependencies,
): Promise<EmitAudioResult> {
	const startedAt = performance.now();
	const { descriptor } = request.model;
	const topK = request.topK ?? DEFAULT_TOP_K;
	const threads = request.threads ?? defaultEmitThreads();
	const probe = request.probe ?? (await dependencies.probe(request.audioPath));
	const vocabulary = parseVocabularyText(
		await dependencies.readVocabulary(request.model.vocabularyPath),
	);
	const { samplesPerFrame, sampleRate } = descriptor;
	const frameMs = (samplesPerFrame * 1_000) / sampleRate;
	const totalFrames = Math.floor(probe.durationMs / frameMs);
	const contextFrames = Math.round((descriptor.contextSeconds * 1_000) / frameMs);
	const windowFrames = Math.round((descriptor.windowSeconds * 1_000) / frameMs);
	const chunkFrames = Math.round(
		((request.chunkMinutes ?? DEFAULT_EMIT_CHUNK_MINUTES) * 60_000) / frameMs,
	);
	const chunks = planTechnicalChunks(totalFrames, chunkFrames, contextFrames);
	const baseHeader = {
		schema: HONOMIYA_EMISSIONS_SCHEMA,
		model: {
			id: descriptor.id,
			revision: descriptor.revision,
			timingCorrectionMs: descriptor.timingCorrectionMs,
		},
		source: { sha256: request.audioSha256, filename: basename(request.audioPath) },
		sampleRate,
		samplesPerFrame,
		sourceDurationMs: probe.durationMs,
		vocabulary: vocabulary.tokens,
	};

	const cachePathFor = (chunk: (typeof chunks)[number]) => {
		const key = createHash("sha256")
			.update(
				JSON.stringify({
					version: EMISSION_CACHE_VERSION,
					audio: request.audioSha256,
					model: descriptor.revision,
					topK,
					windowFrames,
					contextFrames,
					owned: [chunk.ownedStartFrame, chunk.ownedEndFrame],
					decoded: [chunk.decodeStartFrame, chunk.decodeEndFrame],
				}),
			)
			.digest("hex");
		return join(request.cacheDir, "emissions", `${key}.bin`);
	};

	const decodeChunk = (chunk: (typeof chunks)[number]) =>
		dependencies.decode(request.audioPath, {
			startMs: chunk.decodeStartFrame * frameMs,
			durationMs: (chunk.decodeEndFrame - chunk.decodeStartFrame) * frameMs,
			sampleRate,
			signal: request.signal,
		});

	let model: AcousticModel | undefined;
	let cacheHits = 0;
	let decodeWaitMs = 0;
	let modelMs = 0;
	let selectMs = 0;
	const parts: CtcEmissions[] = [];
	const pending = new Map<number, Promise<Float32Array>>();
	const missing = new Set<number>();

	// Find cache misses first so decoding can run ahead of inference.
	const cached = await Promise.all(
		chunks.map(async (chunk) => {
			const bytes = await dependencies.readCache(cachePathFor(chunk));
			if (!bytes) return undefined;
			try {
				const part = decodeEmissions(bytes);
				return part.header.startFrame === chunk.ownedStartFrame &&
					part.header.frames === chunk.ownedEndFrame - chunk.ownedStartFrame
					? part
					: undefined;
			} catch {
				return undefined;
			}
		}),
	);
	for (const chunk of chunks) {
		if (!cached[chunk.index]) missing.add(chunk.index);
	}
	const missingOrder = chunks.filter((chunk) => missing.has(chunk.index));
	const startDecode = (position: number) => {
		const chunk = missingOrder[position];
		if (!chunk || pending.has(chunk.index)) return;
		pending.set(chunk.index, decodeChunk(chunk));
	};

	try {
		let missingPosition = 0;
		for (const chunk of chunks) {
			throwIfAborted(request.signal);
			const progressBase = {
				chunk: chunk.index + 1,
				totalChunks: chunks.length,
				completedChunks: parts.length,
			};
			const hit = cached[chunk.index];
			if (hit) {
				cacheHits += 1;
				parts.push(hit);
				request.onProgress?.({ ...progressBase, completedChunks: parts.length, state: "cached" });
				continue;
			}
			request.onProgress?.({ ...progressBase, state: "starting" });
			startDecode(missingPosition);
			startDecode(missingPosition + 1);
			const waitStartedAt = performance.now();
			const decoded = await pending.get(chunk.index);
			decodeWaitMs += performance.now() - waitStartedAt;
			pending.delete(chunk.index);
			missingPosition += 1;
			if (!decoded) throw new Error(`Chunk ${chunk.index} was not decoded`);

			const expectedSamples = (chunk.decodeEndFrame - chunk.decodeStartFrame) * samplesPerFrame;
			let pcm = decoded;
			if (pcm.length < expectedSamples) {
				const padded = new Float32Array(expectedSamples);
				padded.set(pcm);
				pcm = padded;
			}
			model ??= await dependencies.openModel(request.model, threads);
			const builder = new SparseEmissionsBuilder(topK, vocabulary.blank);
			const windows = planInferenceWindows({
				spanStartFrame: chunk.decodeStartFrame,
				spanSamples: expectedSamples,
				ownedStartFrame: chunk.ownedStartFrame,
				ownedEndFrame: chunk.ownedEndFrame,
				samplesPerFrame,
				windowFrames,
				contextFrames,
			});
			for (const window of windows) {
				throwIfAborted(request.signal);
				const modelStartedAt = performance.now();
				const output = padFrames(
					await model.run(pcm.slice(window.startSample, window.endSample)),
					(window.endSample - window.startSample) / samplesPerFrame,
				);
				if (output.classes !== vocabulary.tokens.length) {
					throw new Error(
						`Model returned ${output.classes} classes but the vocabulary has ${vocabulary.tokens.length}`,
					);
				}
				const windowStartFrame =
					chunk.decodeStartFrame + window.startSample / samplesPerFrame;
				const first = window.ownedStartFrame - windowStartFrame;
				const end = window.ownedEndFrame - windowStartFrame;
				if (end > output.frames) {
					throw new Error(
						`Model returned ${output.frames} frames for a window that owns frames up to ${end}`,
					);
				}
				const selectStartedAt = performance.now();
				modelMs += selectStartedAt - modelStartedAt;
				builder.append(output.logProbabilities, output.classes, first, end);
				selectMs += performance.now() - selectStartedAt;
			}
			const part = builder.build({ ...baseHeader, startFrame: chunk.ownedStartFrame });
			await dependencies.writeCache(cachePathFor(chunk), encodeEmissions(part));
			parts.push(part);
			request.onProgress?.({ ...progressBase, completedChunks: parts.length, state: "completed" });
		}
	} finally {
		await Promise.allSettled(pending.values());
		await model?.close();
	}

	const emissions =
		parts.length > 0
			? concatEmissions(parts)
			: new SparseEmissionsBuilder(topK, vocabulary.blank).build({ ...baseHeader, startFrame: 0 });
	return {
		emissions,
		probe,
		chunks: chunks.length,
		cacheHits,
		performance: {
			decodeWaitMs: Math.round(decodeWaitMs),
			modelMs: Math.round(modelMs),
			selectMs: Math.round(selectMs),
			totalMs: Math.round(performance.now() - startedAt),
		},
	};
}
