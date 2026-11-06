// Phase 2 probe: conditions a whole book for CTC, reports coverage, then runs
// a CTC Viterbi over a window of sparse emissions under several text policies
// and compares sentence timings with an SRT-derived reference manifest.
// bun text-policy.ts <ebook> <reference.json> <emissions.bin> <startSec> <durationSec>
import { readFileSync } from "node:fs";
import { extractEbookSentences } from "../../src/alignment/ebook-text";
import { openEbookFile } from "../../src/ebook-parser/node";
import { decodeEmissions, frameDurationMs, SCORE_SCALE } from "../../src/ctc/emissions";
import {
	conditionText,
	resolveAlternatives,
	STAR,
	type TextAlternative,
	VocabularyIndex,
} from "../../src/ctc/text";

const [ebookPath, referencePath, emissionsPath, startArg, durationArg] = process.argv.slice(2);
const STAR_SCORE = -3;

const ebook = await openEbookFile(ebookPath!);
const sentences = await extractEbookSentences(ebook, "ja");
await ebook.close();
const emissions = decodeEmissions(new Uint8Array(readFileSync(emissionsPath!)));
const { header } = emissions;
const vocabulary = { tokens: header.vocabulary, blank: header.blank };
const index = new VocabularyIndex(vocabulary);

// Whole-book coverage.
const book = conditionText(sentences, index, { locale: "ja" });
const starCharacters = new Map<string, number>();
for (let token = 0; token < book.tokens.length; token += 1) {
	if (book.tokens[token] !== STAR) continue;
	const sentence = sentences[book.sentence[token] ?? 0];
	const character = sentence?.text.slice(book.sourceStart[token], book.sourceEnd[token]) ?? "";
	starCharacters.set(character, (starCharacters.get(character) ?? 0) + 1);
}
console.log(JSON.stringify({
	book: ebookPath!.split("/").pop(),
	sentences: sentences.length,
	...book.stats,
	starRate: Number((book.stats.star / book.stats.characters).toFixed(4)),
	topStar: [...starCharacters.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
}));

// Window under test.
const frameMs = frameDurationMs(header);
const windowStartMs = Number(startArg) * 1000;
const windowEndMs = windowStartMs + Number(durationArg) * 1000;
type Cue = { id: string; startMs: number; endMs: number };
const reference = JSON.parse(readFileSync(referencePath!, "utf8"));
const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
const cues: Cue[] = reference.cues.filter(
	(cue: Cue) => cue.startMs >= windowStartMs && cue.endMs <= windowEndMs && byId.has(cue.id),
);
const windowText = conditionText(cues.map((cue) => byId.get(cue.id)!), index, { locale: "ja" });

const firstFrame = Math.floor(windowStartMs / frameMs) - header.startFrame;
const frameCount = Math.floor((windowEndMs - windowStartMs) / frameMs);
const vocabSize = header.vocabulary.length;
const row = new Float32Array(vocabSize);

function setScores(tokens: Int32Array) {
	const sets = [...new Set(Array.from(tokens).filter((token) => token !== STAR))];
	const column = new Map(sets.map((set, position) => [set, position]));
	const scores = new Float32Array(frameCount * (sets.length + 1));
	const blank = new Float32Array(frameCount);
	for (let frame = 0; frame < frameCount; frame += 1) {
		const local = firstFrame + frame;
		const offset = local * header.topK;
		row.fill((emissions.scores[offset + header.topK - 1] ?? -32768) / SCORE_SCALE);
		for (let k = 0; k < header.topK; k += 1) {
			row[emissions.classes[offset + k] ?? 0] = (emissions.scores[offset + k] ?? -32768) / SCORE_SCALE;
		}
		blank[frame] = (emissions.blank[local] ?? -32768) / SCORE_SCALE;
		for (const [set, position] of column) {
			let best = Number.NEGATIVE_INFINITY;
			for (const classId of index.classSets[set] ?? []) best = Math.max(best, row[classId] ?? best);
			scores[frame * (sets.length + 1) + position] = best;
		}
		scores[frame * (sets.length + 1) + sets.length] = STAR_SCORE;
	}
	return { scores, blank, column, width: sets.length + 1 };
}

function align(tokens: Int32Array) {
	const { scores, blank, column, width } = setScores(tokens);
	const L = tokens.length;
	const S = 2 * L + 1;
	const tokenColumn = Int32Array.from(tokens, (token) => (token === STAR ? width - 1 : column.get(token) ?? 0));
	const canSkip = new Uint8Array(S);
	for (let s = 3; s < S; s += 2) {
		const a = tokens[(s - 1) / 2];
		const b = tokens[(s - 3) / 2];
		canSkip[s] = a !== b || a === STAR ? 1 : 0;
	}
	const back = new Uint8Array(frameCount * S);
	let previous = new Float64Array(S).fill(Number.NEGATIVE_INFINITY);
	let current = new Float64Array(S);
	let best = { score: Number.NEGATIVE_INFINITY, t: 0, s: 0 };
	for (let t = 0; t < frameCount; t += 1) {
		const base = t * width;
		const blankScore = blank[t] ?? 0;
		for (let s = 0; s < S; s += 1) {
			let score = previous[s]!;
			let from = 0;
			if (s > 0 && previous[s - 1]! > score) { score = previous[s - 1]!; from = 1; }
			if (canSkip[s] && previous[s - 2]! > score) { score = previous[s - 2]!; from = 2; }
			if (s <= 1 && score < 0) { score = 0; from = 3; }
			current[s] = score + (s % 2 === 0 ? blankScore : scores[base + tokenColumn[(s - 1) / 2]!]!);
			back[t * S + s] = from;
		}
		for (const s of [S - 1, S - 2]) if (current[s]! > best.score) best = { score: current[s]!, t, s };
		[previous, current] = [current, previous];
	}
	const first = new Int32Array(L).fill(-1);
	const last = new Int32Array(L).fill(-1);
	let s = best.s;
	for (let t = best.t; t >= 0; t -= 1) {
		if (s % 2 === 1) {
			const token = (s - 1) / 2;
			first[token] = t;
			if (last[token] === -1) last[token] = t;
		}
		const from = back[t * S + s]!;
		if (from === 3) break;
		s -= from;
	}
	return { first, last };
}

function evaluate(name: string, prefer: Set<TextAlternative["kind"]>) {
	const resolved = resolveAlternatives(windowText, prefer);
	const started = performance.now();
	const { first, last } = align(resolved.tokens);
	const ms = performance.now() - started;
	const startErrors: number[] = [];
	const endErrors: number[] = [];
	for (const [cueIndex, cue] of cues.entries()) {
		let a = -1;
		let b = -1;
		for (let token = 0; token < resolved.tokens.length; token += 1) {
			const origin = resolved.originStart[token] ?? 0;
			if (windowText.sentence[origin] !== cueIndex) continue;
			if (first[token]! >= 0 && a === -1) a = first[token]!;
			if (last[token]! >= 0) b = last[token]!;
		}
		if (a < 0 || b < 0) continue;
		const toMs = (frame: number) => (header.startFrame + firstFrame + frame) * frameMs;
		startErrors.push(toMs(a) + header.model.timingCorrectionMs.start - cue.startMs);
		endErrors.push(toMs(b) + frameMs + header.model.timingCorrectionMs.end - cue.endMs);
	}
	const summary = (values: number[]) => {
		const abs = values.map(Math.abs).sort((x, y) => x - y);
		const q = (p: number) => Math.round(abs[Math.min(abs.length - 1, Math.floor(p * abs.length))] ?? 0);
		return { p50: q(0.5), p90: q(0.9), within250: Number((abs.filter((v) => v <= 250).length / abs.length).toFixed(3)), within500: Number((abs.filter((v) => v <= 500).length / abs.length).toFixed(3)) };
	};
	console.log(JSON.stringify({ policy: name, tokens: resolved.tokens.length, measured: startErrors.length, viterbiMs: Math.round(ms), start: summary(startErrors), end: summary(endErrors) }));
}

console.log(JSON.stringify({ windowCues: cues.length, windowAlternatives: windowText.alternatives.length }));
evaluate("surface", new Set());
evaluate("ruby", new Set(["ruby"]));
evaluate("numeral", new Set(["numeral"]));
evaluate("ruby+numeral", new Set(["ruby", "numeral"]));
