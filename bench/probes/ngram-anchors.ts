// Phase 2 probe: how many usable boundary-search anchors do surface n-grams
// give? Book tokens and the greedy decode are both reduced to canonical class
// sets; an anchor is an n-gram that occurs exactly once in each. It is correct
// when the decode position lies within ±10 s of the reference time of the
// book position (from an SRT-derived manifest).
// bun ngram-anchors.ts <ebook> <reference.json> <emissions.bin>
import { readFileSync } from "node:fs";
import { extractEbookSentences } from "../../src/alignment/ebook-text";
import { openEbookFile } from "../../src/ebook-parser/node";
import { decodeEmissions, frameDurationMs, greedyDecode } from "../../src/ctc/emissions";
import { conditionText, STAR, VocabularyIndex } from "../../src/ctc/text";

const [ebookPath, referencePath, emissionsPath] = process.argv.slice(2);
const ebook = await openEbookFile(ebookPath!);
const sentences = await extractEbookSentences(ebook, "ja");
await ebook.close();
const emissions = decodeEmissions(new Uint8Array(readFileSync(emissionsPath!)));
const index = new VocabularyIndex({ tokens: emissions.header.vocabulary, blank: emissions.header.blank });
const frameMs = frameDurationMs(emissions.header);

// Reference time per book token: interpolate inside its sentence's cue.
const reference = JSON.parse(readFileSync(referencePath!, "utf8"));
const cueById = new Map<string, { startMs: number; endMs: number }>(
	reference.cues.map((cue: { id: string; startMs: number; endMs: number }) => [cue.id, cue]),
);
const book = conditionText(sentences, index, { locale: "ja" });
const bookKeys = Array.from(book.tokens);
const bookTimeMs = Array.from(book.tokens, (_, token) => {
	const sentence = sentences[book.sentence[token] ?? 0]!;
	const cue = cueById.get(sentence.id);
	if (!cue) return Number.NaN;
	const fraction = (book.sourceStart[token] ?? 0) / Math.max(1, sentence.text.length);
	return cue.startMs + fraction * (cue.endMs - cue.startMs);
});

const decoded = greedyDecode(emissions);
const decodeKeys: number[] = [];
const decodeTimeMs: number[] = [];
Array.from(decoded.text).forEach((character, position) => {
	const token = index.tokenFor(character);
	if (token === STAR) return;
	decodeKeys.push(token);
	decodeTimeMs.push(((decoded.frames[position] ?? 0) + emissions.header.startFrame) * frameMs);
});

function counts(keys: number[], n: number): Map<string, number[]> {
	const map = new Map<string, number[]>();
	for (let i = 0; i + n <= keys.length; i += 1) {
		const slice = keys.slice(i, i + n);
		if (slice.includes(STAR)) continue;
		const key = slice.join(",");
		const positions = map.get(key);
		if (positions) positions.push(i);
		else map.set(key, [i]);
	}
	return map;
}

console.log(JSON.stringify({ bookTokens: bookKeys.length, decodeTokens: decodeKeys.length, hours: Number(((emissions.header.frames * frameMs) / 3.6e6).toFixed(2)) }));
for (const n of [3, 4, 5, 6, 8, 10]) {
	const bookGrams = counts(bookKeys, n);
	const decodeGrams = counts(decodeKeys, n);
	let anchors = 0;
	let correct = 0;
	let measurable = 0;
	for (const [key, positions] of bookGrams) {
		if (positions.length !== 1) continue;
		const other = decodeGrams.get(key);
		if (!other || other.length !== 1) continue;
		anchors += 1;
		const expected = bookTimeMs[positions[0]!]!;
		if (Number.isNaN(expected)) continue;
		measurable += 1;
		if (Math.abs(decodeTimeMs[other[0]!]! - expected) <= 10_000) correct += 1;
	}
	console.log(JSON.stringify({
		n,
		anchors,
		anchorsPerHour: Math.round(anchors / ((emissions.header.frames * frameMs) / 3.6e6)),
		meanSpacingTokens: Math.round(bookKeys.length / Math.max(1, anchors)),
		precision: Number((correct / Math.max(1, measurable)).toFixed(3)),
	}));
}
