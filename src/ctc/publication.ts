import { basename } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { extractEbookSentences } from "../alignment/ebook-text";
import type {
	AlignmentExecutionReport,
	PublicationAlignmentResult,
} from "../alignment/publication";
import { TEXT_NORMALIZATION_VERSION } from "../alignment/text";
import {
	HONOMIYA_MANIFEST_SCHEMA,
	HONOMIYA_MANIFEST_V2_SCHEMA,
	parseHonomiyaManifest,
	parseHonomiyaManifestV2,
} from "../artifacts/manifest";
import type { EbookDocument } from "../ebook-parser/ebook";
import { openEbookFile } from "../ebook-parser/node";
import type { AlignOptions } from "../options/align";
import { hashFileSha256 } from "../support/file-hash";
import type { TranscriptionControls } from "../transcription/audio";
import {
	type CtcAlignmentReport,
	DEFAULT_CTC_ALIGNMENT_OPTIONS,
	alignWithCtc,
} from "./align";
import { type EmitAudioRequest, type EmitAudioResult, emitAudio } from "./emit";
import { type CtcEmissions, decodeEmissions } from "./emissions";
import {
	type CtcPrecision,
	defaultModelDirectory,
	type InstalledCtcModel,
	requireInstalledModel,
} from "./model-store";
import { ctcModel, DEFAULT_CTC_MODEL_ID, defaultCtcModelForLanguage } from "./models";
import { BOUNDARY_SEARCH_VERSION } from "./search";
import { TEXT_CONDITIONING_VERSION } from "./text";

export interface CtcPublicationReport extends CtcAlignmentReport {
	model: { id: string; revision: string; timingCorrectionMs: { start: number; end: number } };
	versions: { search: string; text: string };
	emission: Array<{
		audioFileIndex: number;
		source: "emitted" | "precomputed";
		frames: number;
		chunks?: number;
		cacheHits?: number;
	}>;
}

export interface CtcPublicationDependencies {
	openEbook(path: string): Promise<EbookDocument>;
	hashFile(path: string): Promise<string>;
	readEmissions(path: string): Promise<CtcEmissions>;
	requireModel(
		id: string,
		modelDir: string | undefined,
		precision: CtcPrecision | "auto",
	): Promise<InstalledCtcModel>;
	emit(request: EmitAudioRequest): Promise<EmitAudioResult>;
	now(): Date;
}

const runtimeDependencies: CtcPublicationDependencies = {
	openEbook: openEbookFile,
	hashFile: hashFileSha256,
	readEmissions: async (path) => decodeEmissions(new Uint8Array(await Bun.file(path).arrayBuffer())),
	requireModel: (id, modelDir, precision) =>
		requireInstalledModel(ctcModel(id), modelDir ?? defaultModelDirectory(), precision),
	emit: (request) => emitAudio(request),
	now: () => new Date(),
};

