import { resolve } from "node:path";
import { defaultAlignmentOutputPath } from "../artifacts/output-paths";
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

export interface AlignOptions {
	ebookPath: string;
	audioPaths: string[];
	transcriptPaths: string[];
	outputPath: string;
	provider?: TranscriptionProviderName;
	language?: string;
	cacheDir?: string;
	maxChunkDurationMs?: number;
	chunkOverlapMs?: number;
	maxRetries?: number;
	parallelChunks?: number;
	interpolationMode?: InterpolationMode;
	timestampBackend?: TimestampBackend;
	srt?: boolean;
	quality?: QualityPreset;
}

export const INTERPOLATION_MODES = ["off", "conservative", "complete"] as const;
export type InterpolationMode = (typeof INTERPOLATION_MODES)[number];

function isInterpolationMode(value: string): value is InterpolationMode {
	return INTERPOLATION_MODES.some((mode) => mode === value);
}

export class AlignOptionsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AlignOptionsError";
	}
}

interface MutableAlignOptions {
	ebookPath?: string;
	audioPaths: string[];
	transcriptPaths: string[];
	outputPath?: string;
	provider?: string;
	language?: string;
	cacheDir?: string;
	maxChunkMinutes?: string;
	chunkOverlapSeconds?: string;
	maxRetries?: string;
	parallelChunks?: string;
	interpolationMode?: string;
	timestampBackend?: string;
	quality?: string;
	srt: boolean;
}

function assignOnce(
	options: MutableAlignOptions,
	key: "ebookPath" | "outputPath" | "provider" | "language" | "quality",
	flag: string,
	value: string,
) {
	if (options[key] !== undefined) {
		throw new AlignOptionsError(`${flag} may only be provided once`);
	}
	options[key] = value;
}

function parseMaxChunkDuration(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const minutes = Number(value);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		throw new AlignOptionsError(
			"--max-chunk-minutes must be a positive number",
		);
	}
	return Math.round(minutes * 60 * 1_000);
}

function parseChunkOverlap(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) {
		throw new AlignOptionsError(
			"--chunk-overlap-seconds must be a non-negative number",
		);
	}
	return Math.round(seconds * 1_000);
}

function parseRetries(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const retries = Number(value);
	if (!Number.isInteger(retries) || retries < 0) {
		throw new AlignOptionsError("--retries must be a non-negative integer");
	}
	return retries;
}

function parseParallelChunks(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parallelChunks = Number(value);
	if (!Number.isInteger(parallelChunks) || parallelChunks <= 0) {
		throw new AlignOptionsError("--parallel-chunks must be a positive integer");
	}
	return parallelChunks;
}

function readValue(args: string[], position: number, flag: string): string {
	const value = args[position + 1];
	if (!value || value.startsWith("--")) {
		throw new AlignOptionsError(`${flag} requires a value`);
	}
	return value;
}

