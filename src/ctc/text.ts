import type { RubySpan } from "../alignment/ebook-text";
import type { CtcVocabulary } from "./vocabulary";

/**
 * Turns ebook sentences into the token sequence a CTC aligner walks.
 *
 * Every token is a *set* of model classes that count as the same sound, so the
 * aligner can score a token as the best of its classes. The QuartzNet-ja
 * vocabulary was trained on raw Japanese text: it has ASCII and full-width
 * digits, full-width Latin, hiragana and katakana, so one written character
 * can legitimately surface as several classes.
 *
 * Characters the model cannot emit become STAR tokens (a wildcard the aligner
 * scores with a constant). Punctuation and symbols are not narrated and are
 * dropped. Spans that may be spoken differently from how they are written
 * (ruby readings, digit runs) carry an alternative token sequence.
 */

export const STAR = -1;

export const TEXT_CONDITIONING_VERSION = "honomiya.ctc-text.v1" as const;

export interface TextAlternative {
	kind: "ruby" | "numeral";
	/** Primary tokens [tokenStart, tokenEnd) this alternative can replace. */
	tokenStart: number;
	tokenEnd: number;
	/** Class-set ids (or STAR) of the alternative spelling. */
	tokens: Int32Array;
}

export interface ConditionedText {
	/** Class-set id per token, or STAR. */
	tokens: Int32Array;
	/** Class ids per class-set id. */
	classSets: Int32Array[];
	/** Index into the conditioned sentences. */
	sentence: Int32Array;
	/** UTF-16 range of the token's source in its sentence text. */
	sourceStart: Int32Array;
	sourceEnd: Int32Array;
	/** Global index of the word (Intl.Segmenter) the token belongs to. */
	word: Int32Array;
	alternatives: TextAlternative[];
	stats: {
		characters: number;
		mapped: number;
		star: number;
		droppedSymbols: number;
		numeralRuns: number;
		rubyAlternatives: number;
	};
}

export interface ConditionableSentence {
	text: string;
	ruby?: RubySpan[];
}

/** Common kyūjitai / itaiji forms that the vocabulary only has in one shape. */
const GLYPH_VARIANTS: Record<string, string> = {
	噓: "嘘",
	頰: "頬",
	搔: "掻",
	瘦: "痩",
	剝: "剥",
	嚙: "噛",
	屛: "屏",
	繫: "繋",
	蔣: "蒋",
	醬: "醤",
	摑: "掴",
	鷗: "鴎",
	吞: "呑",
	揭: "掲",
	潑: "溌",
	攢: "攅",
	禱: "祷",
	囊: "嚢",
	騷: "騒",
	麴: "麹",
};

/** Ruby uses full-size kana where the reading has small ones (ぎよく → ぎょく). */
const SMALL_KANA: Record<string, string> = {
	や: "ゃ",
	ゆ: "ゅ",
	よ: "ょ",
	つ: "っ",
	ヤ: "ャ",
	ユ: "ュ",
	ヨ: "ョ",
	ツ: "ッ",
};

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const DIGIT = /^[0-9]$/u;

function kanaCounterpart(character: string): string | undefined {
	const code = character.codePointAt(0) ?? 0;
	if (code >= 0x3041 && code <= 0x3096) return String.fromCodePoint(code + 0x60);
	if (code >= 0x30a1 && code <= 0x30f6) return String.fromCodePoint(code - 0x60);
	return undefined;
}

const KANJI_DIGITS = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/**
 * Reads a run of ASCII digits as Japanese numerals: positional up to 12
 * digits (2008 → 二千八), digit by digit with a leading zero or beyond
 * (007 → 〇〇七).
 */
export function kanjiNumeral(digits: string): string {
	if (!/^[0-9]+$/u.test(digits)) throw new Error(`Not a digit run: ${digits}`);
	if ((digits.length > 1 && digits.startsWith("0")) || digits.length > 12) {
		return Array.from(digits, (digit) => KANJI_DIGITS[Number(digit)]).join("");
	}
	const value = Number(digits);
	if (value === 0) return "〇";
	const groupUnits = ["", "万", "億"];
	const placeUnits = ["", "十", "百", "千"];
	let result = "";
	let remaining = value;
	let group = 0;
	while (remaining > 0) {
		const chunk = remaining % 10_000;
		if (chunk > 0) {
			let text = "";
			for (let place = 3; place >= 0; place -= 1) {
				const digit = Math.floor(chunk / 10 ** place) % 10;
				if (digit === 0) continue;
				const omitOne = digit === 1 && place > 0;
				// 十, 百 and 千 drop a leading 一; the ones place (and so 一万) keeps it.
				text += (omitOne ? "" : (KANJI_DIGITS[digit] ?? "")) + (placeUnits[place] ?? "");
			}
			result = text + (groupUnits[group] ?? "") + result;
		}
		remaining = Math.floor(remaining / 10_000);
		group += 1;
	}
	return result;
}

