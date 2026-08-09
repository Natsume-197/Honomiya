import { describe, expect, test } from "bun:test";
import {
	alignmentTokens,
	normalizeAlignmentToken,
	normalizeVisibleText,
} from "./text";

describe("alignment text normalization", () => {
	test("normalizes presentation differences without losing letters", () => {
		expect(normalizeVisibleText("  Hello\n\tworld  ")).toBe("Hello world");
		expect(normalizeAlignmentToken("Ｄon’t", "en")).toBe("dont");
	});

	test("segments languages that do not use spaces", () => {
		const tokens = alignmentTokens("吾輩は猫である。", "ja");

		expect(tokens).toEqual(["吾", "輩", "は", "猫", "で", "あ", "る"]);
	});

	test("uses stable character units for mixed CJK text", () => {
		expect(alignmentTokens("第1話 Story", "ja")).toEqual([
			"第",
			"1",
			"話",
			"s",
			"t",
			"o",
			"r",
			"y",
		]);
	});
});
