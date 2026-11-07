// Phase 0 forced-alignment probe: QuartzNet-ja emissions + CTC Viterbi over a
// window, sentence timings compared against an SRT-derived reference manifest.
// bun forced-align.ts <ebook> <manifest> <sample.f32> <startSec> <model.onnx> <vocab.txt> [startOffsetMs endOffsetMs]
import * as ort from "onnxruntime-node";
import { readFileSync } from "node:fs";
import { extractEbookSentences } from "../../src/alignment/ebook-text";
import { openEbookFile } from "../../src/ebook-parser/node";

const [ebookPath, manifestPath, samplePath, startArg, modelPath, vocabPath] =
	process.argv.slice(2);
const SR = 16_000;
const CHUNK_SEC = 38;
const raw = readFileSync(samplePath!);
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const windowStartMs = Number(startArg) * 1000;
const windowEndMs = windowStartMs + (audio.length / SR) * 1000;

// Reference sentences fully inside the window, in audio order.
const ebook = await openEbookFile(ebookPath!);
const sentences = await extractEbookSentences(ebook, "ja");
await ebook.close();
const byId = new Map(sentences.map((s) => [s.id, s]));
const manifest = JSON.parse(readFileSync(manifestPath!, "utf8"));
type Cue = { id: string; startMs: number; endMs: number };
const cues: Cue[] = manifest.cues.filter(
	(c: Cue) => c.startMs >= windowStartMs && c.endMs <= windowEndMs,
);

const VARIANTS: Record<string, string> = { 噓: "嘘", 頰: "頬", 搔: "掻", 瘦: "痩", 剝: "剥", 嚙: "噛" };
const vocabList = readFileSync(vocabPath!, "utf8")
	.split("\n")
	.map((line) => (line.split(" ")[0] ?? "").normalize("NFKC"));
const vocab = new Map(vocabList.map((c, i) => [c, i]));
const blank = JSON.parse(readFileSync(vocabPath!.replace("vocab.txt", "config.json"), "utf8")).blank as number;

// Token sequence with sentence ownership; OOV characters are dropped.
const tokens: number[] = [];
const owner: number[] = [];
let dropped = 0;
for (const [index, cue] of cues.entries()) {
	for (const c of Array.from((byId.get(cue.id)?.text ?? "").normalize("NFKC"))) {
		if (!/[\p{L}\p{N}]/u.test(c)) continue;
		const id = vocab.get(VARIANTS[c] ?? c);
		if (id === undefined) {
			dropped += 1;
			continue;
		}
		tokens.push(id);
		owner.push(index);
	}
}

// Emissions restricted to the classes we need (plus blank).
const used = [...new Set([...tokens, blank])];
const column = new Map(used.map((id, i) => [id, i]));
const session = await ort.InferenceSession.create(modelPath!, { intraOpNumThreads: 4 });
const frames: Float32Array[] = [];
const frameTimeMs: number[] = [];
const emitStart = performance.now();
for (let offset = 0; offset < audio.length; offset += CHUNK_SEC * SR) {
	const chunk = audio.subarray(offset, Math.min(audio.length, offset + CHUNK_SEC * SR));
	if (chunk.length < SR / 2) break;
	const out = (await session.run({ signal: new ort.Tensor("float32", Float32Array.from(chunk), [1, 1, chunk.length]) })).logprobs!;
	const [, t, c] = out.dims as number[];
	const data = out.data as Float32Array;
	const frameMs = (chunk.length / SR) * 1000 / t!;
	for (let f = 0; f < t!; f += 1) {
		const row = new Float32Array(used.length);
		for (const [k, id] of used.entries()) row[k] = data[f * c! + id]!;
		frames.push(row);
		frameTimeMs.push(windowStartMs + (offset / SR) * 1000 + f * frameMs);
	}
}
const emitMs = performance.now() - emitStart;

// CTC Viterbi with free start and end frames (the window cuts sentences).
const T = frames.length;
const L = tokens.length;
const S = 2 * L + 1;
const tokenOfState = (s: number) => (s % 2 === 0 ? blank : tokens[(s - 1) / 2]!);
const stateCol = new Int32Array(S);
for (let s = 0; s < S; s += 1) stateCol[s] = column.get(tokenOfState(s))!;
const canSkip = new Uint8Array(S);
for (let s = 3; s < S; s += 2) canSkip[s] = tokens[(s - 1) / 2] !== tokens[(s - 3) / 2] ? 1 : 0;
const back = new Uint8Array(T * S); // 0 stay, 1 from s-1, 2 from s-2, 3 fresh start
let previous = new Float64Array(S).fill(-Infinity);
let current = new Float64Array(S);
let bestEnd = { score: -Infinity, t: 0, s: 0 };
const viterbiStart = performance.now();
for (let t = 0; t < T; t += 1) {
	const row = frames[t]!;
	for (let s = 0; s < S; s += 1) {
		let score = previous[s]!;
		let from = 0;
		if (s > 0 && previous[s - 1]! > score) {
			score = previous[s - 1]!;
			from = 1;
		}
		if (canSkip[s] && previous[s - 2]! > score) {
			score = previous[s - 2]!;
			from = 2;
		}
		// Leading audio that is not in the text is free to skip.
		if (s <= 1 && score < 0) {
			score = 0;
			from = 3;
		}
		current[s] = score + row[stateCol[s]!]!;
		back[t * S + s] = from;
	}
	for (const s of [S - 1, S - 2]) {
		if (current[s]! > bestEnd.score) bestEnd = { score: current[s]!, t, s };
	}
	[previous, current] = [current, previous];
}
const viterbiMs = performance.now() - viterbiStart;

