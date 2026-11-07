// Phase 0 throughput probe: run a CTC model over a raw 16 kHz mono f32 sample.
// Usage: bun throughput.ts <mms|qn> <model.onnx> <vocab> <threads> <chunkSec> <sample.f32> [maxSec] [batch]
import * as ort from "onnxruntime-node";
import { readFileSync, writeFileSync } from "node:fs";

const [kind, modelPath, vocabPath, threadsArg, chunkArg, samplePath, maxArg, batchArg] =
	process.argv.slice(2);
const batch = Math.max(1, Number(batchArg ?? 1));
const threads = Number(threadsArg);
const chunkSec = Number(chunkArg);
const SR = 16_000;

const raw = readFileSync(samplePath!);
let audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
if (maxArg && Number(maxArg) > 0) audio = audio.subarray(0, Number(maxArg) * SR);


let vocab: string[];
let blank: number;
if (kind === "mms") {
	const map = JSON.parse(readFileSync(vocabPath!, "utf8")) as Record<string, number>;
	vocab = [];
	for (const [token, id] of Object.entries(map)) vocab[id] = token;
	blank = 0;
} else {
	vocab = readFileSync(vocabPath!, "utf8").split("\n").map((line) => line.split(" ")[0] ?? "");
	blank = JSON.parse(readFileSync(vocabPath!.replace("vocab.txt", "config.json"), "utf8")).blank;
}

const loadStart = performance.now();
const session = await ort.InferenceSession.create(modelPath!, {
	intraOpNumThreads: threads,
	interOpNumThreads: 1,
	graphOptimizationLevel: "all",
});
const loadMs = performance.now() - loadStart;
const inputName = session.inputNames[0]!;
const outputName = session.outputNames[0]!;

function normalize(chunk: Float32Array): Float32Array {
	let mean = 0;
	for (const v of chunk) mean += v;
	mean /= chunk.length;
	let variance = 0;
	for (const v of chunk) variance += (v - mean) ** 2;
	const std = Math.sqrt(variance / chunk.length + 1e-7);
	return chunk.map((v) => (v - mean) / std);
}

const chunkSamples = Math.round(chunkSec * SR);
let frames = 0;
let classes = 0;
let decoded = "";
let previous = -1;
let peakRss = process.memoryUsage().rss;
const inferStart = performance.now();
const chunks: Float32Array[] = [];
for (let offset = 0; offset + chunkSamples <= audio.length; offset += chunkSamples) {
	chunks.push(audio.subarray(offset, offset + chunkSamples));
}
for (let first = 0; first < chunks.length; first += batch) {
	const group = chunks.slice(first, first + batch);
	const stacked = new Float32Array(group.length * chunkSamples);
	group.forEach((chunk, i) => stacked.set(kind === "mms" ? normalize(chunk) : chunk, i * chunkSamples));
	const input =
		kind === "mms"
			? new ort.Tensor("float32", stacked, [group.length, chunkSamples])
			: new ort.Tensor("float32", stacked, [group.length, 1, chunkSamples]);
	const output = (await session.run({ [inputName]: input }))[outputName]!;
	const [b, t, c] = output.dims as number[];
	const data = output.data as Float32Array;
	frames += b! * t!;
	classes = c!;
	for (let item = 0; item < b!; item += 1) {
		for (let f = 0; f < t!; f += 1) {
			const row = (item * t! + f) * c!;
			let best = 0;
			let bestScore = -Infinity;
			for (let k = 0; k < c!; k += 1) {
				const score = data[row + k]!;
				if (score > bestScore) {
					bestScore = score;
					best = k;
				}
			}
			if (best !== previous && best !== blank) decoded += vocab[best] ?? "?";
			previous = best;
		}
	}
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
}
const inferMs = performance.now() - inferStart;
const audioSec = (chunks.length * chunkSamples) / SR;

const result = {
	kind,
	model: modelPath,
	threads,
	chunkSec,
	batch,
	audioSec,
	loadMs: Math.round(loadMs),
	inferMs: Math.round(inferMs),
	xRT: Number((audioSec / (inferMs / 1000)).toFixed(1)),
	frameMs: Number(((audioSec * 1000) / frames).toFixed(2)),
	classes,
	peakRssMB: Math.round(peakRss / 2 ** 20),
	decodedChars: decoded.length,
	sample: decoded.slice(0, 240),
};
console.log(JSON.stringify(result));
writeFileSync(
	`${process.env.BENCH_OUT ?? "."}/${kind}-${modelPath!.split("/").pop()}-t${threads}-b${batch}-w${chunkSec}.txt`,
	decoded,
);