export async function alignPublicationWithCtc(
	options: AlignOptions,
	dependencies: CtcPublicationDependencies = runtimeDependencies,
	controls: TranscriptionControls = {},
): Promise<PublicationAlignmentResult> {
	const startedAt = performance.now();
	const hashingStartedAt = performance.now();
	const [ebookSha256, audioHashes] = await Promise.all([
		dependencies.hashFile(options.ebookPath),
		Promise.all(options.audioPaths.map((path) => dependencies.hashFile(path))),
	]);
	const hashingMs = performance.now() - hashingStartedAt;

	const ebook = await dependencies.openEbook(options.ebookPath);
	const language = (options.language ?? ebook.metadata.language) || undefined;
	const extractionStartedAt = performance.now();
	let sentences: Awaited<ReturnType<typeof extractEbookSentences>>;
	try {
		sentences = await extractEbookSentences(ebook, language);
	} finally {
		await ebook.close();
	}
	const ebookExtractionMs = performance.now() - extractionStartedAt;

	// Emissions: precomputed files, or computed (and cached) now.
	const emissionStartedAt = performance.now();
	const tracks: CtcEmissions[] = [];
	const emissionReports: CtcPublicationReport["emission"] = [];
	let installed: InstalledCtcModel | undefined;
	for (const [audioFileIndex, audioPath] of options.audioPaths.entries()) {
		const audioSha256 = audioHashes[audioFileIndex] as string;
		const precomputed = options.emissionsPaths?.[audioFileIndex];
		if (precomputed) {
			const emissions = await dependencies.readEmissions(precomputed);
			if (emissions.header.source.sha256 !== audioSha256) {
				throw new Error(`Emissions ${precomputed} do not match audio ${audioPath}`);
			}
			if (emissions.header.startFrame !== 0) {
				throw new Error(`Emissions ${precomputed} do not start at the beginning of the audio`);
			}
			tracks.push(emissions);
			emissionReports.push({
				audioFileIndex,
				source: "precomputed",
				frames: emissions.header.frames,
			});
			continue;
		}
		installed ??= await dependencies.requireModel(
			options.ctcModel ?? defaultCtcModelForLanguage(language)?.id ?? DEFAULT_CTC_MODEL_ID,
			options.modelDir,
			options.precision ?? "auto",
		);
		const result = await dependencies.emit({
			audioPath,
			audioSha256,
			model: installed,
			cacheDir: options.cacheDir ?? `${options.outputPath}.cache`,
			threads: options.threads,
			signal: controls.signal,
			onProgress: (progress) =>
				controls.onProgress?.({
					...progress,
					sourceIndex: audioFileIndex,
					totalSources: options.audioPaths.length,
				}),
		});
		tracks.push(result.emissions);
		emissionReports.push({
			audioFileIndex,
			source: "emitted",
			frames: result.emissions.header.frames,
			chunks: result.chunks,
			cacheHits: result.cacheHits,
		});
	}
	const emissionMs = performance.now() - emissionStartedAt;

	const alignmentStartedAt = performance.now();
	const aligned = alignWithCtc(sentences, tracks, { locale: language });
	const alignmentMs = performance.now() - alignmentStartedAt;
	if (
		options.minDirectCoverage !== undefined &&
		aligned.report.directCoverage < options.minDirectCoverage
	) {
		throw new Error(
			`Direct alignment coverage ${(aligned.report.directCoverage * 100).toFixed(1)}% is below the required ${(options.minDirectCoverage * 100).toFixed(1)}%`,
		);
	}

	const header = (tracks[0] as CtcEmissions).header;
	const manifestBase = {
		createdAt: dependencies.now().toISOString(),
		generator: { name: "honomiya" as const, version: packageJson.version },
		transcription: { origin: "honomiya" as const },
		sources: {
			ebook: { sha256: ebookSha256, filename: basename(options.ebookPath) },
			audioFiles: tracks.map((track, index) => ({
				index,
				sha256: audioHashes[index] as string,
				filename: basename(options.audioPaths[index] ?? `audio-${index}`),
				durationMs: track.header.sourceDurationMs,
			})),
		},
	};
	const manifest = options.words
		? parseHonomiyaManifestV2({
				...manifestBase,
				schema: HONOMIYA_MANIFEST_V2_SCHEMA,
				granularity: "word",
				cues: aligned.cues.map(({ cue, words }) =>
					words.length > 0 ? { ...cue, words } : cue,
				),
			})
		: parseHonomiyaManifest({
				...manifestBase,
				schema: HONOMIYA_MANIFEST_SCHEMA,
				granularity: "sentence",
				cues: aligned.cues.map(({ cue }) => cue),
			});
	const memory = process.memoryUsage();
	const report: AlignmentExecutionReport = {
		algorithm: "honomiya.align.v6",
		normalization: TEXT_NORMALIZATION_VERSION,
		parameters: {
			engine: "ctc",
			...DEFAULT_CTC_ALIGNMENT_OPTIONS,
			...(options.minDirectCoverage === undefined ? {} : { minDirectCoverage: options.minDirectCoverage }),
		},
		transcription: {
			mode: "ctc",
			sources: tracks.map((track, audioFileIndex) => ({
				audioFileIndex,
				provider: "ctc",
				model: track.header.model.id,
				revision: track.header.model.revision,
			})),
		},
		...(language ? { language } : {}),
		performance: {
			hashingMs: Math.round(hashingMs),
			transcriptionMs: Math.round(emissionMs),
			ebookExtractionMs: Math.round(ebookExtractionMs),
			alignmentMs: Math.round(alignmentMs),
			verificationMs: 0,
			totalMs: Math.round(performance.now() - startedAt),
			rssBytes: memory.rss,
			heapUsedBytes: memory.heapUsed,
		},
		alignment: aligned.report,
		ctc: {
			...aligned.ctc,
			model: {
				id: header.model.id,
				revision: header.model.revision,
				timingCorrectionMs: header.model.timingCorrectionMs,
			},
			versions: { search: BOUNDARY_SEARCH_VERSION, text: TEXT_CONDITIONING_VERSION },
			emission: emissionReports,
		},
		cueEvidence: aligned.cues.map(({ cue, evidence }) => ({
			cueId: cue.id,
			method: evidence.kind,
			...(evidence.score === undefined ? {} : { score: evidence.score }),
		})),
	};
	return {
		manifest,
		report,
		subtitles: aligned.cues.map(({ cue, text }) => ({
			audioFileIndex: cue.audioFileIndex,
			startMs: cue.startMs,
			endMs: cue.endMs,
			text,
		})),
	};
}
