// Phase 5 probe: checks word timings of a read-listen.v2 manifest against the
// audio itself. A word "hits" when the greedy decode inside its time span
// contains at least half of its characters (as class sets). The same check
// with the span shifted by ±1 s is the baseline.
// bun word-check.ts <manifest.v2.json> <emissions.bin>
import { readFileSync } from "node:fs";
import { parseHonomiyaManifestV2 } from "../../src/artifacts/manifest";
import { decodeEmissions, frameDurationMs, greedyDecode } from "../../src/ctc/emissions";
import { STAR, VocabularyIndex } from "../../src/ctc/text";

const [manifestPath, emissionsPath] = process.argv.slice(2);
const manifest = parseHonomiyaManifestV2(JSON.parse(readFileSync(manifestPath!, "utf8")));
const emissions = decodeEmissions(new Uint8Array(readFileSync(emissionsPath!)));
const { header } = emissions;
const frameMs = frameDurationMs(header);
const index = new VocabularyIndex({ tokens: header.vocabulary, blank: header.blank });
const decoded = greedyDecode(emissions);
const decodedTokens = Array.from(decoded.text, (character) => index.tokenFor(character));
// Decoded token positions sorted by time, for range lookups.
const decodedMs = decoded.frames.map((frame) => (header.startFrame + frame) * frameMs);

function tokensBetween(startMs: number, endMs: number): Set<number> {
	let low = 0;
	let high = decodedMs.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((decodedMs[mid] ?? 0) < startMs) low = mid + 1;
		else high = mid;
	}
	const found = new Set<number>();
	for (let i = low; i < decodedMs.length && (decodedMs[i] ?? 0) < endMs; i += 1) {
		found.add(decodedTokens[i] ?? STAR);
	}
	return found;
}

const correction = header.model.timingCorrectionMs;
function hit(text: string, startMs: number, endMs: number): boolean {
	const wanted = Array.from(text, (character) => index.tokenFor(character)).filter((token) => token !== STAR);
	if (wanted.length === 0) return false;
	// Undo the timing correction to get back to emission time. Word ends are
	// the next word's start, so both edges carry the start correction.
	const found = tokensBetween(startMs - correction.start - 100, endMs - correction.start + 100);
	return wanted.filter((token) => found.has(token)).length >= Math.ceil(wanted.length / 2);
}

let words = 0;
let checked = 0;
let hits = 0;
let shiftedHits = 0;
let cuesWithWords = 0;
let kanaChecked = 0;
let kanaHits = 0;
let kanaShiftedHits = 0;
const KANA_ONLY = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const durations: number[] = [];
const charactersPerSecond: number[] = [];
for (const cue of manifest.cues) {
	if (!cue.words?.length) continue;
	cuesWithWords += 1;
	for (const word of cue.words) {
		words += 1;
		const duration = word.endMs - word.startMs;
		durations.push(duration);
		if (word.text.length >= 2 && duration > 0) charactersPerSecond.push(word.text.length / (duration / 1000));
		if (word.text.length < 2) continue;
		checked += 1;
		if (hit(word.text, word.startMs, word.endMs)) hits += 1;
		const shifted =
			hit(word.text, word.startMs + 1000, word.endMs + 1000) ||
			hit(word.text, word.startMs - 1000, word.endMs - 1000);
		if (shifted) shiftedHits += 1;
		if (KANA_ONLY.test(word.text)) {
			kanaChecked += 1;
			if (hit(word.text, word.startMs, word.endMs)) kanaHits += 1;
			if (shifted) kanaShiftedHits += 1;
		}
	}
}
const quantiles = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const q = (p: number) => Number((sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0).toFixed(1));
	return { p5: q(0.05), p50: q(0.5), p95: q(0.95) };
};
console.log(
	JSON.stringify({
		cues: manifest.cues.length,
		cuesWithWords,
		words,
		wordsPerCue: Number((words / Math.max(1, cuesWithWords)).toFixed(1)),
		durationMs: quantiles(durations),
		charactersPerSecond: quantiles(charactersPerSecond),
		under20ms: Number((durations.filter((d) => d < 20).length / Math.max(1, words)).toFixed(4)),
		checkedWords: checked,
		audioConfirmsWord: Number((hits / Math.max(1, checked)).toFixed(3)),
		baselineShifted1s: Number((shiftedHits / Math.max(1, checked)).toFixed(3)),
		kanaWords: kanaChecked,
		kanaAudioConfirms: Number((kanaHits / Math.max(1, kanaChecked)).toFixed(3)),
		kanaBaselineShifted1s: Number((kanaShiftedHits / Math.max(1, kanaChecked)).toFixed(3)),
	}),
);
