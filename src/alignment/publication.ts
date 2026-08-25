import { basename, extname } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import {
	HONOMIYA_MANIFEST_SCHEMA,
	type HonomiyaManifestV1,
	parseHonomiyaManifest,
} from "../artifacts/manifest";
import { type SubtitleCue, writeSrtArtifacts } from "../artifacts/srt";
import {
	DEFAULT_QUALITY,
	QUALITY_SETTINGS,
	type QualityPreset,
} from "../config/quality";
import type { EbookDocument } from "../ebook-parser/ebook";
import { openEbookFile } from "../ebook-parser/node";
import {
	type AlignOptions,
	DEFAULT_TIMED_TEXT_MIN_DIRECT_COVERAGE,
	type InterpolationMode,
} from "../options/align";
import { hashFileSha256 } from "../support/file-hash";
import { writeJsonAtomically } from "../support/json-file";
import { type SrtTranscriptReport, srtToTranscript } from "../timed-text/srt";
import {
	type TimedTextVerificationReport,
	verifyTimedTextAgainstAudio,
} from "../timed-text/verify";
import {
	DEFAULT_PARALLEL_CHUNKS,
	type TranscribeAudioRequest,
	type TranscribeAudioResult,
	type TranscriptionControls,
	transcribeAudio,
} from "../transcription/audio";
import {
	type AudioProbe,
	DEFAULT_CHUNK_OVERLAP_MS,
	DEFAULT_MAX_CHUNK_DURATION_MS,
	planAudioChunks,
	probeAudio,
} from "../transcription/chunks";
import {
	createTranscriptionProvider,
	type TranscriptionProvider,
	type TranscriptionProviderName,
} from "../transcription/provider";
import {
	type HonomiyaTranscript,
	parseHonomiyaTranscript,
	type TimestampBackend,
} from "../transcription/transcript";
import { extractEbookSentences } from "./ebook-text";
import {
	ALIGNMENT_PARAMETERS,
	type AlignmentReport,
	alignSentencesToTranscripts,
} from "./sentences";
import { TEXT_NORMALIZATION_VERSION } from "./text";

export const ALIGNMENT_ALGORITHM_VERSION = "honomiya.align.v6" as const;

export interface AlignmentExecutionReport {
	algorithm: typeof ALIGNMENT_ALGORITHM_VERSION;
	normalization: typeof TEXT_NORMALIZATION_VERSION;
	parameters: typeof ALIGNMENT_PARAMETERS & {
		quality: QualityPreset;
		interpolationMode: InterpolationMode;
		minDirectCoverage?: number;
	};
	transcription: {
		mode: "provider" | "precomputed" | "timed-text";
		provider?: { name: string; revision: string };
		sources: Array<{
			audioFileIndex: number;
			provider: string;
			model: string;
			revision?: string;
			timestampBackend?: TimestampBackend;
			chunks?: number;
			cacheHits?: number;
			resumedJobs?: number;
			retries?: number;
			parallelChunks?: number;
		}>;
		timedText?: SrtTranscriptReport[];
	};
	language?: string;
	performance: {
		hashingMs: number;
		transcriptionMs: number;
		ebookExtractionMs: number;
		alignmentMs: number;
		verificationMs: number;
		totalMs: number;
		rssBytes: number;
		heapUsedBytes: number;
	};
	alignment: AlignmentReport;
	cueEvidence: Array<{
		cueId: string;
		method: "direct" | "interpolated";
		score?: number;
		basis?: "wall-clock" | "speech";
	}>;
	outputs?: {
		alignment: string;
		report: string;
		srtFiles: string[];
	};
}

export interface PublicationAlignmentResult {
	manifest: HonomiyaManifestV1;
	report: AlignmentExecutionReport;
	subtitles: SubtitleCue[];
}

export interface AlignPublicationDependencies {
	openEbook(path: string): Promise<EbookDocument>;
	createProvider(
		name: TranscriptionProviderName,
		timestampBackend?: AlignOptions["timestampBackend"],
	): TranscriptionProvider;
	transcribeAudio(
		request: TranscribeAudioRequest,
	): Promise<TranscribeAudioResult>;
	probeAudio(path: string): Promise<AudioProbe>;
	hashFile(path: string): Promise<string>;
	readTranscript(path: string): Promise<unknown>;
	readTimedText?(path: string): Promise<string>;
	verifyTimedText?(input: {
		transcript: HonomiyaTranscript;
		audioPath: string;
		provider: TranscriptionProvider;
		language?: string;
		samples?: number;
		signal?: AbortSignal;
	}): Promise<TimedTextVerificationReport>;
	now(): Date;
}

