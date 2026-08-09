import { DEFAULT_QUALITY, QUALITY_SETTINGS } from "../config/quality";
import type { TranscribeOptions } from "../options/transcribe";
import { hashFileSha256 } from "../support/file-hash";
import { writeJsonAtomically } from "../support/json-file";
import {
	type TranscribeAudioRequest,
	type TranscribeAudioResult,
	type TranscriptionControls,
	transcribeAudio,
} from "./audio";
import {
	createTranscriptionProvider,
	type TranscriptionProvider,
} from "./provider";
import type { HonomiyaTranscript } from "./transcript";

export interface TranscriptionCommandResult {
	transcript: HonomiyaTranscript;
	provider: { name: string; revision: string };
	chunks: number;
	cacheHits: number;
	resumedJobs: number;
	retries: number;
}

export interface TranscriptionCommandDependencies {
	createProvider(
		name: TranscribeOptions["provider"],
		timestampBackend?: TranscribeOptions["timestampBackend"],
	): TranscriptionProvider;
	hashFile(path: string): Promise<string>;
	transcribeAudio(
		request: TranscribeAudioRequest,
	): Promise<TranscribeAudioResult>;
	writeJson(path: string, value: unknown): Promise<void>;
}

const runtimeDependencies: TranscriptionCommandDependencies = {
	createProvider: (name, timestampBackend) =>
		createTranscriptionProvider(name, { timestampBackend }),
	hashFile: hashFileSha256,
	transcribeAudio,
	writeJson: writeJsonAtomically,
};

export async function executeTranscribeCommand(
	options: TranscribeOptions,
	dependencies: TranscriptionCommandDependencies = runtimeDependencies,
	controls: TranscriptionControls = {},
): Promise<TranscriptionCommandResult> {
	const provider = dependencies.createProvider(
		options.provider,
		options.timestampBackend ??
			QUALITY_SETTINGS[options.quality ?? DEFAULT_QUALITY].timestampBackend,
	);
	const audioSha256 = await dependencies.hashFile(options.audioPath);
	const result = await dependencies.transcribeAudio({
		audioPath: options.audioPath,
		audioSha256,
		language: options.language,
		cacheDir: options.cacheDir ?? `${options.outputPath}.cache`,
		maxChunkDurationMs: options.maxChunkDurationMs,
		chunkOverlapMs: options.chunkOverlapMs,
		maxRetries: options.maxRetries,
		parallelChunks: options.parallelChunks,
		signal: controls.signal,
		onProgress: controls.onProgress,
		provider,
	});
	await dependencies.writeJson(options.outputPath, result.transcript);
	return {
		transcript: result.transcript,
		provider: { name: provider.name, revision: provider.revision },
		chunks: result.chunks,
		cacheHits: result.cacheHits,
		resumedJobs: result.resumedJobs,
		retries: result.retries,
	};
}
