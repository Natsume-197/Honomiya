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
