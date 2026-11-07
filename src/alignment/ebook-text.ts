import { load } from "cheerio";
import type { ReadListenCue } from "../artifacts/manifest";
import type { EbookDocument } from "../ebook-parser/ebook";
import { alignmentTokens, normalizeVisibleText } from "./text";

const BLOCK_SELECTOR =
	"h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th,pre";
const IGNORED_SELECTOR =
	'script,style,noscript,svg,nav,rt,rp,[hidden],[aria-hidden="true"]';
const QUOTE_CONTEXT_LENGTH = 48;

/** A ruby annotation over `text.slice(start, end)`, in UTF-16 offsets. */
export interface RubySpan {
	start: number;
	end: number;
	reading: string;
}

export interface AddressableSentence {
	id: string;
	sectionRef: string;
	blockIndex: number;
	sourceRange: { startUtf16: number; endUtf16: number };
	text: string;
	tokens: string[];
	normalizedText: string;
	anchor: ReadListenCue["text"];
	/** Ruby readings (furigana); often what the narrator actually says. */
	ruby?: RubySpan[];
}

// Private-use sentinels that carry ruby readings through cheerio's text().
const RUBY_BASE_START = "";
const RUBY_READING_START = "";
const RUBY_END = "";

/**
 * Rewrites every <ruby> into `START base READING reading END` so readings
 * survive text extraction. Handles both `base<rt>` and `<rb>…<rt>…` pairs.
 */
function encodeRubyReadings($: ReturnType<typeof load>): void {
	$("ruby").each((_, element) => {
		let base = "";
		let encoded = "";
		for (const child of $(element).contents().toArray()) {
			const name = child.type === "tag" ? child.name.toLowerCase() : "";
			if (name === "rp") continue;
			if (name === "rt") {
				const reading = normalizeVisibleText($(child).text());
				encoded += reading && base
					? `${RUBY_BASE_START}${base}${RUBY_READING_START}${reading}${RUBY_END}`
					: base;
				base = "";
				continue;
			}
			base += $(child).text();
		}
		$(element).replaceWith(encoded + base);
	});
}

/**
 * Removes the ruby encoding and normalizes whitespace exactly like
 * normalizeVisibleText, returning ruby spans in the normalized text.
 */
function decodeRubyReadings(raw: string): { text: string; ruby: RubySpan[] } {
	let stripped = "";
	const spans: RubySpan[] = [];
	for (let index = 0; index < raw.length; ) {
		if (raw[index] !== RUBY_BASE_START) {
			stripped += raw[index];
			index += 1;
			continue;
		}
		const readingAt = raw.indexOf(RUBY_READING_START, index);
		const endAt = raw.indexOf(RUBY_END, readingAt);
		if (readingAt === -1 || endAt === -1) {
			index += 1;
			continue;
		}
		const base = raw.slice(index + 1, readingAt);
		spans.push({
			start: stripped.length,
			end: stripped.length + base.length,
			reading: raw.slice(readingAt + 1, endAt),
		});
		stripped += base;
		index = endAt + 1;
	}

	// Collapse whitespace runs to one space and trim, tracking offsets.
	const map = new Int32Array(stripped.length + 1);
	let text = "";
	let pendingSpace = false;
	for (let index = 0; index < stripped.length; index += 1) {
		const character = stripped[index] ?? "";
		if (/\s/u.test(character)) {
			pendingSpace = text.length > 0;
			map[index] = text.length;
			continue;
		}
		if (pendingSpace) {
			text += " ";
			pendingSpace = false;
		}
		map[index] = text.length;
		text += character;
	}
	map[stripped.length] = text.length;
	const ruby = spans
		.map((span) => ({
			start: map[span.start] ?? 0,
			end: map[span.end] ?? 0,
			reading: span.reading,
		}))
		.filter((span) => span.end > span.start);
	return { text, ruby };
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
	encodeRubyReadings($);
	$(IGNORED_SELECTOR).remove();
	$("br").replaceWith(" ");

	const blocks = $(BLOCK_SELECTOR)
		.toArray()
		.filter((element) => $(element).find(BLOCK_SELECTOR).length === 0);
	const root = $.root().get(0);
	const readableBlocks = blocks.length > 0 ? blocks : root ? [root] : [];
	const sentences: AddressableSentence[] = [];

	for (const [blockIndex, element] of readableBlocks.entries()) {
		const { text: blockText, ruby: blockRuby } = decodeRubyReadings(
			$(element).text(),
		);
		if (!blockText) continue;
		const parts = sentenceParts(blockText, locale);
		const fragmentId = $(element).attr("id")?.trim();

		for (const [sentenceIndex, part] of parts.entries()) {
			const tokens = alignmentTokens(part.exact, locale);
			if (tokens.length === 0) continue;
			const ruby = blockRuby
				.filter((span) => span.start >= part.start && span.end <= part.end)
				.map((span) => ({
					start: span.start - part.start,
					end: span.end - part.start,
					reading: span.reading,
				}));
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
				...(ruby.length > 0 ? { ruby } : {}),
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
