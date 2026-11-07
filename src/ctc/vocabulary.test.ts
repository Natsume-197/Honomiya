import { describe, expect, test } from "bun:test";
import { parseVocabularyText } from "./vocabulary";

describe("parseVocabularyText", () => {
	test("reads tokens by index, including a space token and CRLF", () => {
		const vocabulary = parseVocabularyText("學 0\r\n  1\nみ 2\n<blk> 3\n");
		expect(vocabulary).toEqual({ tokens: ["學", " ", "み", "<blk>"], blank: 3 });
	});

	test("rejects gaps, duplicates and a missing blank", () => {
		expect(() => parseVocabularyText("a 0\n<blk> 2\n")).toThrow(/missing index 1/);
		expect(() => parseVocabularyText("a 0\nb 0\n<blk> 1\n")).toThrow(/Duplicate/);
		expect(() => parseVocabularyText("a 0\nb 1\n")).toThrow(/no blank/);
		expect(() => parseVocabularyText("a x\n")).toThrow(/line 1/);
	});
});
