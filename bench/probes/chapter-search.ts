// Phase 3 probe: runs the boundary search over a whole book and compares
// chapter placement and anchors with an SRT-derived reference manifest.
// bun chapter-search.ts <ebook> <reference.json> <emissions.bin>
import { readFileSync } from "node:fs";
import { extractEbookSentences } from "../../src/alignment/ebook-text";
import { decodeEmissions, frameDurationMs } from "../../src/ctc/emissions";
import {
	chapterSpans,
	decodeForSearch,
	locateChapters,
} from "../../src/ctc/search";
import { conditionText, VocabularyIndex } from "../../src/ctc/text";
import { openEbookFile } from "../../src/ebook-parser/node";

const [ebookPath, referencePath, emissionsPath] = process.argv.slice(2);
const ebook = await openEbookFile(ebookPath!);
const sentences = await extractEbookSentences(ebook, "ja");
await ebook.close();
const emissions = decodeEmissions(new Uint8Array(readFileSync(emissionsPath!)));
const { header } = emissions;
const frameMs = frameDurationMs(header);
const correction = header.model.timingCorrectionMs;
const index = new VocabularyIndex({ tokens: header.vocabulary, blank: header.blank });

const started = performance.now();
const text = conditionText(sentences, index, { locale: "ja" });
const conditionMs = performance.now() - started;
const spans = chapterSpans(text, (sentence) => sentences[sentence]?.sectionRef ?? "");
const decodeStarted = performance.now();
const decode = decodeForSearch([emissions], index);
const decodeMs = performance.now() - decodeStarted;
const searchStarted = performance.now();
const locations = locateChapters(text, spans, decode);
const searchMs = performance.now() - searchStarted;

const reference = JSON.parse(readFileSync(referencePath!, "utf8"));
const cueById = new Map<string, { startMs: number; endMs: number }>(
	reference.cues.map((cue: { id: string; startMs: number; endMs: number }) => [cue.id, cue]),
);
const tokenReferenceMs = (token: number) => {
	const sentence = sentences[text.sentence[token] ?? 0]!;
	const cue = cueById.get(sentence.id);
	if (!cue) return Number.NaN;
	const fraction = (text.sourceStart[token] ?? 0) / Math.max(1, sentence.text.length);
	return cue.startMs + fraction * (cue.endMs - cue.startMs);
};

const rows: string[] = [];
let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
let trueNegative = 0;
const startErrors: number[] = [];
let contained = 0;
const anchorErrors: number[] = [];
for (const location of locations) {
	const chapterSentences = new Set<number>();
	for (let token = location.tokenStart; token < location.tokenEnd; token += 1) {
		chapterSentences.add(text.sentence[token] ?? 0);
	}
	const cues = [...chapterSentences].flatMap((sentence) => {
		const cue = cueById.get(sentences[sentence]?.id ?? "");
		return cue ? [cue] : [];
	});
	// SRT references interpolate cues over unnarrated text too, crammed into
	// whatever audio is left, so also require a plausible speaking rate.
	const referenceSpanMs =
		cues.length > 0 ? Math.max(...cues.map((cue) => cue.endMs)) - Math.min(...cues.map((cue) => cue.startMs)) : 0;
	const narrated =
		cues.length >= Math.max(1, chapterSentences.size * 0.5) &&
		referenceSpanMs / Math.max(1, location.tokenEnd - location.tokenStart) >= 50;
	const found = location.status === "found";
	if (found && narrated) truePositive += 1;
	else if (found) falsePositive += 1;
	else if (narrated) falseNegative += 1;
	else trueNegative += 1;
	const referenceStart = cues.length > 0 ? Math.min(...cues.map((cue) => cue.startMs)) : Number.NaN;
	const referenceEnd = cues.length > 0 ? Math.max(...cues.map((cue) => cue.endMs)) : Number.NaN;
	let startError = Number.NaN;
	if (found && narrated) {
		const windowStart = (location.startFrame ?? 0) * frameMs + correction.start;
		const windowEnd = (location.endFrame ?? 0) * frameMs + correction.end;
		startError = referenceStart - windowStart;
		startErrors.push(startError);
		if (windowStart <= referenceStart + 500 && windowEnd >= referenceEnd - 500) contained += 1;
		for (const anchor of location.anchors) {
			const expected = tokenReferenceMs(anchor.token);
			if (!Number.isNaN(expected)) anchorErrors.push(Math.abs(anchor.frame * frameMs + correction.start - expected));
		}
	}
	if (location.tokenEnd - location.tokenStart >= 20 || found !== narrated) {
		rows.push(
			`${String(location.chapter).padStart(3)} tokens ${String(location.tokenEnd - location.tokenStart).padStart(6)} ${location.status.padEnd(9)} narrated ${narrated ? "y" : "n"} anchors ${String(location.anchors.length).padStart(5)} cov ${location.coverage.toFixed(2)} conf ${location.confidence.toFixed(2)} cand ${location.candidates}/${location.freeCandidates} span ${location.anchors[0] ? `${Math.round(location.anchors[0].frame * frameMs / 1000)}-${Math.round((location.anchors.at(-1)?.frame ?? 0) * frameMs / 1000)}s` : "-"} ref ${cues.length ? `${Math.round(referenceStart / 1000)}s` : "-"} lead ${Number.isNaN(startError) ? "-" : `${(startError / 1000).toFixed(1)}s`}`,
		);
	}
}
const summary = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const q = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0);
	return { n: sorted.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: Math.round(sorted.at(-1) ?? 0) };
};
console.log(rows.join("\n"));
console.log(
	JSON.stringify({
		chapters: locations.length,
		truePositive,
		falsePositive,
		falseNegative,
		trueNegative,
		windowsContainingNarration: `${contained}/${truePositive}`,
		windowLeadBeforeNarrationMs: summary(startErrors),
		anchorErrorMs: summary(anchorErrors),
		anchorsWithin1s: Number((anchorErrors.filter((e) => e <= 1000).length / Math.max(1, anchorErrors.length)).toFixed(4)),
		timingMs: { condition: Math.round(conditionMs), decode: Math.round(decodeMs), search: Math.round(searchMs) },
	}),
);