// Backtrack to the first and last frame of every token.
const firstFrame = new Int32Array(L).fill(-1);
const lastFrame = new Int32Array(L).fill(-1);
let s = bestEnd.s;
for (let t = bestEnd.t; t >= 0; t -= 1) {
	if (s % 2 === 1) {
		const token = (s - 1) / 2;
		firstFrame[token] = t;
		if (lastFrame[token] === -1) lastFrame[token] = t;
	}
	const from = back[t * S + s]!;
	if (from === 3) break;
	s -= from === 0 ? 0 : from;
}

const startErrors: number[] = [];
const endErrors: number[] = [];
for (const [index, cue] of cues.entries()) {
	const own = owner.flatMap((o, i) => (o === index ? [i] : []));
	if (own.length === 0) continue;
	const first = firstFrame[own[0]!]!;
	const last = lastFrame[own.at(-1)!]!;
	if (first < 0 || last < 0) continue;
	startErrors.push(frameTimeMs[first]! - cue.startMs);
	endErrors.push(frameTimeMs[last]! + 20 - cue.endMs);
}
// Which onset lands on speech? Mean RMS just after each candidate start,
// versus just before it, plus the reference gap to the previous cue.
const rms = (fromMs: number, toMs: number) => {
	const a = Math.max(0, Math.round(((fromMs - windowStartMs) / 1000) * SR));
	const b = Math.min(audio.length, Math.round(((toMs - windowStartMs) / 1000) * SR));
	let sum = 0;
	for (let i = a; i < b; i += 1) sum += audio[i]! ** 2;
	return b > a ? Math.sqrt(sum / (b - a)) : 0;
};
const onset = { refBefore: 0, refAfter: 0, ctcBefore: 0, ctcAfter: 0, refGapMs: [] as number[] };
for (const [index, cue] of cues.entries()) {
	const ctcStart = cue.startMs + startErrors[index]!;
	onset.refBefore += rms(cue.startMs - 300, cue.startMs);
	onset.refAfter += rms(cue.startMs, cue.startMs + 300);
	onset.ctcBefore += rms(ctcStart - 300, ctcStart);
	onset.ctcAfter += rms(ctcStart, ctcStart + 300);
	if (index > 0) onset.refGapMs.push(cue.startMs - cues[index - 1]!.endMs);
}
const n = cues.length;
const gaps = onset.refGapMs.sort((a, b) => a - b);
console.log(JSON.stringify({
	refRmsBefore: (onset.refBefore / n).toFixed(4), refRmsAfter: (onset.refAfter / n).toFixed(4),
	ctcRmsBefore: (onset.ctcBefore / n).toFixed(4), ctcRmsAfter: (onset.ctcAfter / n).toFixed(4),
	refGapP10: gaps[Math.floor(gaps.length * 0.1)], refGapP50: gaps[Math.floor(gaps.length / 2)], refGapP90: gaps[Math.floor(gaps.length * 0.9)],
	firstCues: cues.slice(0, 4).map((c, i) => ({ ref: [c.startMs, c.endMs], ctc: [Math.round(c.startMs + startErrors[i]!), Math.round(c.endMs + endErrors[i]!)] })),
}));
// Lag between emission activity (1 - P(blank)) and the audio energy envelope.
{
	const blankCol = column.get(blank)!;
	const activity = frames.map((row) => 1 - Math.exp(row[blankCol]!));
	const envelope = frameTimeMs.map((ms) => rms(ms, ms + 20));
	const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
	const ma = mean(activity);
	const me = mean(envelope);
	let best = { lagFrames: 0, r: -1 };
	for (let lag = -150; lag <= 150; lag += 1) {
		let num = 0, da = 0, de = 0;
		for (let t = 0; t < T; t += 1) {
			const u = t + lag;
			if (u < 0 || u >= T) continue;
			const x = activity[u]! - ma, y = envelope[t]! - me;
			num += x * y; da += x * x; de += y * y;
		}
		const r = num / Math.sqrt(da * de);
		if (r > best.r) best = { lagFrames: lag, r };
	}
	console.log(JSON.stringify({ activityLagMs: best.lagFrames * 20, r: best.r.toFixed(3) }));
}
const stats = (values: number[]) => {
	const abs = values.map(Math.abs).sort((a, b) => a - b);
	const signed = [...values].sort((a, b) => a - b);
	const q = (arr: number[], p: number) => Math.round(arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]!);
	return { medianSigned: q(signed, 0.5), p50: q(abs, 0.5), p90: q(abs, 0.9), p99: q(abs, 0.99), within250: Number((abs.filter((v) => v <= 250).length / abs.length).toFixed(3)), within500: Number((abs.filter((v) => v <= 500).length / abs.length).toFixed(3)) };
};
const startOffset = Number(process.argv[8] ?? 0);
const endOffset = Number(process.argv[9] ?? 0);
for (let i = 0; i < startErrors.length; i += 1) {
	startErrors[i]! -= startOffset;
	endErrors[i]! -= endOffset;
}
console.log(JSON.stringify({ startOffset, endOffset, cues: cues.length, tokens: L, dropped, frames: T, emitMs: Math.round(emitMs), viterbiMs: Math.round(viterbiMs), cellsPerNs: Number(((T * S) / (viterbiMs * 1e6)).toFixed(3)), measured: startErrors.length, start: stats(startErrors), end: stats(endErrors) }));