const runtimeDependencies: AlignPublicationDependencies = {
	openEbook: (path) => openEbookFile(path),
	createProvider: (name, timestampBackend) =>
		createTranscriptionProvider(name, { timestampBackend }),
	transcribeAudio,
	probeAudio,
	hashFile: hashFileSha256,
	readTranscript: async (path) => JSON.parse(await Bun.file(path).text()),
	readTimedText: async (path) =>
		new TextDecoder("utf-8", { fatal: true }).decode(
			await Bun.file(path).arrayBuffer(),
		),
	verifyTimedText: verifyTimedTextAgainstAudio,
	now: () => new Date(),
};

export async function alignPublication(
	options: AlignOptions,
	dependencies: AlignPublicationDependencies = runtimeDependencies,
	controls: TranscriptionControls = {},
): Promise<PublicationAlignmentResult> {
	const startedAt = performance.now();
	const quality = options.quality ?? DEFAULT_QUALITY;
	const qualitySettings = QUALITY_SETTINGS[quality];
	const timedTextPaths = options.timedTextPaths ?? [];
	const minDirectCoverage =
		options.minDirectCoverage ??
		(timedTextPaths.length > 0
			? DEFAULT_TIMED_TEXT_MIN_DIRECT_COVERAGE
			: undefined);
	for (const path of timedTextPaths) {
		if (extname(path).toLowerCase() !== ".srt") {
			throw new Error(
				`Unsupported timed-text format for ${path}; only UTF-8 SRT is currently supported`,
			);
		}
	}
	const interpolationMode =
		options.interpolationMode ??
		(timedTextPaths.length > 0
			? "conservative"
			: qualitySettings.interpolationMode);
	const timestampBackend =
		options.timestampBackend ?? qualitySettings.timestampBackend;
	const hashingStartedAt = performance.now();
	const [ebookSha256, audioHashes, timedTextHashes] = await Promise.all([
		dependencies.hashFile(options.ebookPath),
		Promise.all(options.audioPaths.map((path) => dependencies.hashFile(path))),
		Promise.all(timedTextPaths.map((path) => dependencies.hashFile(path))),
	]);
	const hashingMs = performance.now() - hashingStartedAt;
	const ebook = await dependencies.openEbook(options.ebookPath);
	const language = (options.language ?? ebook.metadata.language) || undefined;
	const ebookExtractionStartedAt = performance.now();
	let sentences: Awaited<ReturnType<typeof extractEbookSentences>>;
	let ebookExtractionMs: number;
	try {
		sentences = await extractEbookSentences(ebook, language);
		ebookExtractionMs = performance.now() - ebookExtractionStartedAt;
	} finally {
		await ebook.close();
	}

	const transcriptionStartedAt = performance.now();
	let provider: TranscriptionProvider | undefined;
	let verificationProvider: TranscriptionProvider | undefined;
	let transcripts: HonomiyaTranscript[];
	const transcriptionResults: TranscribeAudioResult[] = [];
	const timedTextReports: SrtTranscriptReport[] = [];
	if (options.transcriptPaths.length > 0) {
		transcripts = await Promise.all(
			options.transcriptPaths.map(async (path) =>
				parseHonomiyaTranscript(await dependencies.readTranscript(path)),
			),
		);
		for (const [index, transcript] of transcripts.entries()) {
			const expectedSha256 = audioHashes[index];
			if (!transcript.source) {
				throw new Error(
					`Transcript ${options.transcriptPaths[index]} does not identify its source audio`,
				);
			}
			if (transcript.source.sha256 !== expectedSha256) {
				throw new Error(
					`Transcript ${options.transcriptPaths[index]} does not match audio ${options.audioPaths[index]}`,
				);
			}
		}
	} else if (timedTextPaths.length > 0) {
		if (!dependencies.readTimedText) {
			throw new Error("A timed-text reader is required");
		}
		const probes = await Promise.all(
			options.audioPaths.map((audioPath) => dependencies.probeAudio(audioPath)),
		);
		const texts = await Promise.all(
			timedTextPaths.map((path) => dependencies.readTimedText?.(path)),
		);
		const convertedSources = timedTextPaths.map((path, index) => {
			const audioPath = options.audioPaths[index];
			const audioSha256 = audioHashes[index];
			const probe = probes[index];
			const sha256 = timedTextHashes[index];
			const text = texts[index];
			if (
				!audioPath ||
				!audioSha256 ||
				!probe ||
				!sha256 ||
				text === undefined
			) {
				throw new Error(`Could not prepare timed-text source ${path}`);
			}
			const converted = srtToTranscript({
				text,
				path,
				sha256,
				audioPath,
				audioSha256,
				audioDurationMs: probe.durationMs,
				language,
			});
			return converted;
		});
		transcripts = convertedSources.map((source) => source.transcript);
		timedTextReports.push(...convertedSources.map((source) => source.report));
		if (options.verificationProvider) {
			if (!dependencies.verifyTimedText) {
				throw new Error("A timed-text audio verifier is required");
			}
			verificationProvider = dependencies.createProvider(
				options.verificationProvider,
				"faster-whisper",
			);
		}
	} else {
		if (!options.provider) {
			throw new Error("A transcription provider is required");
		}
		provider = dependencies.createProvider(options.provider, timestampBackend);
		const probes = await Promise.all(
			options.audioPaths.map((audioPath) => dependencies.probeAudio(audioPath)),
		);
		const plannedChunks = probes.map(
			(probe) =>
				planAudioChunks(
					probe,
					options.maxChunkDurationMs ?? DEFAULT_MAX_CHUNK_DURATION_MS,
					options.chunkOverlapMs ?? DEFAULT_CHUNK_OVERLAP_MS,
				).length,
		);
		const overallTotalChunks = plannedChunks.reduce(
			(total, chunks) => total + chunks,
			0,
		);
		let completedPreviousSources = 0;
		transcripts = [];
		for (const [index, audioPath] of options.audioPaths.entries()) {
			const audioSha256 = audioHashes[index];
			const probe = probes[index];
			if (!audioSha256) throw new Error(`Could not hash audio ${audioPath}`);
			if (!probe) throw new Error(`Could not probe audio ${audioPath}`);
			const result = await dependencies.transcribeAudio({
				audioPath,
				audioSha256,
				probe,
				language: options.language,
				cacheDir: options.cacheDir ?? `${options.outputPath}.cache`,
				maxChunkDurationMs: options.maxChunkDurationMs,
				chunkOverlapMs: options.chunkOverlapMs,
				maxRetries: options.maxRetries,
				parallelChunks: options.parallelChunks,
				signal: controls.signal,
				onProgress: (progress) =>
					controls.onProgress?.({
						...progress,
						sourceIndex: index,
						totalSources: options.audioPaths.length,
						overallCompletedChunks:
							completedPreviousSources + progress.completedChunks,
						overallTotalChunks,
					}),
				provider,
			});
			transcriptionResults.push(result);
			transcripts.push(result.transcript);
			completedPreviousSources += result.chunks;
		}
	}
	const transcriptionMs = performance.now() - transcriptionStartedAt;

	const alignmentStartedAt = performance.now();
	const alignment = alignSentencesToTranscripts(
		sentences,
		transcripts,
		language,
		{ interpolationMode },
	);
	const alignmentMs = performance.now() - alignmentStartedAt;
	if (
		minDirectCoverage !== undefined &&
		alignment.report.directCoverage < minDirectCoverage
	) {
		throw new Error(
			`Direct alignment coverage ${(alignment.report.directCoverage * 100).toFixed(1)}% is below the required ${(minDirectCoverage * 100).toFixed(1)}%; the ebook and timed text may be different editions`,
		);
	}
	const verificationStartedAt = performance.now();
	if (verificationProvider) {
		for (const [index, transcript] of transcripts.entries()) {
			const audioPath = options.audioPaths[index];
			const report = timedTextReports[index];
			if (!audioPath || !report || !dependencies.verifyTimedText) {
				throw new Error(`Could not verify timed-text source ${index + 1}`);
			}
			const verification = await dependencies.verifyTimedText({
				transcript,
				audioPath,
				provider: verificationProvider,
				language,
				samples: options.verificationSamples,
				signal: controls.signal,
			});
			report.verification = verification;
			if (verification.status === "failed") {
				throw new Error(
					`Timed-text verification failed for ${timedTextPaths[index]}: ${(verification.averageScore * 100).toFixed(1)}% average sample similarity`,
				);
			}
		}
	}
	const verificationMs = performance.now() - verificationStartedAt;
	const memory = process.memoryUsage();
	const manifest = parseHonomiyaManifest({
		schema: HONOMIYA_MANIFEST_SCHEMA,
		createdAt: dependencies.now().toISOString(),
		generator: { name: "honomiya", version: packageJson.version },
		transcription: {
			origin: timedTextPaths.length > 0 ? "external" : "honomiya",
		},
		granularity: "sentence",
		sources: {
			ebook: {
				sha256: ebookSha256,
				filename: basename(options.ebookPath),
			},
			audioFiles: transcripts.map((transcript, index) => ({
				index,
				sha256: audioHashes[index],
				filename: basename(options.audioPaths[index] ?? `audio-${index}`),
				durationMs: transcript.durationMs,
			})),
		},
		cues: alignment.cues.map(({ cue }) => cue),
	});

	return {
		manifest,
		subtitles: alignment.cues.map(({ cue, text }) => ({
			audioFileIndex: cue.audioFileIndex,
			startMs: cue.startMs,
			endMs: cue.endMs,
			text,
		})),
		report: {
			algorithm: ALIGNMENT_ALGORITHM_VERSION,
			normalization: TEXT_NORMALIZATION_VERSION,
			parameters: {
				...ALIGNMENT_PARAMETERS,
				quality,
				interpolationMode,
				...(minDirectCoverage === undefined ? {} : { minDirectCoverage }),
			},
			transcription: {
				mode: provider
					? "provider"
					: timedTextPaths.length > 0
						? "timed-text"
						: "precomputed",
				...(provider
					? {
							provider: {
								name: provider.name,
								revision: provider.revision,
							},
						}
					: {}),
				sources: transcripts.map((transcript, audioFileIndex) => {
					const transcriptionResult = transcriptionResults[audioFileIndex];
					return {
						audioFileIndex,
						provider: transcript.engine.provider,
						model: transcript.engine.model,
						...(transcript.engine.revision
							? { revision: transcript.engine.revision }
							: {}),
						...(transcript.engine.timestampBackend
							? { timestampBackend: transcript.engine.timestampBackend }
							: {}),
						...(transcriptionResult
							? {
									chunks: transcriptionResult.chunks,
									cacheHits: transcriptionResult.cacheHits,
									resumedJobs: transcriptionResult.resumedJobs,
									retries: transcriptionResult.retries,
									parallelChunks:
										options.parallelChunks ?? DEFAULT_PARALLEL_CHUNKS,
								}
							: {}),
					};
				}),
				...(timedTextReports.length > 0 ? { timedText: timedTextReports } : {}),
			},
			...(language ? { language } : {}),
			performance: {
				hashingMs: Math.round(hashingMs),
				transcriptionMs: Math.round(transcriptionMs),
				ebookExtractionMs: Math.round(ebookExtractionMs),
				alignmentMs: Math.round(alignmentMs),
				verificationMs: Math.round(verificationMs),
				totalMs: Math.round(performance.now() - startedAt),
				rssBytes: memory.rss,
				heapUsedBytes: memory.heapUsed,
			},
			alignment: alignment.report,
			cueEvidence: alignment.cues.map(({ cue, evidence }) => ({
				cueId: cue.id,
				method: evidence.kind,
				...(evidence.score === undefined ? {} : { score: evidence.score }),
				...(evidence.basis === undefined ? {} : { basis: evidence.basis }),
			})),
		},
	};
}

export async function executeAlignCommand(
	options: AlignOptions,
	controls: TranscriptionControls = {},
): Promise<AlignmentExecutionReport> {
	const result = await alignPublication(options, runtimeDependencies, controls);
	const reportPath = `${options.outputPath}.report.json`;
	await writeJsonAtomically(options.outputPath, result.manifest);
	const srtFiles = options.srt
		? await writeSrtArtifacts(
				options.outputPath,
				options.audioPaths,
				result.subtitles,
			)
		: [];
	const report: AlignmentExecutionReport = {
		...result.report,
		outputs: {
			alignment: options.outputPath,
			report: reportPath,
			srtFiles,
		},
	};
	await writeJsonAtomically(reportPath, report);
	return report;
}
