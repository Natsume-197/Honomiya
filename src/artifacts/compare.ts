import type { HonomiyaManifest, ReadListenCue } from "./manifest";

export const MANIFEST_COMPARISON_SCHEMA = "honomiya.comparison.v1" as const;
export const DEFAULT_TOLERANCES_MS = [100, 250, 500, 1_000] as const;

export interface ErrorDistribution {
	mean: number;
	p50: number;
	p90: number;
	p99: number;
	max: number;
}

export interface ManifestComparison {
	schema: typeof MANIFEST_COMPARISON_SCHEMA;
	sameEbook: boolean;
	sameAudio: boolean;
	referenceCues: number;
	candidateCues: number;
	/** Cues present in both manifests on the same audio file. */
	matchedCues: number;
	/** Reference cues with no candidate cue of the same id. */
	missingCues: number;
	/** Candidate cues with no reference cue of the same id. */
	extraCues: number;
	/** Cues present in both manifests but placed on a different audio file. */
	wrongAudioFileCues: number;
	/** matchedCues / referenceCues. */
	recall: number;
	startErrorMs: ErrorDistribution | null;
	endErrorMs: ErrorDistribution | null;
	/** Mean temporal intersection-over-union of matched cues. */
	meanIou: number | null;
	/**
	 * Share of reference cues whose candidate start and end are both within
	 * the tolerance. Missing and misplaced cues count as failures.
	 */
	withinTolerance: Array<{ toleranceMs: number; share: number }>;
}

function quantile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const position = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(fraction * sorted.length) - 1),
	);
	return sorted[position] ?? 0;
}

function distribution(values: number[]): ErrorDistribution | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	return {
		mean: Math.round(total / sorted.length),
		p50: quantile(sorted, 0.5),
		p90: quantile(sorted, 0.9),
		p99: quantile(sorted, 0.99),
		max: sorted.at(-1) ?? 0,
	};
}

function intersectionOverUnion(
	left: ReadListenCue,
	right: ReadListenCue,
): number {
	const intersection = Math.max(
		0,
		Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs),
	);
	const union =
		Math.max(left.endMs, right.endMs) - Math.min(left.startMs, right.startMs);
	return union > 0 ? intersection / union : 0;
}

/**
 * Compares a candidate manifest against a reference manifest of the same
 * ebook. Cues are paired by id, which is stable for a given ebook and text
 * normalization version.
 */
export function compareManifests(
	candidate: HonomiyaManifest,
	reference: HonomiyaManifest,
	tolerancesMs: readonly number[] = DEFAULT_TOLERANCES_MS,
): ManifestComparison {
	const candidateById = new Map(candidate.cues.map((cue) => [cue.id, cue]));
	const referenceIds = new Set(reference.cues.map((cue) => cue.id));
	const startErrors: number[] = [];
	const endErrors: number[] = [];
	const ious: number[] = [];
	let wrongAudioFileCues = 0;
	let missingCues = 0;

	for (const expected of reference.cues) {
		const actual = candidateById.get(expected.id);
		if (!actual) {
			missingCues += 1;
			continue;
		}
		if (actual.audioFileIndex !== expected.audioFileIndex) {
			wrongAudioFileCues += 1;
			continue;
		}
		startErrors.push(Math.abs(actual.startMs - expected.startMs));
		endErrors.push(Math.abs(actual.endMs - expected.endMs));
		ious.push(intersectionOverUnion(actual, expected));
	}

	const matchedCues = startErrors.length;
	const referenceCues = reference.cues.length;
	const audioHashes = (manifest: HonomiyaManifest) =>
		manifest.sources.audioFiles
			.map((audio) => `${audio.index}:${audio.sha256}`)
			.sort()
			.join(",");

	return {
		schema: MANIFEST_COMPARISON_SCHEMA,
		sameEbook:
			candidate.sources.ebook.sha256 === reference.sources.ebook.sha256,
		sameAudio: audioHashes(candidate) === audioHashes(reference),
		referenceCues,
		candidateCues: candidate.cues.length,
		matchedCues,
		missingCues,
		extraCues: candidate.cues.filter((cue) => !referenceIds.has(cue.id))
			.length,
		wrongAudioFileCues,
		recall: referenceCues > 0 ? matchedCues / referenceCues : 0,
		startErrorMs: distribution(startErrors),
		endErrorMs: distribution(endErrors),
		meanIou:
			ious.length > 0
				? ious.reduce((sum, value) => sum + value, 0) / ious.length
				: null,
		withinTolerance: tolerancesMs.map((toleranceMs) => ({
			toleranceMs,
			share:
				referenceCues > 0
					? startErrors.filter(
							(error, index) =>
								error <= toleranceMs &&
								(endErrors[index] ?? Number.POSITIVE_INFINITY) <= toleranceMs,
						).length / referenceCues
					: 0,
		})),
	};
}
