import { describe, expect, test } from "bun:test";
import {
	concatEmissions,
	decodeEmissions,
	emissionScore,
	encodeEmissions,
	greedyDecode,
	HONOMIYA_EMISSIONS_SCHEMA,
	quantizeScore,
	SparseEmissionsBuilder,
} from "./emissions";

const VOCABULARY = ["あ", "い", "う", "え", "<blk>"];
const BLANK = 4;

function header(startFrame: number) {
	return {
		schema: HONOMIYA_EMISSIONS_SCHEMA,
		model: {
			id: "test",
			revision: "test.1",
			timingCorrectionMs: { start: -100, end: -50 },
		},
		source: { sha256: "a".repeat(64), filename: "book.m4b" },
		sampleRate: 16_000,
		samplesPerFrame: 320,
		startFrame,
		sourceDurationMs: 1_000,
		vocabulary: VOCABULARY,
	};
}

/** Rows of log probabilities for 5 classes. */
function matrix(rows: number[][]): Float32Array {
	return Float32Array.from(rows.flat());
}

describe("sparse emissions", () => {
	test("keeps the blank and the best classes per frame", () => {
		const builder = new SparseEmissionsBuilder(2, BLANK);
		builder.append(
			matrix([
				[-0.1, -3, -2, -5, -4],
				[-6, -7, -0.2, -1.5, -0.3],
			]),
			5,
			0,
			2,
		);
		const emissions = builder.build(header(0));
		expect(Array.from(emissions.blank)).toEqual([-4_000, -300]);
		expect(Array.from(emissions.classes)).toEqual([0, 2, 2, 3]);
		expect(Array.from(emissions.scores)).toEqual([-100, -2_000, -200, -1_500]);
		expect(emissionScore(emissions, 0, 0)).toBeCloseTo(-0.1);
		expect(emissionScore(emissions, 0, BLANK)).toBeCloseTo(-4);
		// Class 1 was not kept, so it scores at the frame floor.
		expect(emissionScore(emissions, 0, 1)).toBeCloseTo(-2);
	});

	test("appends only the requested frame range", () => {
		const builder = new SparseEmissionsBuilder(1, BLANK);
		builder.append(
			matrix([
				[-1, -9, -9, -9, -0.1],
				[-0.1, -9, -9, -9, -3],
				[-9, -0.1, -9, -9, -3],
			]),
			5,
			1,
			3,
		);
		expect(builder.frames).toBe(2);
	});

	test("quantizes scores into int16 milli-nats", () => {
		expect(quantizeScore(0)).toBe(0);
		expect(quantizeScore(-1.2344)).toBe(-1_234);
		expect(quantizeScore(-100)).toBe(-32_768);
		expect(quantizeScore(Number.NEGATIVE_INFINITY)).toBe(-32_768);
		expect(quantizeScore(Number.NaN)).toBe(-32_768);
	});

	test("round-trips through the binary format", () => {
		const builder = new SparseEmissionsBuilder(2, BLANK);
		builder.append(matrix([[-0.1, -3, -2, -5, -4]]), 5, 0, 1);
		const emissions = builder.build(header(7));
		const bytes = encodeEmissions(emissions);
		const decoded = decodeEmissions(bytes);
		expect(decoded.header).toEqual(emissions.header);
		expect(Array.from(decoded.blank)).toEqual(Array.from(emissions.blank));
		expect(Array.from(decoded.classes)).toEqual(Array.from(emissions.classes));
		expect(Array.from(decoded.scores)).toEqual(Array.from(emissions.scores));

		const shifted = new Uint8Array(bytes.length + 1);
		shifted.set(bytes, 1);
		expect(decodeEmissions(shifted.subarray(1)).header.startFrame).toBe(7);
		expect(() => decodeEmissions(bytes.subarray(0, bytes.length - 2))).toThrow(
			/expected/,
		);
	});

	test("concatenates contiguous parts and rejects gaps", () => {
		const part = (startFrame: number, row: number[]) => {
			const builder = new SparseEmissionsBuilder(1, BLANK);
			builder.append(matrix([row]), 5, 0, 1);
			return builder.build(header(startFrame));
		};
		const joined = concatEmissions([
			part(0, [-0.1, -9, -9, -9, -3]),
			part(1, [-9, -0.1, -9, -9, -3]),
		]);
		expect(joined.header.frames).toBe(2);
		expect(Array.from(joined.classes)).toEqual([0, 1]);
		expect(() =>
			concatEmissions([part(0, [-1, -9, -9, -9, -1]), part(2, [-1, -9, -9, -9, -1])]),
		).toThrow(/contiguous/);
	});

	test("greedy-decodes with CTC collapsing", () => {
		const builder = new SparseEmissionsBuilder(1, BLANK);
		builder.append(
			matrix([
				[-0.1, -9, -9, -9, -3],
				[-0.1, -9, -9, -9, -3],
				[-9, -9, -9, -9, -0.1],
				[-0.1, -9, -9, -9, -3],
				[-9, -0.1, -9, -9, -3],
			]),
			5,
			0,
			5,
		);
		expect(greedyDecode(builder.build(header(0)))).toEqual({
			text: "ああい",
			frames: [0, 3, 4],
		});
	});
});
