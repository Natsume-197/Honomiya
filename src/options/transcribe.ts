import { resolve } from "node:path";
import { defaultTranscriptOutputPath } from "../artifacts/output-paths";
import {
	DEFAULT_QUALITY,
	isQualityPreset,
	QUALITY_SETTINGS,
	type QualityPreset,
} from "../config/quality";
import {
	isTranscriptionProviderName,
	type TranscriptionProviderName,
} from "../transcription/provider";
import {
	isTimestampBackend,
	type TimestampBackend,
} from "../transcription/transcript";

const TRANSCRIBE_FLAGS = new Set([
	"--audio",
	"--cache-dir",
	"--chunk-overlap-seconds",
	"--max-chunk-minutes",
	"--output",
	"--parallel-chunks",
	"--provider",
	"--quality",
	"--language",
	"--retries",
	"--timestamp-backend",
]);

export interface TranscribeOptions {
	audioPath: string;
	outputPath: string;
	provider: TranscriptionProviderName;
	language?: string;
	cacheDir?: string;
	maxChunkDurationMs?: number;
	chunkOverlapMs?: number;
	maxRetries?: number;
	parallelChunks?: number;
	timestampBackend?: TimestampBackend;
	quality?: QualityPreset;
}

function parseMaxChunkDuration(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const minutes = Number(value);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		throw new TranscribeOptionsError(
			"--max-chunk-minutes must be a positive number",
		);
	}
	return Math.round(minutes * 60 * 1_000);
}

function parseChunkOverlap(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) {
		throw new TranscribeOptionsError(
			"--chunk-overlap-seconds must be a non-negative number",
		);
	}
	return Math.round(seconds * 1_000);
}

function parseRetries(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const retries = Number(value);
	if (!Number.isInteger(retries) || retries < 0) {
		throw new TranscribeOptionsError(
			"--retries must be a non-negative integer",
		);
	}
	return retries;
}

function parseParallelChunks(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parallelChunks = Number(value);
	if (!Number.isInteger(parallelChunks) || parallelChunks <= 0) {
		throw new TranscribeOptionsError(
			"--parallel-chunks must be a positive integer",
		);
	}
	return parallelChunks;
}

export class TranscribeOptionsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TranscribeOptionsError";
	}
}

export function parseTranscribeOptions(
	args: string[],
	environment: Record<string, string | undefined> = process.env,
): TranscribeOptions {
	const values = new Map<string, string>();
	for (let position = 0; position < args.length; position += 2) {
		const flag = args[position];
		if (!flag?.startsWith("--")) {
			throw new TranscribeOptionsError(`Unexpected argument: ${flag ?? ""}`);
		}
		const value = args[position + 1];
		if (!value || value.startsWith("--")) {
			throw new TranscribeOptionsError(`${flag} requires a value`);
		}
		if (!TRANSCRIBE_FLAGS.has(flag)) {
			throw new TranscribeOptionsError(`Unknown option: ${flag}`);
		}
		if (values.has(flag)) {
			throw new TranscribeOptionsError(`${flag} may only be provided once`);
		}
		values.set(flag, value);
	}

	const audioPath = values.get("--audio");
	const provider = values.get("--provider") ?? environment.HONOMIYA_PROVIDER;
	if (!audioPath) throw new TranscribeOptionsError("--audio is required");
	const outputPath =
		values.get("--output") ?? defaultTranscriptOutputPath(audioPath);
	if (resolve(audioPath) === resolve(outputPath)) {
		throw new TranscribeOptionsError("--output must not overwrite --audio");
	}
	if (!provider) {
		throw new TranscribeOptionsError(
			"--provider is required (or set HONOMIYA_PROVIDER)",
		);
	}
	if (!isTranscriptionProviderName(provider)) {
		throw new TranscribeOptionsError(`Unsupported provider: ${provider}`);
	}
	const timestampBackend = values.get("--timestamp-backend");
	if (timestampBackend && !isTimestampBackend(timestampBackend)) {
		throw new TranscribeOptionsError(
			`Unsupported timestamp backend: ${timestampBackend}`,
		);
	}
	const qualityValue = values.get("--quality");
	if (qualityValue && !isQualityPreset(qualityValue)) {
		throw new TranscribeOptionsError(
			`Unsupported quality preset: ${qualityValue}`,
		);
	}
	const quality =
		(qualityValue as QualityPreset | undefined) ?? DEFAULT_QUALITY;
	const effectiveTimestampBackend =
		(timestampBackend as TimestampBackend | undefined) ??
		QUALITY_SETTINGS[quality].timestampBackend;

	return {
		audioPath,
		outputPath,
		provider,
		quality,
		timestampBackend: effectiveTimestampBackend,
		...(values.get("--language") ? { language: values.get("--language") } : {}),
		...(values.get("--cache-dir")
			? { cacheDir: values.get("--cache-dir") }
			: {}),
		...(values.get("--max-chunk-minutes")
			? {
					maxChunkDurationMs: parseMaxChunkDuration(
						values.get("--max-chunk-minutes"),
					),
				}
			: {}),
		...(values.get("--chunk-overlap-seconds") !== undefined
			? {
					chunkOverlapMs: parseChunkOverlap(
						values.get("--chunk-overlap-seconds"),
					),
				}
			: {}),
		...(values.get("--retries") !== undefined
			? { maxRetries: parseRetries(values.get("--retries")) }
			: {}),
		...(values.get("--parallel-chunks") !== undefined
			? {
					parallelChunks: parseParallelChunks(values.get("--parallel-chunks")),
				}
			: {}),
	};
}
