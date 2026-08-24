import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenEditSimilarity } from "../alignment/sequence";
import { alignmentTokens } from "../alignment/text";
import {
	type AudioChunk,
	chunkExtension,
	extractAudioChunk,
} from "../transcription/chunks";
import type { TranscriptionProvider } from "../transcription/provider";
import type { HonomiyaTranscript } from "../transcription/transcript";

export const DEFAULT_TIMED_TEXT_VERIFICATION_SAMPLES = 3;
const SAMPLE_PADDING_MS = 1_000;
const MAX_SAMPLE_DURATION_MS = 20_000;
const MIN_SAMPLE_SCORE = 0.25;
const MIN_AVERAGE_SCORE = 0.35;

export interface TimedTextVerificationSample {
	startMs: number;
	endMs: number;
	expectedText: string;
	recognizedText: string;
	score: number;
}

export interface TimedTextVerificationReport {
	provider: { name: string; revision: string };
	status: "passed" | "failed";
	confidence: "high" | "medium" | "low";
	averageScore: number;
	passingSamples: number;
	totalSamples: number;
	samples: TimedTextVerificationSample[];
}

export interface TimedTextVerificationDependencies {
	makeTemporaryDirectory(): Promise<string>;
	removeTemporaryDirectory(path: string): Promise<void>;
	extract(
		inputPath: string,
		chunk: AudioChunk,
		outputPath: string,
	): Promise<void>;
}

const runtimeDependencies: TimedTextVerificationDependencies = {
	makeTemporaryDirectory: () => mkdtemp(join(tmpdir(), "honomiya-verify-")),
	removeTemporaryDirectory: (path) =>
		rm(path, { recursive: true, force: true }),
	extract: extractAudioChunk,
};

function tokenRecall(expected: string[], recognized: string[]): number {
	if (expected.length === 0 || recognized.length === 0) return 0;
	const remaining = new Map<string, number>();
	for (const token of recognized) {
		remaining.set(token, (remaining.get(token) ?? 0) + 1);
	}
	let matches = 0;
	for (const token of expected) {
		const count = remaining.get(token) ?? 0;
		if (count <= 0) continue;
		matches += 1;
		remaining.set(token, count - 1);
	}
	return matches / expected.length;
}

export function timedTextSampleScore(
	expectedText: string,
	recognizedText: string,
	language?: string,
): number {
	const expected = alignmentTokens(expectedText, language);
	const recognized = alignmentTokens(recognizedText, language);
	return Math.max(
		tokenRecall(expected, recognized),
		tokenEditSimilarity(expected, recognized),
	);
}

export function planTimedTextVerificationSamples(
	transcript: HonomiyaTranscript,
	requestedSamples = DEFAULT_TIMED_TEXT_VERIFICATION_SAMPLES,
): Array<{ startMs: number; endMs: number; expectedText: string }> {
	if (!Number.isInteger(requestedSamples) || requestedSamples <= 0) {
		throw new Error(
			"Timed-text verification samples must be a positive integer",
		);
	}
	const candidates = transcript.segments.filter(
		(segment) => segment.text.trim().length > 0,
	);
	if (candidates.length === 0) return [];
	const count = Math.min(requestedSamples, candidates.length);
	const selected = Array.from({ length: count }, (_, index) => {
		const position = Math.min(
			candidates.length - 1,
			Math.floor(((index + 0.5) * candidates.length) / count),
		);
		return candidates[position];
	}).filter((segment): segment is NonNullable<typeof segment> =>
		Boolean(segment),
	);

	return selected.map((segment) => {
		const startMs = Math.max(0, segment.startMs - SAMPLE_PADDING_MS);
		const desiredEndMs = Math.min(
			transcript.durationMs,
			segment.endMs + SAMPLE_PADDING_MS,
			startMs + MAX_SAMPLE_DURATION_MS,
		);
		const endMs = Math.max(startMs + 1, desiredEndMs);
		const expectedText = transcript.segments
			.filter(
				(candidate) => candidate.startMs < endMs && candidate.endMs > startMs,
			)
			.map((candidate) => candidate.text)
			.join(" ");
		return { startMs, endMs, expectedText };
	});
}

export async function verifyTimedTextAgainstAudio(
	input: {
		transcript: HonomiyaTranscript;
		audioPath: string;
		provider: TranscriptionProvider;
		language?: string;
		samples?: number;
		signal?: AbortSignal;
	},
	dependencies: TimedTextVerificationDependencies = runtimeDependencies,
): Promise<TimedTextVerificationReport> {
	const planned = planTimedTextVerificationSamples(
		input.transcript,
		input.samples ?? DEFAULT_TIMED_TEXT_VERIFICATION_SAMPLES,
	);
	if (planned.length === 0) {
		throw new Error("Timed-text verification requires at least one usable cue");
	}
	const directory = await dependencies.makeTemporaryDirectory();
	const samples: TimedTextVerificationSample[] = [];
	try {
		for (const [index, sample] of planned.entries()) {
			const outputPath = join(
				directory,
				`sample-${index + 1}${chunkExtension(input.audioPath)}`,
			);
			await dependencies.extract(
				input.audioPath,
				{
					index,
					startMs: sample.startMs,
					endMs: sample.endMs,
					ownedStartMs: sample.startMs,
					ownedEndMs: sample.endMs,
					chapterIndexes: [],
				},
				outputPath,
			);
			const recognized = await input.provider.transcribe({
				audioPath: outputPath,
				language: input.language,
				offsetMs: sample.startMs,
				signal: input.signal,
			});
			const recognizedText = recognized.segments
				.map((segment) => segment.text)
				.join(" ")
				.trim();
			samples.push({
				...sample,
				recognizedText,
				score: timedTextSampleScore(
					sample.expectedText,
					recognizedText,
					input.language ?? input.transcript.language,
				),
			});
		}
	} finally {
		await dependencies.removeTemporaryDirectory(directory);
	}

	const averageScore =
		samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length;
	const passingSamples = samples.filter(
		(sample) => sample.score >= MIN_SAMPLE_SCORE,
	).length;
	const passed =
		averageScore >= MIN_AVERAGE_SCORE &&
		passingSamples >= Math.ceil(samples.length / 2);
	const confidence = !passed
		? "low"
		: averageScore >= 0.7 && passingSamples === samples.length
			? "high"
			: "medium";
	return {
		provider: { name: input.provider.name, revision: input.provider.revision },
		status: passed ? "passed" : "failed",
		confidence,
		averageScore,
		passingSamples,
		totalSamples: samples.length,
		samples,
	};
}
