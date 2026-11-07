import { describe, expect, test } from "bun:test";
import { extractSectionSentences } from "./ebook-text";

describe("EPUB sentence extraction", () => {
	test("keeps a single sentence with an existing fragment ID", () => {
		const sentences = extractSectionSentences(
			'<h1 id="chapter-one">Chapter One</h1><p>First sentence. Second sentence!</p>',
			"chapter-1",
			0,
			"en",
		);

		expect(sentences).toHaveLength(3);
		expect(sentences[0]).toMatchObject({
			text: "Chapter One",
			anchor: {
				kind: "fragment",
				sectionRef: "chapter-1",
				fragmentId: "chapter-one",
			},
		});
		expect(sentences[1]?.anchor).toEqual({
			kind: "text-quote",
			sectionRef: "chapter-1",
			exact: "First sentence.",
			suffix: "Second sentence!",
		});
		expect(sentences[1]?.sourceRange).toEqual({
			startUtf16: 0,
			endUtf16: "First sentence.".length,
		});
	});

	test("does not duplicate nested readable blocks", () => {
		const sentences = extractSectionSentences(
			"<blockquote><p>Quoted sentence.</p></blockquote>",
			"chapter-2",
			1,
			"en",
		);

		expect(sentences.map((sentence) => sentence.text)).toEqual([
			"Quoted sentence.",
		]);
	});

	test("ignores navigation and preserves Japanese sentence boundaries", () => {
		const sentences = extractSectionSentences(
			"<nav><p>目次。</p></nav><p>吾輩は猫である。名前はまだ無い。</p>",
			"chapter-3",
			2,
			"ja",
		);

		expect(sentences.map((sentence) => sentence.text)).toEqual([
			"吾輩は猫である。",
			"名前はまだ無い。",
		]);
		expect(sentences.every((sentence) => sentence.tokens.length > 0)).toBe(
			true,
		);
	});

	test("normalizes inline whitespace and line breaks", () => {
		const [sentence] = extractSectionSentences(
			"<p>Hello <em>dear</em><br> reader.</p>",
			"chapter-4",
			3,
			"en",
		);

		expect(sentence?.text).toBe("Hello dear reader.");
	});

	test("records ruby readings as spans of the sentence text", () => {
		const sentences = extractSectionSentences(
			"<p>前文。<ruby><rb>空</rb><rt>セリカ</rt></ruby>は<ruby><rb>荘</rb><rt>そう</rt><rb>厳</rb><rt>ごん</rt></ruby>な<ruby>彼方<rp>(</rp><rt>かなた</rt><rp>)</rp></ruby>を見た。</p>",
			"chapter-6",
			5,
			"ja",
		);
		expect(sentences.map((sentence) => sentence.text)).toEqual([
			"前文。",
			"空は荘厳な彼方を見た。",
		]);
		expect(sentences[0]?.ruby).toBeUndefined();
		expect(sentences[1]?.ruby).toEqual([
			{ start: 0, end: 1, reading: "セリカ" },
			{ start: 2, end: 3, reading: "そう" },
			{ start: 3, end: 4, reading: "ごん" },
			{ start: 5, end: 7, reading: "かなた" },
		]);
	});

	test("keeps ruby offsets through whitespace collapsing and nested markup", () => {
		const [sentence] = extractSectionSentences(
			'<p>  An   <ruby><span class="c7">老舗</span><rt><span>しにせ</span></rt></ruby>  shop <ruby>無印<rt></rt></ruby>.</p>',
			"chapter-7",
			6,
			"ja",
		);
		expect(sentence?.text).toBe("An 老舗 shop 無印.");
		expect(sentence?.ruby).toEqual([{ start: 3, end: 5, reading: "しにせ" }]);
	});

	test("keeps ruby base text without duplicating its pronunciation", () => {
		const [sentence] = extractSectionSentences(
			"<p><ruby>比企谷<rt>ひきがや</rt></ruby>八幡。</p>",
			"chapter-5",
			4,
			"ja",
		);

		expect(sentence?.text).toBe("比企谷八幡。");
		expect(sentence?.tokens.join("")).toBe("比企谷八幡");
	});
});
