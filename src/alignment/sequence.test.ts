import { describe, expect, test } from "bun:test";
import { alignTokenSequences, tokenEditSimilarity } from "./sequence";

describe("token sequence alignment", () => {
	test("keeps monotonic anchors around ASR insertions and substitutions", () => {
		const pairs = alignTokenSequences(
			["the", "quick", "brown", "fox", "runs"],
			["intro", "the", "quick", "red", "fox", "runs"],
		);

		expect(
			pairs.filter((pair) => pair.exact).map((pair) => pair.bookIndex),
		).toEqual([0, 1, 3, 4]);
		expect(
			pairs.every(
				(pair, index) =>
					index === 0 || pair.audioIndex > (pairs[index - 1]?.audioIndex ?? -1),
			),
		).toBe(true);
	});

	test("scores normalized edit similarity", () => {
		expect(tokenEditSimilarity(["one", "two"], ["one", "two"])).toBe(1);
		expect(tokenEditSimilarity(["one", "two"], ["one", "too"])).toBe(0.5);
	});

	test("keeps anchors around one long contiguous omission", () => {
		const prefix = ["alpha", "beta", "gamma"];
		const suffix = ["delta", "epsilon", "omega"];
		const omitted = Array.from(
			{ length: 40 },
			(_, index) => `missing-${index}`,
		);
		const pairs = alignTokenSequences(
			[...prefix, ...omitted, ...suffix],
			[...prefix, ...suffix],
		).filter((pair) => pair.exact);

		expect(pairs.slice(0, 3).map((pair) => pair.audioIndex)).toEqual([0, 1, 2]);
		expect(pairs.slice(-3).map((pair) => pair.audioIndex)).toEqual([3, 4, 5]);
	});
});
