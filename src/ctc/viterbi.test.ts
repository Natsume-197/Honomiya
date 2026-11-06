import { describe, expect, test } from "bun:test";
import { HONOMIYA_EMISSIONS_SCHEMA, SparseEmissionsBuilder } from "./emissions";
import { STAR } from "./text";
import { EmissionReader, forcedAlign, segmentScores } from "./viterbi";

const CLASSES = 5; // a, b, c, d, blank
const BLANK = 4;

/** Emissions where `spikes[frame]` is the class spoken there (else blank). */
function emissions(spikes: Array<number | undefined>, startFrame = 0) {
	const rows = spikes.flatMap((spike) => {
		const row = Array.from({ length: CLASSES }, () => -9);
		if (spike === undefined) row[BLANK] = -0.01;
		else {
			row[spike] = -0.05;
			row[BLANK] = -3;
		}
		return row;
	});
	const builder = new SparseEmissionsBuilder(2, BLANK);
	builder.append(Float32Array.from(rows), CLASSES, 0, spikes.length);
	return builder.build({
		schema: HONOMIYA_EMISSIONS_SCHEMA,
		model: { id: "t", revision: "t.1", timingCorrectionMs: { start: 0, end: 0 } },
		source: { sha256: "c".repeat(64) },
		sampleRate: 16_000,
		samplesPerFrame: 320,
		startFrame,
		sourceDurationMs: 60_000,
		vocabulary: ["a", "b", "c", "d", "<blk>"],
	});
}

// Class sets: one per class, so set id = class id.
const SETS = [0, 1, 2, 3].map((classId) => Int32Array.of(classId));

describe("forcedAlign", () => {
	test("places each token on its spoken frames", () => {
		const _ = undefined;
		const reader = new EmissionReader([emissions([_, 0, 0, _, 1, _, _, 2, _, _])]);
		const tokens = Int32Array.of(0, 1, 2);
		const result = forcedAlign(segmentScores(reader, SETS, tokens, 0, 10), tokens);
		expect(Array.from(result.firstFrame)).toEqual([1, 4, 7]);
		expect(Array.from(result.lastFrame)).toEqual([2, 4, 7]);
		expect(result.tokenScore[0]).toBeCloseTo(-0.05);
	});

	test("separates repeated tokens with a blank", () => {
		const _ = undefined;
		const reader = new EmissionReader([emissions([0, 0, _, 0, _, _])]);
		const tokens = Int32Array.of(0, 0);
		const result = forcedAlign(segmentScores(reader, SETS, tokens, 0, 6), tokens);
		expect(Array.from(result.firstFrame)).toEqual([0, 3]);
	});

	test("lets free edges skip audio that is not in the text", () => {
		const _ = undefined;
		// d is spoken first but is not part of the text.
		const reader = new EmissionReader([emissions([3, 3, _, 0, _, 1, _, 3, 3, _])]);
		const tokens = Int32Array.of(0, 1);
		const free = forcedAlign(segmentScores(reader, SETS, tokens, 0, 10), tokens, {
			freeStart: true,
			freeEnd: true,
		});
		expect(Array.from(free.firstFrame)).toEqual([3, 5]);
		expect(Array.from(free.lastFrame)).toEqual([3, 5]);
	});

	test("lets a STAR token absorb an unknown character", () => {
		const _ = undefined;
		const reader = new EmissionReader([emissions([0, _, 3, 3, _, 1, _])]);
		const tokens = Int32Array.of(0, STAR, 1);
		const result = forcedAlign(segmentScores(reader, SETS, tokens, 0, 7), tokens);
		expect(result.firstFrame[0]).toBe(0);
		expect(result.firstFrame[1]).toBeGreaterThanOrEqual(1);
		expect(result.lastFrame[1]).toBeLessThan(5);
		expect(result.firstFrame[2]).toBe(5);
	});

	test("reads frames across tracks on the global axis", () => {
		const _ = undefined;
		const reader = new EmissionReader([emissions([_, 0, _]), emissions([_, 1, _])]);
		expect(reader.totalFrames).toBe(6);
		const tokens = Int32Array.of(0, 1);
		const result = forcedAlign(segmentScores(reader, SETS, tokens, 0, 6), tokens);
		expect(Array.from(result.firstFrame)).toEqual([1, 4]);
	});

	test("reports when the tokens cannot fit", () => {
		const reader = new EmissionReader([emissions([0, 1])]);
		const tokens = Int32Array.of(0, 1, 2);
		expect(forcedAlign(segmentScores(reader, SETS, tokens, 0, 2), tokens).score).toBe(
			Number.NEGATIVE_INFINITY,
		);
	});
});
