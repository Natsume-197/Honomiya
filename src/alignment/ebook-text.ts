import { load } from "cheerio";
import type { ReadListenCue } from "../artifacts/manifest";
import type { EbookDocument } from "../ebook-parser/ebook";
import { alignmentTokens, normalizeVisibleText } from "./text";

const BLOCK_SELECTOR =
	"h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th,pre";
const IGNORED_SELECTOR =
	'script,style,noscript,svg,nav,rt,rp,[hidden],[aria-hidden="true"]';
const QUOTE_CONTEXT_LENGTH = 48;

export interface AddressableSentence {
	id: string;
	sectionRef: string;
	blockIndex: number;
	sourceRange: { startUtf16: number; endUtf16: number };
	text: string;
	tokens: string[];
	normalizedText: string;
	anchor: ReadListenCue["text"];
}

function createSentenceSegmenter(locale?: string): Intl.Segmenter {
	try {
		return new Intl.Segmenter(locale || undefined, { granularity: "sentence" });
	} catch {
		return new Intl.Segmenter(undefined, { granularity: "sentence" });
	}
}

function sentenceParts(text: string, locale?: string) {
	const parts: Array<{ exact: string; start: number; end: number }> = [];
	for (const part of createSentenceSegmenter(locale).segment(text)) {
		const exact = part.segment.trim();
		if (!exact) continue;
		const leadingWhitespace =
			part.segment.length - part.segment.trimStart().length;
		const start = part.index + leadingWhitespace;
		parts.push({ exact, start, end: start + exact.length });
	}
	return parts;
}

function quoteAnchor(
	sectionRef: string,
	blockText: string,
	part: { exact: string; start: number; end: number },
): ReadListenCue["text"] {
	const prefix = blockText
		.slice(Math.max(0, part.start - QUOTE_CONTEXT_LENGTH), part.start)
		.trim();
	const suffix = blockText
		.slice(part.end, part.end + QUOTE_CONTEXT_LENGTH)
		.trim();
	return {
		kind: "text-quote",
		sectionRef,
		exact: part.exact,
		...(prefix ? { prefix } : {}),
		...(suffix ? { suffix } : {}),
	};
}

export function extractSectionSentences(
	html: string,
	sectionRef: string,
	sectionIndex: number,
	locale?: string,
): AddressableSentence[] {
	const $ = load(html, {}, false);
	$(IGNORED_SELECTOR).remove();
	$("br").replaceWith(" ");

	const blocks = $(BLOCK_SELECTOR)
		.toArray()
		.filter((element) => $(element).find(BLOCK_SELECTOR).length === 0);
	const root = $.root().get(0);
	const readableBlocks = blocks.length > 0 ? blocks : root ? [root] : [];
	const sentences: AddressableSentence[] = [];

	for (const [blockIndex, element] of readableBlocks.entries()) {
		const blockText = normalizeVisibleText($(element).text());
		if (!blockText) continue;
		const parts = sentenceParts(blockText, locale);
		const fragmentId = $(element).attr("id")?.trim();

		for (const [sentenceIndex, part] of parts.entries()) {
			const tokens = alignmentTokens(part.exact, locale);
			if (tokens.length === 0) continue;
			sentences.push({
				id: `s-${sectionIndex + 1}-${blockIndex + 1}-${sentenceIndex + 1}`,
				sectionRef,
				blockIndex,
				sourceRange: { startUtf16: part.start, endUtf16: part.end },
				text: part.exact,
				tokens,
				normalizedText: tokens.join(" "),
				anchor:
					fragmentId && parts.length === 1
						? { kind: "fragment", sectionRef, fragmentId }
						: quoteAnchor(sectionRef, blockText, part),
			});
		}
	}

	return sentences;
}

export async function extractEbookSentences(
	document: EbookDocument,
	language?: string,
): Promise<AddressableSentence[]> {
	if (document.content.kind !== "html") {
		throw new Error(
			"Read-and-listen alignment requires reflowable HTML content",
		);
	}

	const locale = language ?? document.metadata.language;
	const sentences: AddressableSentence[] = [];
	for (const [sectionIndex, section] of document.content.sections.entries()) {
		const content = await document.content.openSection(section.id);
		if (!content) continue;
		sentences.push(
			...extractSectionSentences(
				content.html,
				section.id,
				sectionIndex,
				locale,
			),
		);
	}
	return sentences;
}
