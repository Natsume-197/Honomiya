// Greedy-decodes a time window of a honomiya.emissions.v1 file, for checking
// stitched emissions against window-text.ts.
// bun emissions-window.ts <emissions.bin> <startSec> <durationSec> <out.txt>
import { readFileSync, writeFileSync } from "node:fs";
import { decodeEmissions, frameDurationMs, greedyDecode } from "../../src/ctc/emissions";

const [path, startArg, durationArg, outPath] = process.argv.slice(2);
const emissions = decodeEmissions(new Uint8Array(readFileSync(path!)));
const frameMs = frameDurationMs(emissions.header);
const first = Math.floor((Number(startArg) * 1000) / frameMs) - emissions.header.startFrame;
const end = first + Math.floor((Number(durationArg) * 1000) / frameMs);
const { text, frames } = greedyDecode(emissions);
const kept = Array.from(text).filter((_, index) => {
	const frame = frames[index] ?? -1;
	return frame >= first && frame < end;
});
writeFileSync(outPath!, kept.join(""));
console.log(
	JSON.stringify({
		model: emissions.header.model,
		frames: emissions.header.frames,
		hours: Number(((emissions.header.frames * frameMs) / 3.6e6).toFixed(2)),
		topK: emissions.header.topK,
		windowChars: kept.length,
		sample: kept.slice(0, 60).join(""),
	}),
);
