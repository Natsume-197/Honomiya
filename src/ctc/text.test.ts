import { describe, expect, test } from "bun:test";
import {
	conditionText,
	kanjiNumeral,
	resolveAlternatives,
	STAR,
	VocabularyIndex,
} from "./text";
import type { CtcVocabulary } from "./vocabulary";

// A small vocabulary shaped like QuartzNet-ja: hiragana and katakana, both
// digit widths, full-width Latin, punctuation and a blank.
const TOKENS = [
	"空", "は", "見", "た", "セ", "リ", "カ", "か", "な", "た", "ぎ", "ょ", "く",
	"よ", "1", "１", "3", "十", "三", "千", "二", "八", "。", "Ｖ", "嘘", "ン", "<blk>",
];
const VOCABULARY: CtcVocabulary = { tokens: TOKENS, blank: TOKENS.length - 1 };
const id = (token: string) => TOKENS.indexOf(token);

function classesOf(text: ReturnType<typeof conditionText>, tokens: Int32Array) {
	return Array.from(tokens, (token) =>
		token === STAR ? "*" : Array.from(text.classSets[token] ?? []).map((c) => TOKENS[c]).join("|"),
	);
}

describe("kanjiNumeral", () => {
	test("reads digit runs as Japanese numerals", () => {
		expect(kanjiNumeral("0")).toBe("〇");
		expect(kanjiNumeral("13")).toBe("十三");
		expect(kanjiNumeral("20")).toBe("二十");
		expect(kanjiNumeral("102")).toBe("百二");
		expect(kanjiNumeral("2008")).toBe("二千八");
		expect(kanjiNumeral("10000")).toBe("一万");
		expect(kanjiNumeral("11000")).toBe("一万千");
		expect(kanjiNumeral("120000000")).toBe("一億二千万");
		expect(kanjiNumeral("007")).toBe("〇〇七");
	});
});

describe("VocabularyIndex", () => {
	test("groups equivalent classes into one token set", () => {
		const index = new VocabularyIndex(VOCABULARY);
		const set = (character: string) => {
			const token = index.tokenFor(character);
			return token === STAR ? [] : Array.from(index.classSets[token] ?? []).map((c) => TOKENS[c]);
		};
		// Duplicate vocabulary entries, both digit widths, kana scripts.
		expect(set("た")).toEqual(["た", "た"]);
		expect(set("１")).toEqual(["1", "１"]);
		expect(set("か")).toEqual(["カ", "か"]);
		expect(set("V")).toEqual(["Ｖ"]);
		expect(set("噓")).toEqual(["嘘"]);
		expect(index.tokenFor("猫")).toBe(STAR);
		expect(index.tokenFor("た")).toBe(index.tokenFor("た"));
	});
});

describe("conditionText", () => {
	test("maps characters to tokens with their source offsets", () => {
		const text = conditionText([{ text: "空は、猫を見た。" }, { text: "Ｖか" }], VOCABULARY, {
			locale: "ja",
		});
		expect(classesOf(text, text.tokens)).toEqual([
			"空", "は", "*", "*", "見", "た|た", "Ｖ", "カ|か",
		]);
		expect(Array.from(text.sentence)).toEqual([0, 0, 0, 0, 0, 0, 1, 1]);
		expect(Array.from(text.sourceStart)).toEqual([0, 1, 3, 4, 5, 6, 0, 1]);
		expect(text.stats).toMatchObject({ characters: 8, mapped: 6, star: 2, droppedSymbols: 2 });
		expect(text.word.every((word) => word >= 0)).toBe(true);
	});

	test("offers ruby readings, with small kana, as alternatives", () => {
		const text = conditionText(
			[{ text: "空は玉", ruby: [{ start: 0, end: 1, reading: "セリカ" }, { start: 2, end: 3, reading: "ぎよく" }] }],
			VOCABULARY,
		);
		expect(text.alternatives.map((a) => [a.kind, a.tokenStart, a.tokenEnd])).toEqual([
			["ruby", 0, 1],
			["ruby", 2, 3],
		]);
		expect(classesOf(text, text.alternatives[1]?.tokens ?? new Int32Array())).toEqual([
			"ぎ", "ょ|よ", "く",
		]);
		const resolved = resolveAlternatives(text, new Set(["ruby"]));
		expect(classesOf(text, resolved.tokens)).toEqual([
			"セ", "リ", "カ|か", "は", "ぎ", "ょ|よ", "く",
		]);
		expect(Array.from(resolved.originStart)).toEqual([0, 0, 0, 1, 2, 2, 2]);
		expect(Array.from(resolved.originEnd)).toEqual([1, 1, 1, 2, 3, 3, 3]);
		expect(classesOf(text, resolveAlternatives(text, new Set()).tokens)).toEqual([
			"空", "は", "*",
		]);
	});

	test("keeps digits and offers a kanji numeral reading", () => {
		const text = conditionText([{ text: "第13巻" }], VOCABULARY);
		expect(classesOf(text, text.tokens)).toEqual(["*", "1|１", "3", "*"]);
		expect(text.alternatives).toHaveLength(1);
		expect(text.alternatives[0]).toMatchObject({ kind: "numeral", tokenStart: 1, tokenEnd: 3 });
		expect(classesOf(text, text.alternatives[0]?.tokens ?? new Int32Array())).toEqual(["十", "三"]);
		expect(text.stats.numeralRuns).toBe(1);
		expect(id("十")).toBeGreaterThan(0);
	});
});