/** Maps characters to sets of equivalent model classes. */
export class VocabularyIndex {
	private readonly byForm = new Map<string, number[]>();
	private readonly cache = new Map<string, number>();
	private readonly setKeys = new Map<string, number>();
	readonly classSets: Int32Array[] = [];

	constructor(readonly vocabulary: CtcVocabulary) {
		for (const [classId, token] of vocabulary.tokens.entries()) {
			if (classId === vocabulary.blank || token.length === 0) continue;
			const form = token.normalize("NFKC");
			const ids = this.byForm.get(form) ?? [];
			ids.push(classId);
			this.byForm.set(form, ids);
		}
	}

	private setId(classIds: number[]): number {
		if (classIds.length === 0) return STAR;
		const sorted = [...new Set(classIds)].sort((a, b) => a - b);
		const key = sorted.join(",");
		const existing = this.setKeys.get(key);
		if (existing !== undefined) return existing;
		const id = this.classSets.length;
		this.classSets.push(Int32Array.from(sorted));
		this.setKeys.set(key, id);
		return id;
	}

	/** Class-set id for one character, or STAR when the model has no class. */
	tokenFor(character: string, options: { smallKana?: boolean } = {}): number {
		const cacheKey = options.smallKana ? `s:${character}` : character;
		const cached = this.cache.get(cacheKey);
		if (cached !== undefined) return cached;
		const forms = new Set<string>();
		const add = (form: string | undefined) => {
			if (!form) return;
			forms.add(form.normalize("NFKC"));
			const counterpart = kanaCounterpart(form);
			if (counterpart) forms.add(counterpart);
		};
		add(character);
		add(GLYPH_VARIANTS[character]);
		if (options.smallKana) add(SMALL_KANA[character]);
		const classIds = [...forms].flatMap((form) => this.byForm.get(form) ?? []);
		const id = this.setId(classIds);
		this.cache.set(cacheKey, id);
		return id;
	}

	/** Token ids for a whole string, dropping symbols. */
	tokensFor(text: string, options: { smallKana?: boolean } = {}): number[] {
		const tokens: number[] = [];
		for (const character of text) {
			const normalized = character.normalize("NFKC");
			for (const part of normalized.length > 0 ? normalized : character) {
				if (LETTER_OR_NUMBER.test(part)) tokens.push(this.tokenFor(part, options));
			}
		}
		return tokens;
	}
}

interface CodePoint {
	text: string;
	start: number;
	end: number;
}

function codePoints(text: string): CodePoint[] {
	const points: CodePoint[] = [];
	let offset = 0;
	for (const character of text) {
		points.push({ text: character, start: offset, end: offset + character.length });
		offset += character.length;
	}
	return points;
}

function createWordSegmenter(locale?: string): Intl.Segmenter {
	try {
		return new Intl.Segmenter(locale || undefined, { granularity: "word" });
	} catch {
		return new Intl.Segmenter(undefined, { granularity: "word" });
	}
}

