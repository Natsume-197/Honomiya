export interface CtcVocabulary {
	/** Token text by class index. The blank token is included. */
	tokens: string[];
	blank: number;
}

const BLANK_TOKENS = new Set(["<blk>", "<blank>", "<pad>"]);

/**
 * Parses a NeMo-style `vocab.txt` where every line is `<token> <index>`. The
 * token itself may be a space, so the index is read from the last space.
 */
export function parseVocabularyText(text: string): CtcVocabulary {
	const tokens: string[] = [];
	let blank: number | undefined;
	for (const [lineNumber, rawLine] of text.split("\n").entries()) {
		const line = rawLine.replace(/\r$/u, "");
		if (line.length === 0) continue;
		const separator = line.lastIndexOf(" ");
		const index = Number(line.slice(separator + 1));
		if (separator <= 0 || !Number.isInteger(index) || index < 0) {
			throw new Error(`Invalid vocabulary line ${lineNumber + 1}`);
		}
		const token = line.slice(0, separator);
		if (tokens[index] !== undefined) {
			throw new Error(`Duplicate vocabulary index ${index}`);
		}
		tokens[index] = token;
		if (BLANK_TOKENS.has(token)) blank = index;
	}
	for (let index = 0; index < tokens.length; index += 1) {
		if (tokens[index] === undefined) {
			throw new Error(`Vocabulary is missing index ${index}`);
		}
	}
	if (blank === undefined) throw new Error("Vocabulary has no blank token");
	return { tokens, blank };
}
