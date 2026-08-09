const ALIGNMENT_CHARACTER_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;
const CJK_CHARACTER_PATTERN =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ALIGNMENT_CODE_POINT_PATTERN = /[\p{L}\p{M}\p{N}]/u;

export const TEXT_NORMALIZATION_VERSION = "honomiya.text.v2" as const;

export function normalizeVisibleText(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function localeLowerCase(value: string, locale?: string): string {
	try {
		return locale ? value.toLocaleLowerCase(locale) : value.toLocaleLowerCase();
	} catch {
		return value.toLocaleLowerCase();
	}
}

export function normalizeAlignmentToken(
	value: string,
	locale?: string,
): string {
	return (
		localeLowerCase(value.normalize("NFKC"), locale)
			.match(ALIGNMENT_CHARACTER_PATTERN)
			?.join("") ?? ""
	);
}

function createWordSegmenter(locale?: string): Intl.Segmenter | undefined {
	try {
		return new Intl.Segmenter(locale || undefined, { granularity: "word" });
	} catch {
		return new Intl.Segmenter(undefined, { granularity: "word" });
	}
}

export function alignmentTokens(value: string, locale?: string): string[] {
	const normalized = value.normalize("NFKC");
	if (CJK_CHARACTER_PATTERN.test(normalized)) {
		return Array.from(localeLowerCase(normalized, locale)).filter((character) =>
			ALIGNMENT_CODE_POINT_PATTERN.test(character),
		);
	}

	const segmenter = createWordSegmenter(locale);
	const tokens: string[] = [];

	if (segmenter) {
		for (const segment of segmenter.segment(normalized)) {
			if (!segment.isWordLike) continue;
			const token = normalizeAlignmentToken(segment.segment, locale);
			if (token) tokens.push(token);
		}
		return tokens;
	}

	for (const match of normalized.matchAll(ALIGNMENT_CHARACTER_PATTERN)) {
		const token = normalizeAlignmentToken(match[0], locale);
		if (token) tokens.push(token);
	}
	return tokens;
}