export function conditionText(
	sentences: ConditionableSentence[],
	vocabulary: CtcVocabulary | VocabularyIndex,
	options: { locale?: string } = {},
): ConditionedText {
	const index =
		vocabulary instanceof VocabularyIndex ? vocabulary : new VocabularyIndex(vocabulary);
	const segmenter = createWordSegmenter(options.locale);
	const tokens: number[] = [];
	const sentenceOf: number[] = [];
	const sourceStart: number[] = [];
	const sourceEnd: number[] = [];
	const wordOf: number[] = [];
	const alternatives: TextAlternative[] = [];
	const stats = {
		characters: 0,
		mapped: 0,
		star: 0,
		droppedSymbols: 0,
		numeralRuns: 0,
		rubyAlternatives: 0,
	};
	let wordCounter = -1;

	for (const [sentenceIndex, sentence] of sentences.entries()) {
		// Word index for every UTF-16 offset of the sentence.
		const wordAt = new Int32Array(sentence.text.length).fill(-1);
		for (const segment of segmenter.segment(sentence.text)) {
			if (!segment.isWordLike) continue;
			wordCounter += 1;
			wordAt.fill(wordCounter, segment.index, segment.index + segment.segment.length);
		}
		const push = (token: number, start: number, end: number) => {
			tokens.push(token);
			sentenceOf.push(sentenceIndex);
			sourceStart.push(start);
			sourceEnd.push(end);
			wordOf.push(wordAt[start] ?? -1);
			stats.mapped += token === STAR ? 0 : 1;
			stats.star += token === STAR ? 1 : 0;
		};

		const sentenceFirstToken = tokens.length;
		const points = codePoints(sentence.text);
		for (let position = 0; position < points.length; ) {
			const point = points[position] as CodePoint;
			const normalized = point.text.normalize("NFKC");

			// A run of digits: narrated as a number, written as digits.
			if (DIGIT.test(normalized)) {
				const firstToken = tokens.length;
				let digits = "";
				while (position < points.length) {
					const current = points[position] as CodePoint;
					const digit = current.text.normalize("NFKC");
					if (!DIGIT.test(digit)) break;
					digits += digit;
					stats.characters += 1;
					push(index.tokenFor(digit), current.start, current.end);
					position += 1;
				}
				stats.numeralRuns += 1;
				alternatives.push({
					kind: "numeral",
					tokenStart: firstToken,
					tokenEnd: tokens.length,
					tokens: Int32Array.from(index.tokensFor(kanjiNumeral(digits))),
				});
				continue;
			}

			position += 1;
			// Characters the vocabulary knows as-is (①, Ⅲ) stay whole.
			const whole = index.tokenFor(point.text);
			if (whole !== STAR && LETTER_OR_NUMBER.test(point.text)) {
				stats.characters += 1;
				push(whole, point.start, point.end);
				continue;
			}
			for (const part of normalized) {
				if (!LETTER_OR_NUMBER.test(part)) {
					stats.droppedSymbols += 1;
					continue;
				}
				stats.characters += 1;
				push(index.tokenFor(part), point.start, point.end);
			}
		}

		// Ruby readings as alternatives over the tokens of their base text.
		for (const span of sentence.ruby ?? []) {
			let tokenStart = -1;
			let tokenEnd = -1;
			for (let token = sentenceFirstToken; token < tokens.length; token += 1) {
				const start = sourceStart[token] ?? 0;
				const end = sourceEnd[token] ?? 0;
				if (start >= span.start && end <= span.end) {
					if (tokenStart === -1) tokenStart = token;
					tokenEnd = token + 1;
				}
			}
			const reading = index.tokensFor(span.reading, { smallKana: true });
			if (tokenStart === -1 || reading.length === 0) continue;
			stats.rubyAlternatives += 1;
			alternatives.push({
				kind: "ruby",
				tokenStart,
				tokenEnd,
				tokens: Int32Array.from(reading),
			});
		}
	}

	alternatives.sort((a, b) => a.tokenStart - b.tokenStart || a.tokenEnd - b.tokenEnd);
	return {
		tokens: Int32Array.from(tokens),
		classSets: index.classSets,
		sentence: Int32Array.from(sentenceOf),
		sourceStart: Int32Array.from(sourceStart),
		sourceEnd: Int32Array.from(sourceEnd),
		word: Int32Array.from(wordOf),
		alternatives,
		stats,
	};
}

/**
 * Resolves alternatives into one flat token sequence. `prefer` picks which
 * alternative kinds replace their primary tokens. The returned origin maps
 * every resolved token back to the primary token range it stands for.
 */
export function resolveAlternatives(
	text: ConditionedText,
	prefer: ReadonlySet<TextAlternative["kind"]>,
): { tokens: Int32Array; originStart: Int32Array; originEnd: Int32Array } {
	const tokens: number[] = [];
	const originStart: number[] = [];
	const originEnd: number[] = [];
	let cursor = 0;
	for (const alternative of text.alternatives) {
		if (!prefer.has(alternative.kind) || alternative.tokenStart < cursor) continue;
		for (; cursor < alternative.tokenStart; cursor += 1) {
			tokens.push(text.tokens[cursor] ?? STAR);
			originStart.push(cursor);
			originEnd.push(cursor + 1);
		}
		for (const token of alternative.tokens) {
			tokens.push(token);
			originStart.push(alternative.tokenStart);
			originEnd.push(alternative.tokenEnd);
		}
		cursor = alternative.tokenEnd;
	}
	for (; cursor < text.tokens.length; cursor += 1) {
		tokens.push(text.tokens[cursor] ?? STAR);
		originStart.push(cursor);
		originEnd.push(cursor + 1);
	}
	return {
		tokens: Int32Array.from(tokens),
		originStart: Int32Array.from(originStart),
		originEnd: Int32Array.from(originEnd),
	};
}