export function parseAlignOptions(
	args: string[],
	environment: Record<string, string | undefined> = process.env,
): AlignOptions {
	const parsed: MutableAlignOptions = {
		audioPaths: [],
		transcriptPaths: [],
		srt: false,
	};

	for (let position = 0; position < args.length; position += 1) {
		const flag = args[position];
		if (!flag?.startsWith("--")) {
			throw new AlignOptionsError(`Unexpected argument: ${flag ?? ""}`);
		}
		if (flag === "--srt") {
			if (parsed.srt) {
				throw new AlignOptionsError("--srt may only be provided once");
			}
			parsed.srt = true;
			continue;
		}
		const value = readValue(args, position, flag);
		position += 1;

		switch (flag) {
			case "--ebook":
				assignOnce(parsed, "ebookPath", flag, value);
				break;
			case "--audio":
				parsed.audioPaths.push(value);
				break;
			case "--transcript":
				parsed.transcriptPaths.push(value);
				break;
			case "--output":
				assignOnce(parsed, "outputPath", flag, value);
				break;
			case "--provider":
				assignOnce(parsed, "provider", flag, value);
				break;
			case "--language":
				assignOnce(parsed, "language", flag, value);
				break;
			case "--cache-dir":
				if (parsed.cacheDir !== undefined) {
					throw new AlignOptionsError(`${flag} may only be provided once`);
				}
				parsed.cacheDir = value;
				break;
			case "--max-chunk-minutes":
				if (parsed.maxChunkMinutes !== undefined) {
					throw new AlignOptionsError(`${flag} may only be provided once`);
				}
				parsed.maxChunkMinutes = value;
				break;
			case "--chunk-overlap-seconds":
				if (parsed.chunkOverlapSeconds !== undefined) {
					throw new AlignOptionsError(`${flag} may only be provided once`);
				}
				parsed.chunkOverlapSeconds = value;
				break;
			case "--retries":
				if (parsed.maxRetries !== undefined) {
					throw new AlignOptionsError(`${flag} may only be provided once`);
				}
				parsed.maxRetries = value;
				break;
			case "--parallel-chunks":
				if (parsed.parallelChunks !== undefined) {
					throw new AlignOptionsError(`${flag} may only be provided once`);
				}
				parsed.parallelChunks = value;
				break;
			case "--interpolation":
				if (parsed.interpolationMode !== undefined) {
					throw new AlignOptionsError(`${flag} may only be provided once`);
				}
				parsed.interpolationMode = value;
				break;
			case "--timestamp-backend":
				if (parsed.timestampBackend !== undefined) {
					throw new AlignOptionsError(`${flag} may only be provided once`);
				}
				parsed.timestampBackend = value;
				break;
			case "--quality":
				assignOnce(parsed, "quality", flag, value);
				break;
			default:
				throw new AlignOptionsError(`Unknown option: ${flag}`);
		}
	}

	if (!parsed.ebookPath) {
		throw new AlignOptionsError("--ebook is required");
	}
	if (parsed.audioPaths.length === 0) {
		throw new AlignOptionsError("At least one --audio is required");
	}
	const outputPath =
		parsed.outputPath ?? defaultAlignmentOutputPath(parsed.ebookPath);
	const resolvedOutput = resolve(outputPath);
	if (
		[parsed.ebookPath, ...parsed.audioPaths, ...parsed.transcriptPaths].some(
			(path) => resolve(path) === resolvedOutput,
		)
	) {
		throw new AlignOptionsError("--output must not overwrite an input file");
	}

	if (
		parsed.transcriptPaths.length > 0 &&
		parsed.transcriptPaths.length !== parsed.audioPaths.length
	) {
		throw new AlignOptionsError(
			"The number of --transcript and --audio values must match",
		);
	}
	if (parsed.transcriptPaths.length > 0 && parsed.provider) {
		throw new AlignOptionsError(
			"--provider cannot be combined with --transcript",
		);
	}

	const provider =
		parsed.transcriptPaths.length === 0
			? (parsed.provider ?? environment.HONOMIYA_PROVIDER)
			: undefined;
	if (parsed.transcriptPaths.length === 0 && !provider) {
		throw new AlignOptionsError(
			"--provider is required unless --transcript is provided (or set HONOMIYA_PROVIDER)",
		);
	}
	let validatedProvider: TranscriptionProviderName | undefined;
	if (provider) {
		if (!isTranscriptionProviderName(provider)) {
			throw new AlignOptionsError(`Unsupported provider: ${provider}`);
		}
		validatedProvider = provider;
	}
	if (
		parsed.interpolationMode !== undefined &&
		!isInterpolationMode(parsed.interpolationMode)
	) {
		throw new AlignOptionsError(
			`Unsupported interpolation mode: ${parsed.interpolationMode}`,
		);
	}
	if (parsed.quality !== undefined && !isQualityPreset(parsed.quality)) {
		throw new AlignOptionsError(
			`Unsupported quality preset: ${parsed.quality}`,
		);
	}
	if (
		parsed.timestampBackend !== undefined &&
		!isTimestampBackend(parsed.timestampBackend)
	) {
		throw new AlignOptionsError(
			`Unsupported timestamp backend: ${parsed.timestampBackend}`,
		);
	}
	if (parsed.transcriptPaths.length > 0 && parsed.timestampBackend) {
		throw new AlignOptionsError(
			"--timestamp-backend cannot be combined with --transcript",
		);
	}
	const quality =
		(parsed.quality as QualityPreset | undefined) ?? DEFAULT_QUALITY;
	const qualitySettings = QUALITY_SETTINGS[quality];
	const interpolationMode =
		(parsed.interpolationMode as InterpolationMode | undefined) ??
		qualitySettings.interpolationMode;
	const timestampBackend =
		(parsed.timestampBackend as TimestampBackend | undefined) ??
		qualitySettings.timestampBackend;

	return {
		ebookPath: parsed.ebookPath,
		audioPaths: parsed.audioPaths,
		transcriptPaths: parsed.transcriptPaths,
		outputPath,
		quality,
		...(validatedProvider ? { provider: validatedProvider } : {}),
		interpolationMode,
		...(parsed.transcriptPaths.length === 0 ? { timestampBackend } : {}),
		language: parsed.language,
		...(parsed.cacheDir ? { cacheDir: parsed.cacheDir } : {}),
		...(parsed.maxChunkMinutes
			? {
					maxChunkDurationMs: parseMaxChunkDuration(parsed.maxChunkMinutes),
				}
			: {}),
		...(parsed.chunkOverlapSeconds !== undefined
			? { chunkOverlapMs: parseChunkOverlap(parsed.chunkOverlapSeconds) }
			: {}),
		...(parsed.maxRetries !== undefined
			? { maxRetries: parseRetries(parsed.maxRetries) }
			: {}),
		...(parsed.parallelChunks !== undefined
			? { parallelChunks: parseParallelChunks(parsed.parallelChunks) }
			: {}),
		...(parsed.srt ? { srt: true } : {}),
	};
}
